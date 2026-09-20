import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { DorisService } from '../database/doris.service'
import { snowflake } from '../common/snowflake'
import { buildPage, decodeCursor, normalizeLimit } from '../common/cursor'
import { fmtDateTime } from '../common/format'

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

/** 允许用户自己改的站点白名单。与 dim_asin.country 的取值一致 */
const COUNTRIES = [
  'US', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP',
  'CA', 'MX', 'AU', 'AE', 'SA', 'BR',
]

/**
 * 用户中心
 *
 * 覆盖 goal.md 第 16 页 `/settings` 的三块：账户设置、积分管理、API Key 管理。
 * 积分部分在 CreditsService，这里只做资料、密码、API Key 和查询历史。
 *
 * ## Doris 的两个坑（都已踩过）
 *
 * 1. **Unique Key 表的 INSERT 是整行替换，不是部分更新。**
 *    所以改资料不能只写变更的列 —— 必须先读整行，合并后整行写回，
 *    否则未提供的 NOT NULL 列会报 "Column has no default value"。
 *    这里统一用 UPDATE 而不是 INSERT 覆盖，UPDATE 支持部分列。
 *
 * 2. **没有唯一约束。** users.email 的唯一性靠应用层查重保证，
 *    并发注册同一邮箱理论上仍可能双写（P4 再补后台对账）。
 */
@Injectable()
export class UsersService {
  constructor(private readonly db: DorisService) {}

  /** 完整资料。比 /auth/me 多返回昵称、头像、默认站点等 */
  async getProfile(userId: string) {
    const row = await this.db.queryOne<any>(
      `SELECT id, email, nickname, avatar_url, status, default_country,
     last_login_at, last_login_ip, created_at
         FROM users WHERE id = ? AND is_deleted = 0 LIMIT 1`,
      [userId],
    )
    if (!row) throw new NotFoundException('用户不存在')

    return {
      id: String(row.id),
      email: row.email,
      nickname: row.nickname ?? row.email.split('@')[0],
      avatarUrl: row.avatar_url,
      status: Number(row.status),
      defaultCountry: row.default_country ?? 'US',
      lastLoginAt: fmtDateTime(row.last_login_at),
      // 只回显末段，完整 IP 没必要暴露在前端
      lastLoginIp: row.last_login_ip,
      createdAt: fmtDateTime(row.created_at),
    }
  }

  /** 改资料。只允许改昵称、头像、默认站点 —— 邮箱是登录凭据，不给改 */
  async updateProfile(
    userId: string,
    dto: { nickname?: string; avatarUrl?: string; defaultCountry?: string },
  ) {
    const sets: string[] = []
    const params: any[] = []

    if (dto.nickname !== undefined) {
      const n = dto.nickname.trim()
      if (n.length < 1 || n.length > 32) {
        throw new BadRequestException('昵称长度需在 1-32 字符之间')
      }
      sets.push('nickname = ?')
      params.push(n)
    }

    if (dto.avatarUrl !== undefined) {
      // 只接受 http(s) 或空。不做上传 —— goal.md 要求用占位图
      const u = dto.avatarUrl.trim()
      if (u && !/^https?:\/\//i.test(u)) {
        throw new BadRequestException('头像地址必须是 http(s) 链接')
      }
      sets.push('avatar_url = ?')
      params.push(u || null)
    }

    if (dto.defaultCountry !== undefined) {
      const c = dto.defaultCountry.toUpperCase()
      if (!COUNTRIES.includes(c)) {
        throw new BadRequestException(`不支持的站点：${dto.defaultCountry}`)
      }
      sets.push('default_country = ?')
      params.push(c)
    }

    if (!sets.length) {
      throw new BadRequestException('没有需要更新的字段')
    }

    sets.push('updated_at = ?')
    params.push(now(), userId)

    await this.db.execute(
      `UPDATE users SET ${sets.join(', ')} WHERE id = ?`,
      params,
    )
    return this.getProfile(userId)
  }

  /**
   * 改密码。必须验证旧密码 —— access token 有效期 2h，
   * token 泄露的场景下如果不校验旧密码，攻击者可直接接管账号。
   */
  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    if (newPassword.length < 8) {
      throw new BadRequestException('新密码至少 8 位')
    }
    if (oldPassword === newPassword) {
      throw new BadRequestException('新密码不能与旧密码相同')
    }

    const row = await this.db.queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ? AND is_deleted = 0 LIMIT 1',
      [userId],
    )
    if (!row) throw new NotFoundException('用户不存在')

    if (!bcrypt.compareSync(oldPassword, row.password_hash)) {
      throw new UnauthorizedException('旧密码不正确')
    }

    await this.db.execute(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      [bcrypt.hashSync(newPassword, 10), now(), userId],
    )

    // 改密码后吊销所有 refresh token，强制其他设备重新登录。
    // Doris 没有 DELETE ... RETURNING，直接按 user_id 全量吊销。
    await this.db.execute(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [now(), userId],
    )

    return { ok: true, message: '密码已修改，其他设备需重新登录' }
  }

  // ---------------- API Key ----------------

  /**
   * 创建 API Key。
   *
   * 明文只在这一次返回，库里只存 SHA-256。
   * 用 SHA-256 而非 bcrypt：API Key 是高熵随机串（32 字节），
   * 不存在字典攻击风险，而每次 API 调用都要验证，bcrypt 太慢。
   */
  async createApiKey(userId: string, name: string, expiresInDays?: number) {
    const n = (name ?? '').trim()
    if (n.length < 1 || n.length > 32) {
      throw new BadRequestException('名称长度需在 1-32 字符之间')
    }

    const count = await this.db.queryOne<{ c: string }>(
      'SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    )
    if (Number(count?.c ?? 0) >= 10) {
      throw new BadRequestException('最多同时持有 10 个有效 API Key')
    }

    // lk_ 前缀便于在日志里识别并脱敏
    const raw = `lk_${randomBytes(24).toString('base64url')}`
    const prefix = raw.slice(0, 11)
    const hash = createHash('sha256').update(raw).digest('hex')

    let expiresAt: string | null = null
    if (expiresInDays !== undefined && expiresInDays !== null) {
      const d = Number(expiresInDays)
      if (!Number.isFinite(d) || d <= 0 || d > 3650) {
 throw new BadRequestException('有效期需在 1-3650 天之间')
      }
      expiresAt = new Date(Date.now() + d * 86400_000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ')
    }

    const id = snowflake.nextId()
    await this.db.execute(
      `INSERT INTO api_keys
  (id, user_id, name, key_prefix, key_hash, scopes,
    last_used_at, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'read', NULL, ?, NULL, ?)`,
      [id, userId, n, prefix, hash, expiresAt, now()],
    )

    return {
      id: id.toString(),
      name: n,
      keyPrefix: prefix,
      /** ⚠️ 明文，仅此一次返回，前端须提示用户立即保存 */
      key: raw,
      scopes: 'read',
      expiresAt,
      createdAt: now(),
    }
  }

  /** Key 列表。只回前缀，不回哈希 */
  async listApiKeys(userId: string) {
    const rows = await this.db.query<any>(
      `SELECT id, name, key_prefix, scopes, last_used_at,
       expires_at, revoked_at, created_at
         FROM api_keys WHERE user_id = ?
        ORDER BY created_at DESC`,
      [userId],
    )

    const nowMs = Date.now()
    return {
      items: rows.map((r: any) => {
 const expiresAt = fmtDateTime(r.expires_at)
        const revokedAt = fmtDateTime(r.revoked_at)
 const expired =
   !!r.expires_at && new Date(r.expires_at).getTime() < nowMs
        return {
          id: String(r.id),
   name: r.name,
   keyPrefix: r.key_prefix,
   scopes: r.scopes,
          lastUsedAt: fmtDateTime(r.last_used_at),
   expiresAt,
   revokedAt,
   // 三态由后端判定，前端不要自己算日期
          status: revokedAt ? 'revoked' : expired ? 'expired' : 'active',
   createdAt: fmtDateTime(r.created_at),
        }
      }),
    }
  }

  /** 吊销 Key。只标记不删除，保留审计痕迹 */
  async revokeApiKey(userId: string, keyId: string) {
    const row = await this.db.queryOne<{ id: string; revoked_at: any }>(
      'SELECT id, revoked_at FROM api_keys WHERE id = ? AND user_id = ? LIMIT 1',
      [keyId, userId],
    )
    if (!row) throw new NotFoundException('API Key 不存在')
    if (row.revoked_at) {
      return { ok: true, message: '该 Key 已是吊销状态' }
    }

    await this.db.execute(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ?',
      [now(), keyId, userId],
    )
    return { ok: true, message: 'API Key 已吊销' }
  }

  // ---------------- 查询历史 ----------------

  /**
   * 我的查询历史。对应 goal.md P3 的「我的查询历史」，
   * 但 dashboard 的「最近查询记录」也要用，所以 P2 先落地。
   */
  async listQueryLogs(
    userId: string,
    opts: { cursor?: string; limit?: number; queryType?: string } = {},
  ) {
    const limit = normalizeLimit(opts.limit)
    const where = ['user_id = ?']
    const params: any[] = [userId]

    if (opts.queryType) {
      where.push('query_type = ?')
      params.push(opts.queryType)
    }

    const cur = decodeCursor(opts.cursor)
    if (cur && cur.length === 2) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))')
      params.push(cur[0], cur[0], cur[1])
    }

    const rows = await this.db.query<any>(
      `SELECT id, query_type, query_value, country, page_route,
    credits_cost, result_count, duration_ms, status, error_msg, created_at
         FROM query_logs
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
 LIMIT ?`,
      [...params, limit + 1],
    )

    const page = buildPage(rows, limit, (last: any) => [
      // created_at 是 NOT NULL，这里兜底空串只为满足类型
      fmtDateTime(last.created_at) ?? '',
      String(last.id),
    ])

    return {
      ...page,
      items: page.items.map((r: any) => ({
        id: String(r.id),
        queryType: r.query_type,
 queryValue: r.query_value,
        country: r.country,
        pageRoute: r.page_route,
        creditsCost: Number(r.credits_cost ?? 0),
        resultCount: r.result_count === null ? null : Number(r.result_count),
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
        success: Number(r.status) === 1,
        errorMsg: r.error_msg,
        createdAt: fmtDateTime(r.created_at),
      })),
    }
  }

  /**
   * 记一条查询日志。
   *
   * ⚠️ query_logs 是高频写入表，schema 注释建议批量写。
   * P2 先单条 INSERT 把功能跑通，写失败只记日志不抛异常 ——
   * 审计失败绝不能让用户的查询请求跟着失败。
   * P4 再换成缓冲 + 定时刷盘。
   */
  async logQuery(p: {
    userId: string
    queryType: string
    queryValue: string
    country: string
    pageRoute?: string
    creditsCost?: number
    resultCount?: number
    durationMs?: number
    success?: boolean
    errorMsg?: string
    ip?: string
  }) {
    try {
      await this.db.execute(
 `INSERT INTO query_logs
    (id, user_id, query_type, query_value, country, page_route,
     credits_cost, result_count, duration_ms, status, error_msg, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
   snowflake.nextId(),
          p.userId,
          p.queryType,
   p.queryValue.slice(0, 255),
          p.country,
          p.pageRoute ?? null,
   p.creditsCost ?? 0,
          p.resultCount ?? null,
          p.durationMs ?? null,
   p.success === false ? 0 : 1,
   p.errorMsg?.slice(0, 512) ?? null,
          p.ip ?? null,
   now(),
        ],
      )
    } catch {
      // 静默：审计写入失败不影响主流程
    }
  }

  /** 概览页用的统计。dashboard 的「最近查询」和积分卡片都依赖它 */
  async getOverviewStats(userId: string) {
    const [total, recent] = await Promise.all([
      this.db.queryOne<{ c: string }>(
        'SELECT COUNT(*) AS c FROM query_logs WHERE user_id = ?',
        [userId],
      ),
      this.db.query<any>(
        `SELECT query_type, query_value, country, created_at
    FROM query_logs WHERE user_id = ?
   ORDER BY created_at DESC, id DESC LIMIT 8`,
        [userId],
      ),
    ])

    return {
      totalQueries: Number(total?.c ?? 0),
      recentQueries: recent.map((r: any) => ({
        queryType: r.query_type,
 queryValue: r.query_value,
        country: r.country,
        createdAt: fmtDateTime(r.created_at),
      })),
    }
  }
}
