import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { DorisService } from '../database/doris.service'
import { snowflake } from '../common/snowflake'
import { LoginDto, RegisterDto } from './dto/auth.dto'

/** 写库用的时间格式。Doris DATETIME 不接受 ISO 8601 的 T 和 Z */
function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly db: DorisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 注册
   *
   * ⚠️ Doris 没有唯一约束（Unique Key 是合并语义，不是约束），
   * 邮箱唯一性只能靠应用层「先查后插」。
   * 并发注册同一邮箱有极小概率重复 —— 生产环境应加分布式锁或后置去重任务。
   * 这里先按单实例开发环境处理，并在此注明。
   */
  async register(dto: RegisterDto) {
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email = ? AND is_deleted = 0 LIMIT 1',
      [dto.email],
    )
    if (existing) {
  throw new BadRequestException('该邮箱已被注册')
    }

    const id = snowflake.nextId()
    const passwordHash = await bcrypt.hash(dto.password, 10)
    const ts = now()

    await this.db.execute(
      `INSERT INTO users
    (id, email, password_hash, nickname, avatar_url, status,
        default_country, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'US', 0, ?, ?)`,
      [
        id,
        dto.email,
        passwordHash,
        dto.nickname,
 // 占位头像，不使用原站素材
   `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(dto.nickname)}`,
        ts,
        ts,
      ],
    )

    // 开通积分账户。
    // ⚠️ 非原子：Doris 无跨表事务，users 与 credit_accounts 是两次独立写入。
    // 若此处失败，用户已创建但无积分账户 —— 由下面的补偿逻辑兜底。
    try {
      await this.db.execute(
   `INSERT INTO credit_accounts
      (user_id, balance, total_recharged, total_consumed, frozen,
   channel, version, updated_at)
      VALUES (?, 0, 0, 0, 0, 'personal', 0, ?)`,
        [id, ts],
      )
    } catch (err: any) {
      this.logger.warn(
`用户 ${id} 的积分账户创建失败，将在首次查询积分时补建：${err?.message}`,
      )
    }

    return this.issueTokens(id.toString(), dto.email)
  }

  async login(
    dto: LoginDto,
    meta: { ip?: string; ua?: string } = {},
  ) {
    const user = await this.db.queryOne<{
      id: string
      email: string
      password_hash: string
      status: number
    }>(
'SELECT id, email, password_hash, status FROM users WHERE email = ? AND is_deleted = 0 LIMIT 1',
      [dto.email],
    )

    // 邮箱不存在与密码错误返回同一句提示，避免暴露哪些邮箱已注册
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误')
    }
    const ok = await bcrypt.compare(dto.password, user.password_hash)
    if (!ok) {
      throw new UnauthorizedException('邮箱或密码错误')
    }
    if (user.status === 2) {
      throw new UnauthorizedException('账号已被封禁')
    }
    if (user.status === 0) {
      throw new UnauthorizedException('账号已停用')
    }

    // 更新最后登录信息。
    // ⚠️ Doris 关键差异：Unique Key 模型下 INSERT 同主键即覆盖（upsert），
    // 但**必须写全所有 NOT NULL 且无默认值的列**，否则报
    // 「Column has no default value」。不能像 MySQL 的 UPDATE 只写变更字段。
    // 所以这里先读整行，再整行写回。
    await this.touchLastLogin(user.id, meta.ip)

    return this.issueTokens(user.id.toString(), user.email, meta)
  }

  /**
   * 刷新 access token
   *
   * 说明：原站**没有** refresh token 机制（实测是单 token + 401 直接登出），
   * 这是 goal.md 要求的新增设计。
   */
  async refresh(refreshToken: string) {
    const tokenHash = sha256(refreshToken)
    // created_at / token_hash 一并取出：下面轮换旧 token 时要整行覆盖写回
    const row = await this.db.queryOne<{
      id: string
      user_id: string
      token_hash: string
      expires_at: string
      revoked_at: string | null
      created_at: string
    }>(
      `SELECT id, user_id, token_hash, expires_at, revoked_at, created_at
         FROM refresh_tokens WHERE token_hash = ? LIMIT 1`,
      [tokenHash],
    )

    if (!row || row.revoked_at) {
      throw new UnauthorizedException('refresh token 无效或已吊销')
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new UnauthorizedException('refresh token 已过期，请重新登录')
    }

    const user = await this.db.queryOne<{ email: string; status: number }>(
      'SELECT email, status FROM users WHERE id = ? AND is_deleted = 0 LIMIT 1',
      [row.user_id],
    )
    if (!user || user.status !== 1) {
      throw new UnauthorizedException('用户不存在或已停用')
    }

    /**
     * Token 轮换：签发新 token 前先吊销刚用过的这个。
     *
     * 不吊销的话旧 refresh token 在 30 天有效期内一直能用，
     * 一旦泄露，攻击者可以和用户并行地无限续期，改密码也踢不掉他
     * （改密码只吊销当前库里的行，而他每次 refresh 又会拿到新行）。
     *
     * ⚠️ Doris 无事务：吊销与签发是两次独立写入。这里选择「先吊销、后签发」，
     * 万一签发失败，用户只是需要重新登录（安全侧失败），
     * 反过来则会留下一个永不失效的旧 token（危险侧失败）。
     */
    await this.db.execute(
      `INSERT INTO refresh_tokens
         (id, user_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.token_hash, row.expires_at, now(), row.created_at],
    )

    return this.issueTokens(row.user_id.toString(), user.email)
  }

  /** 登出：吊销该 refresh token */
  async logout(refreshToken: string) {
    const tokenHash = sha256(refreshToken)
    const row = await this.db.queryOne<{
      id: string
      user_id: string
      token_hash: string
      expires_at: string
      created_at: string
    }>(
      `SELECT id, user_id, token_hash, expires_at, created_at
   FROM refresh_tokens WHERE token_hash = ? LIMIT 1`,
      [tokenHash],
    )
    if (!row) return { ok: true }

    // Doris Unique Key 模型：同主键 INSERT 即覆盖，用这个方式实现 UPDATE
    await this.db.execute(
      `INSERT INTO refresh_tokens
  (id, user_id, token_hash, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.token_hash, row.expires_at, now(), row.created_at],
    )
    return { ok: true }
  }

  /** 签发 access + refresh 双 token */
  private async issueTokens(
    userId: string,
    email: string,
    meta: { ip?: string; ua?: string } = {},
  ) {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      {
        secret: this.config.get<string>('JWT_SECRET'),
        expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES', '2h'),
      },
    )

    const refreshToken = randomBytes(48).toString('hex')
    const days = this.parseDays(this.config.get<string>('JWT_REFRESH_EXPIRES', '30d'))
    const expiresAt = new Date(Date.now() + days * 86400_000)

    await this.db.execute(
      `INSERT INTO refresh_tokens
   (id, user_id, token_hash, expires_at, user_agent, ip, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
 snowflake.nextId(),
 userId,
        sha256(refreshToken),
 expiresAt.toISOString().slice(0, 19).replace('T', ' '),
        meta.ua?.slice(0, 500) ?? null,
 meta.ip ?? null,
        now(),
      ],
    )

    return {
      accessToken,
      refreshToken,
      // userId 转 string：JS number 精度只有 53 位，BIGINT 直接传数字会丢精度
      user: { id: userId, email },
    }
  }

  /**
   * 整行写回 users，只改登录相关字段。
   *
   * 为什么要读整行：见 login() 里的说明 —— Doris 的 upsert 是整行替换语义，
   * 缺列会报错而不是保留原值。
   */
  private async touchLastLogin(userId: string, ip?: string) {
    const row = await this.db.queryOne<Record<string, any>>(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [userId],
    )
    if (!row) return

    const ts = now()
    await this.db.execute(
      `INSERT INTO users
         (id, email, password_hash, nickname, avatar_url, status,
          default_country, last_login_at, last_login_ip,
          is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
 row.email,
        row.password_hash,
        row.nickname,
 row.avatar_url,
        row.status,
        row.default_country,
 ts,
        ip ?? row.last_login_ip ?? null,
        row.is_deleted ?? 0,
 // created_at 必须原样带回，它是 NOT NULL 且无默认值
 this.toDbTime(row.created_at),
        ts,
      ],
    )
  }

  /** mysql2 取回的 DATETIME 是 JS Date，写回前要转成 Doris 接受的字符串格式 */
  private toDbTime(v: any): string {
    if (!v) return now()
    if (v instanceof Date) {
      return v.toISOString().slice(0, 19).replace('T', ' ')
    }
    return String(v).slice(0, 19).replace('T', ' ')
  }

  private parseDays(v: string): number {
    const m = /^(\d+)d$/.exec(v)
    return m ? Number(m[1]) : 30
  }
}
