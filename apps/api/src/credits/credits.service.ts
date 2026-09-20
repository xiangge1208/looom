import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { DorisService } from '../database/doris.service'
import { snowflake } from '../common/snowflake'
import { buildPage, decodeCursor, normalizeLimit } from '../common/cursor'
import { fmtDateTime } from '../common/format'

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

/** 积分变动类型。与 credit_transactions.type 的注释一致 */
export type CreditTxType = 'recharge' | 'consume' | 'refund' | 'gift' | 'expire'

export interface SpendResult {
  ok: boolean
  /** 扣费后余额。ok=false 时是当前真实余额 */
  balance: number
  /** 实际扣减数量。计价为 0 时是 0（免费功能） */
  cost: number
  /** 流水 ID，免费或失败时为 null */
  txId: string | null
  reason?: 'insufficient' | 'conflict'
}

/**
 * 积分账户与流水
 *
 * ## 为什么余额以流水为准，而不是直接改 credit_accounts.balance
 *
 * 建表时的注释写的是「余额权威值在 Redis，本表为快照」。
 * P2 落地前我在真实 Doris 上做了并发实测，结论比预想的更严格：
 *
 * **Doris 的 UPDATE 无法实现 CAS，并发下会静默丢失更新。**
 *
 * 实测数据（20 并发、每次扣 5、初始余额 50）：
 *   UPDATE ... SET balance = balance - 5, version = version + 1
 *    WHERE user_id = ? AND version = ? AND balance >= 5
 *   → 20 个请求**全部**返回 affectedRows = 1
 *   → 但最终余额只减了 5（version 只加到 1）
 *
 * 去掉 version 条件、改用自减也一样：
 *   10 并发自减 → 只有 2 次真正生效（余额 50 → 40）
 *   同样 10 次改为串行 → 正确扣到 0
 *
 * 也就是说 affectedRows=1 只代表「在读快照里匹配到了行」，
 * 不代表写入被串行化。Doris 是 OLAP 引擎，不提供行级锁，
 * 所以任何「读-改-写」模式在并发下都不可靠。
 *
 * ## 因此改成这套方案
 *
 * 1. **credit_transactions 是唯一权威**。它是 append-only，
 *    实测 10 个并发 INSERT（不同主键）零丢失。
 * 2. **余额 = SUM(amount)**。扣费记负数、入账记正数，聚合即余额。
 * 3. credit_accounts.balance 退化为**展示用缓存**，
 *    每次变动后按流水重算写回，不参与扣费判断。
 *    即使这次写回丢了，下一次也会自动纠正，不会积累误差。
 * 4. 扣费用「先写流水、再校验」的乐观模式：
 *    写入扣费流水 → 重新聚合 → 若余额为负说明并发超扣，
 *    立刻写一条补偿流水回滚，并返回失败。
 *
 * 这样做的代价是「瞬时可能透支再回滚」，换来的是**账目永远自洽**：
 * 流水是完整的审计链，余额永远等于流水之和。
 * 对一个分析工具的虚拟积分来说，这个取舍是合适的；
 * 如果将来要接真实支付，应当把余额迁到支持事务的存储。
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name)

  constructor(private readonly db: DorisService) {}

  /**
   * 按流水聚合出真实余额。这是余额的唯一权威来源。
   *
   * 没有流水的新用户返回 0，不报错 —— 开户是惰性的。
   */
  private async computeBalance(userId: string): Promise<number> {
    const row = await this.db.queryOne<{ net: string }>(
      'SELECT COALESCE(SUM(amount), 0) AS net FROM credit_transactions WHERE user_id = ?',
      [userId],
    )
    return Number(row?.net ?? 0)
  }

  /**
   * 「前缀余额」：只统计 id <= txId 的有效流水。
   *
   * 用于并发扣费判定 —— 见 spend() 的说明。
   * 反连接排除已被 concurrent_rollback 抵消的扣费流水，
   * 同时也排除回滚流水本身，避免重复计算。
   *
   * biz_id 存的是 VARCHAR，t.id 是 BIGINT，必须 CAST 才能连上。
   */
  private async computePrefixBalance(
    userId: string,
    txId: string,
  ): Promise<number> {
    const row = await this.db.queryOne<{ net: string }>(
      `SELECT COALESCE(SUM(t.amount), 0) AS net
         FROM credit_transactions t
  LEFT JOIN credit_transactions r
  ON r.user_id = t.user_id
 AND r.biz_type = 'concurrent_rollback'
        AND r.biz_id = CAST(t.id AS CHAR)
 WHERE t.user_id = ?
   AND t.id <= ?
   AND (t.biz_type IS NULL OR t.biz_type <> 'concurrent_rollback')
          AND r.id IS NULL`,
      [userId, txId],
    )
    return Number(row?.net ?? 0)
  }

  /**
   * 把算出来的余额写回 credit_accounts 做展示缓存。
   *
   * 这一步失败不影响正确性（下次变动会自动纠正），所以不抛异常。
 * total_consumed / total_recharged 同样按流水重算，避免累加漂移。
   */
  private async syncAccountCache(userId: string, balance: number) {
    try {
      const agg = await this.db.queryOne<any>(
        `SELECT
     COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS consumed,
     COALESCE(SUM(CASE WHEN type IN ('recharge', 'gift') THEN amount ELSE 0 END), 0) AS recharged
    FROM credit_transactions WHERE user_id = ?`,
        [userId],
      )
      await this.db.execute(
        `UPDATE credit_accounts
  SET balance = ?, total_consumed = ?, total_recharged = ?,
                version = version + 1, updated_at = ?
     WHERE user_id = ?`,
        [
  balance,
        Number(agg?.consumed ?? 0),
          Number(agg?.recharged ?? 0),
          now(),
          userId,
   ],
      )
    } catch (err: any) {
      this.logger.warn(
        `余额缓存写回失败（不影响正确性，下次变动会纠正）：user=${userId} err=${err?.message}`,
      )
    }
  }

  /** 确保账户行存在。余额字段由 syncAccountCache 维护，这里只建壳 */
  private async ensureAccount(userId: string) {
    const row = await this.db.queryOne<any>(
      'SELECT user_id FROM credit_accounts WHERE user_id = ? LIMIT 1',
      [userId],
    )
    if (row) return
    await this.db.execute(
      `INSERT INTO credit_accounts
    (user_id, balance, total_recharged, total_consumed, frozen,
   channel, integral_limit, version, updated_at)
       VALUES (?, 0, 0, 0, 0, 'personal', NULL, 0, ?)`,
      [userId, now()],
    )
  }

  /**
   * 读账户。
   *
   * balance 现算（SUM 流水），不直接信 credit_accounts.balance ——
   * 那一列只是缓存，并发下可能短暂落后。
   */
  async getAccount(userId: string) {
    await this.ensureAccount(userId)

    const row = await this.db.queryOne<any>(
      `SELECT user_id, total_recharged, total_consumed, frozen,
     channel, integral_limit, version, updated_at
         FROM credit_accounts WHERE user_id = ? LIMIT 1`,
      [userId],
    )
    const balance = await this.computeBalance(userId)

    return {
      userId: String(row?.user_id ?? userId),
      balance,
      totalRecharged: Number(row?.total_recharged ?? 0),
 totalConsumed: Number(row?.total_consumed ?? 0),
      frozen: Number(row?.frozen ?? 0),
      channel: row?.channel ?? 'personal',
      integralLimit:
      row?.integral_limit === null || row?.integral_limit === undefined
          ? null
       : Number(row.integral_limit),
      version: Number(row?.version ?? 0),
      updatedAt: row?.updated_at ? this.fmtTs(row.updated_at) : null,
    }
  }

  /** 读某个功能的计价。配置缺失按 0 处理（宁可免费，也不要意外扣费） */
  async getCost(bizType: string): Promise<number> {
    const row = await this.db.queryOne<{ config_value: string }>(
      'SELECT config_value FROM system_configs WHERE config_key = ? LIMIT 1',
      [`credit.cost.${bizType}`],
    )
    const n = Number(row?.config_value ?? 0)
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  /**
   * 扣费。
   *
   * ## 为什么要按「雪花 ID 前缀」判定，而不是看余额是否为负
   *
   * 最初的实现是：写完流水后聚合余额，若为负就回滚。
   * 实测 20 并发、初始 50、每次扣 5 时**全部 20 个请求都回滚了**，
   * 而正确结果应是 10 成功 10 失败。
   *
   * 原因：20 条扣费流水几乎同时落库，每个请求再去聚合时
   * 都看到了另外 19 条的扣减，于是都算出负余额、都认为自己超扣。
   * 这是典型的「惊群误判」—— 没有超扣，但都以为自己超扣。
   *
   * 修正思路：给并发请求一个**确定的先后顺序**，
   * 每个请求只对「排在它之前的扣费」负责：
   *
   *   有效余额 = SUM(amount) WHERE id <= 我自己的 id
   *
   * 雪花 ID 单调递增，天然提供全局顺序。于是 20 个并发里
   * 前 10 个（id 较小）算出的前缀余额 >= 0 → 成功，
   * 后 10 个前缀余额 < 0 → 回滚。结果是确定的，与到达顺序无关。
   *
   * 聚合时要排除掉**已被回滚的扣费**（用 LEFT JOIN 反连接），
   * 否则被回滚的负数流水会让后续请求低估可用余额，产生连锁误判。
   *
   * 回滚补偿流水用 biz_type='concurrent_rollback' 标记，
   * 对账时能与正常退款区分开。
   */
  async spend(
    userId: string,
    bizType: string,
    opts: { bizId?: string; remark?: string; cost?: number } = {},
  ): Promise<SpendResult> {
    const cost = opts.cost ?? (await this.getCost(bizType))

    // 免费功能：不碰账户，也不写流水，避免流水表被 0 值淹没
    if (cost <= 0) {
      const balance = await this.computeBalance(userId)
      return { ok: true, balance, cost: 0, txId: null }
    }

    await this.ensureAccount(userId)

    // ---- 1. 预检 ----
    const before = await this.computeBalance(userId)
    if (before < cost) {
      return { ok: false, balance: before, cost, txId: null, reason: 'insufficient' }
    }

    // ---- 2. 写扣费流水 ----
    const txId = snowflake.nextId()
    await this.db.execute(
      `INSERT INTO credit_transactions
         (id, user_id, type, amount, balance_after, biz_type, biz_id, remark, created_at)
       VALUES (?, ?, 'consume', ?, ?, ?, ?, ?, ?)`,
      [
        txId,
   userId,
    // 消耗记负数，这样 SUM(amount) 直接就是余额
        -cost,
  // 乐观值。并发下可能不准，仅作参考；权威值永远是 SUM
        Number((before - cost).toFixed(4)),
        bizType,
        opts.bizId ?? null,
        (opts.remark ?? `${bizType} 消耗 ${cost} 积分`).slice(0, 255),
        now(),
      ],
    )

    // ---- 3. 按前缀余额校验是否轮到我 ----
    // 只统计 id <= 本次流水 id 的有效流水，得到确定性的判定结果
    const prefix = await this.computePrefixBalance(userId, txId.toString())
    if (prefix < 0) {
      // ---- 4. 超扣：写补偿流水回滚本次扣费 ----
this.logger.warn(
 `并发超扣，回滚本次扣费：user=${userId} cost=${cost} 前缀余额=${prefix}`,
      )
      await this.db.execute(
        `INSERT INTO credit_transactions
           (id, user_id, type, amount, balance_after, biz_type, biz_id, remark, created_at)
         VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)`,
   [
          snowflake.nextId(),
        userId,
       cost,
          Number((prefix + cost).toFixed(4)),
      'concurrent_rollback',
 txId.toString(),
       '并发超扣自动回滚',
          now(),
  ],
      )
      const restored = await this.computeBalance(userId)
      await this.syncAccountCache(userId, restored)
      return {
      ok: false,
        balance: restored,
        cost,
        txId: null,
        reason: 'conflict',
      }
    }

    const after = await this.computeBalance(userId)
    await this.syncAccountCache(userId, after)
    return { ok: true, balance: after, cost, txId: txId.toString() }
  }

  /**
   * 退款 / 充值 / 赠送。
   *
 * 加法没有「余额不足」问题，所以不需要补偿逻辑，直接写流水即可。
   * 退款用 bizId 做幂等检查，避免同一个失败任务被退两次。
   */
  async grant(
    userId: string,
    type: Extract<CreditTxType, 'recharge' | 'refund' | 'gift'>,
    amount: number,
    opts: { bizType?: string; bizId?: string; remark?: string } = {},
  ): Promise<SpendResult> {
    if (!(amount > 0)) {
      throw new BadRequestException('积分变动值必须为正数')
    }

    await this.ensureAccount(userId)

    // 幂等：同一 bizId + 同一类型只入账一次。
    // ⚠️ 这不是强保证 —— Doris 没有唯一约束，两个并发退款仍可能都查不到对方。
    // 实际场景里退款由失败任务触发，不会高并发，够用。
    if (opts.bizId) {
 const dup = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM credit_transactions
          WHERE user_id = ? AND type = ? AND biz_id = ? LIMIT 1`,
        [userId, type, opts.bizId],
      )
      if (dup) {
        this.logger.warn(
          `重复入账被拦截：user=${userId} type=${type} bizId=${opts.bizId}`,
   )
        return {
          ok: true,
   balance: await this.computeBalance(userId),
          cost: 0,
          txId: String(dup.id),
 }
      }
    }

    const before = await this.computeBalance(userId)
    const txId = snowflake.nextId()
    await this.db.execute(
      `INSERT INTO credit_transactions
       (id, user_id, type, amount, balance_after, biz_type, biz_id, remark, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
  txId,
   userId,
        type,
        amount,
        Number((before + amount).toFixed(4)),
        opts.bizType ?? null,
opts.bizId ?? null,
    (opts.remark ?? `${type} ${amount} 积分`).slice(0, 255),
 now(),
      ],
    )

    const after = await this.computeBalance(userId)
    await this.syncAccountCache(userId, after)
    return { ok: true, balance: after, cost: amount, txId: txId.toString() }
  }

  /** 流水分页。游标按 (created_at, id) 降序，避免同一毫秒多条时漏记录 */
  async listTransactions(
    userId: string,
    opts: { cursor?: string; limit?: number; type?: string } = {},
  ) {
 const limit = normalizeLimit(opts.limit)
    const where = ['user_id = ?']
    const params: any[] = [userId]

    if (opts.type) {
      where.push('type = ?')
      params.push(opts.type)
 }

    const cur = decodeCursor(opts.cursor)
    if (cur && cur.length === 2) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))')
      params.push(cur[0], cur[0], cur[1])
    }

  const rows = await this.db.query<any>(
      `SELECT id, type, amount, balance_after, biz_type, biz_id, remark, created_at
         FROM credit_transactions
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [...params, limit + 1],
    )

    const page = buildPage(rows, limit, (last: any) => [
  this.fmtTs(last.created_at),
      String(last.id),
    ])

    return {
      ...page,
      items: page.items.map((r: any) => ({
  id: String(r.id),
        type: r.type,
        amount: Number(r.amount),
        balanceAfter: Number(r.balance_after),
        bizType: r.biz_type,
        bizId: r.biz_id,
        remark: r.remark,
        createdAt: this.fmtTs(r.created_at),
  })),
    }
  }

  /**
 * DATETIME 归一成 'YYYY-MM-DD HH:mm:ss'。
   *
   * ⚠️ 必须走 common/format 的 fmtDateTime（UTC），不要自己实现。
   * 这里原先手写了一版用 getFullYear/getHours 的**本地时区**实现，
   * 与 format.ts 写明的「写入用 UTC，读出也按 UTC 解读」约定相反，
   * 实测在 Asia/Shanghai 下整体偏移 8 小时。
   *
   * 危害不只是显示错：这个值还被编进流水游标做 `created_at < ?` 比较
   * （见 listTransactions），偏移会导致翻页漏行或重复。
   *
   * 返回空串而不是 null 只是为了满足游标的 (string | number)[] 类型；
   * created_at 是 NOT NULL，实际不会走到兜底。
   */
  private fmtTs(v: unknown): string {
    return fmtDateTime(v) ?? ''
  }
}
