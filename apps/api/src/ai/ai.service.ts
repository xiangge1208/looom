import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash } from 'node:crypto'
import { DorisService } from '../database/doris.service'
import { CreditsService } from '../credits/credits.service'
import { snowflake } from '../common/snowflake'
import { PROMPTS } from './prompts'
import { AI_PROVIDER, type AiProvider } from './providers/provider.interface'

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

export interface AnalyzeRequest {
  userId: string
  insertPoint: string
  input: Record<string, any>
}

export interface AnalyzeEvent {
  type: 'start' | 'delta' | 'done' | 'error' | 'cached'
  taskId?: string
  content?: string
  message?: string
  /** 扣费后余额，随 start / cached 事件下发，前端用它刷新积分卡片 */
  balance?: number
  /** 本次实际扣减的积分。缓存命中为 0 */
  cost?: number
}

/**
 * AI 统一调用入口
 *
 * 负责：provider 切换、缓存命中、重试、计费与退款、任务落库。
 * 各页面不要直接调 provider，一律走这里。
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name)

  constructor(
    private readonly db: DorisService,
    private readonly config: ConfigService,
    private readonly credits: CreditsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}
  /**
   * 执行分析，以异步生成器逐块吐出事件（供 SSE 端点消费）。
 *
   * 流程：查缓存 → 建任务 → 调模型（失败重试 2 次）→ 落库结果
*/
  async *analyze(
    req: AnalyzeRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AnalyzeEvent> {
    const tpl = PROMPTS[req.insertPoint]
    if (!tpl) {
      throw new BadRequestException(`未知的 AI 插入点：${req.insertPoint}`)
    }

    const userPrompt = tpl.build(req.input)
    const inputHash = createHash('sha256')
      .update(`${tpl.insertPoint}:${tpl.version}:${userPrompt}`)
 .digest('hex')

    // ---- 1. 查缓存 ----
    // 缓存键含 prompt_version：改 prompt 换版本号即可让旧缓存自动失效
    if (this.config.get('AI_ENABLE_CACHE') !== 'false') {
      const cached = await this.db.queryOne<{ content_md: string; id: string }>(
    `SELECT a.content_md, a.id
         FROM ai_analyses a
         JOIN ai_tasks t ON a.task_id = t.id
    WHERE t.insert_point = ? AND t.prompt_version = ?
        AND t.input_hash = ? AND t.status = 'success'
  ORDER BY a.created_at DESC LIMIT 1`,
        [tpl.insertPoint, tpl.version, inputHash],
      )
      if (cached) {
        this.logger.debug(`缓存命中 ${tpl.insertPoint}/${tpl.version}`)
        // 缓存命中不扣费：没调模型就没有成本，扣了等于重复收费。
        // 这也是 goal.md「命中缓存直接返回，不重复扣费」的要求。
    const acc = await this.credits.getAccount(req.userId)
 yield {
          type: 'cached',
          content: cached.content_md,
   balance: acc.balance,
          cost: 0,
        }
 yield { type: 'done' }
        return
      }
    }

    // ---- 2. 扣费 ----
    // 顺序很重要：先扣费再建任务。
    // 反过来的话，余额不足时会留下一条永远不会执行的 running 任务。
    const spend = await this.credits.spend(req.userId, 'ai_analysis', {
      remark: `AI 分析：${tpl.insertPoint}`,
    })

    if (!spend.ok) {
      const msg =
 spend.reason === 'insufficient'
   ? `积分不足，本次需要 ${spend.cost} 积分，当前余额 ${spend.balance}`
          : '系统繁忙，请稍后重试'
      yield { type: 'error', message: msg, balance: spend.balance }
      return
    }

    // ---- 3. 建任务 ----
    const taskId = snowflake.nextId()
    const model = this.config.get<string>('AI_MODEL', 'gpt-4o-mini')
    await this.db.execute(
      `INSERT INTO ai_tasks
    (id, user_id, insert_point, prompt_version, input_hash, input_payload,
      status, provider, model, retry_count, credits_frozen, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, 0, ?, ?, ?)`,
      [
        taskId,
        req.userId,
        tpl.insertPoint,
     tpl.version,
     inputHash,
    JSON.stringify(req.input).slice(0, 60000),
        this.provider.name,
        model,
        // 记录本次扣了多少，失败退款按这个值退
        spend.cost,
    now(),
        now(),
      ],
    )

    yield {
      type: 'start',
      taskId: taskId.toString(),
      balance: spend.balance,
      cost: spend.cost,
    }

    // ---- 4. 调模型，失败重试 2 次 ----
    const maxRetries = 2
    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let full = ''
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

      try {
     const stream = this.provider.chatStream(
   [
   { role: 'system', content: tpl.system },
  { role: 'user', content: userPrompt },
        ],
    {
         model,
    maxTokens: Number(this.config.get('AI_MAX_TOKENS', 2000)),
      temperature: Number(this.config.get('AI_TEMPERATURE', 0.7)),
      timeoutMs: Number(this.config.get('AI_TIMEOUT_MS', 60000)),
   signal,
            // 让 mock provider 精确选模板；真实 provider 会忽略这个字段
            insertPoint: tpl.insertPoint,
          },
        )

    for await (const chunk of stream) {
        if (signal?.aborted) {
 await this.markTask(taskId, 'cancelled', attempt, '用户取消')
          // 取消也要退款：钱是在调模型前扣的，没出结果就不该收费。
          // ⚠️ 这条分支和流结束后那条（见下方 aborted 判断）必须保持一致 ——
          // P4 时只补了后者，漏了这里，真实模型流较长时用户中途取消会白扣。
          await this.refundCredits(taskId, req.userId)
          yield { type: 'error', message: '已取消' }
      return
      }
    if (chunk.delta) {
      full += chunk.delta
            yield { type: 'delta', content: chunk.delta }
      }
     if (chunk.done) usage = chunk.usage
        }

  /**
     * 流结束后再判一次取消与空结果。
    *
   * ⚠️ 循环里那次检查不够：provider 在收到 abort 后会**直接 return**，
         * 流自然结束，`for await` 正常退出，根本不会再进入循环体。
       * 结果是取消的任务被标成 success，还把**空内容**写进了 ai_analyses ——
         * 这份空结果会进缓存，之后同样的输入永远返回空白分析。
       * 实测：外部 300ms 后 abort → delta 块数 0、状态 success、结果行 1。
     */
        if (signal?.aborted) {
          await this.markTask(taskId, 'cancelled', attempt, '用户取消')
          await this.refundCredits(taskId, req.userId)
  yield { type: 'error', message: '已取消' }
          return
        }

        if (!full.trim()) {
    // 空结果不落库、不进缓存。当作一次失败走重试逻辑，
// 重试仍为空则走下面的失败分支（标记失败 + 退款）。
   lastError = '模型返回了空内容'
          this.logger.warn(`AI 返回空内容，任务 ${taskId} 第 ${attempt + 1} 次`)
          if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
continue
      }
          break
        }

        // 成功：落库结果
        await this.db.execute(
  `INSERT INTO ai_analyses
     (id, task_id, user_id, insert_point, content_md,
       prompt_tokens, completion_tokens, total_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
      snowflake.nextId(),
     taskId,
       req.userId,
     tpl.insertPoint,
   full,
usage?.promptTokens ?? 0,
       usage?.completionTokens ?? 0,
     usage?.totalTokens ?? 0,
       now(),
          ],
        )
        await this.markTask(taskId, 'success', attempt)
        yield { type: 'done', taskId: taskId.toString() }
        return
   } catch (err: any) {
        lastError = err?.message ?? String(err)
        this.logger.warn(
    `AI 调用失败（第 ${attempt + 1}/${maxRetries + 1} 次）：${lastError}`,
        )
        if (attempt < maxRetries) {
          // 退避重试，避免瞬时故障时连续打服务
 await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
  }
 }
    }

    // ---- 5. 三次都失败：标记失败并退还积分 ----
    await this.markTask(taskId, 'failed', maxRetries, lastError)
    await this.refundCredits(taskId, req.userId)
    yield { type: 'error', message: `AI 分析失败：${lastError ?? '未知错误'}` }
  }

  /** 更新任务状态。Doris Unique Key 模型下同主键 INSERT 即覆盖 */
  private async markTask(
    taskId: bigint,
    status: string,
    retryCount: number,
    errorMsg?: string,
  ) {
    const t = await this.db.queryOne<any>(
      'SELECT * FROM ai_tasks WHERE id = ? LIMIT 1',
      [taskId],
  )
    if (!t) return
    await this.db.execute(
      `INSERT INTO ai_tasks
         (id, user_id, insert_point, prompt_version, input_hash, input_payload,
    status, provider, model, retry_count, credits_frozen,
     error_msg, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id, t.user_id, t.insert_point, t.prompt_version, t.input_hash,
        t.input_payload, status, t.provider, t.model, retryCount,
        t.credits_frozen, errorMsg?.slice(0, 1000) ?? null,
      t.started_at, now(), t.created_at,
      ],
    )
  }

  /**
   * 退还已扣积分
   *
   * 走 CreditsService.grant()，它内部是 CAS 加法 + bizId 幂等：
   *   - 真正把余额加回去（旧实现只写了一条流水，余额没动，用户等于白扣）
   *   - balance_after 是真实余额（旧实现写死 0，对账时会误判）
   *   - 同一个 taskId 只退一次（重试路径可能重复调用）
   *
   * ⚠️ 仍非原子：Doris 无跨表事务，改余额与写流水是两次写入。
   * 顺序是「先改余额、后写流水」，最坏情况是流水缺失而余额正确 ——
   * 对用户无损，由对账任务补录。
   */
  private async refundCredits(taskId: bigint, userId: string) {
    const task = await this.db.queryOne<{ credits_frozen: string }>(
      'SELECT credits_frozen FROM ai_tasks WHERE id = ? LIMIT 1',
      [taskId],
    )
    const frozen = Number(task?.credits_frozen ?? 0)
    if (frozen <= 0) return

    this.logger.log(`AI 任务 ${taskId} 失败，退还 ${frozen} 积分给用户 ${userId}`)
    await this.credits.grant(userId, 'refund', frozen, {
      bizType: 'ai_analysis',
      bizId: taskId.toString(),
      remark: 'AI 分析失败自动退还',
    })
  }

  /** 查任务状态 */
  async getTask(taskId: string, userId: string) {
    return this.db.queryOne(
    `SELECT id, insert_point, status, retry_count, error_msg, created_at, finished_at
       FROM ai_tasks WHERE id = ? AND user_id = ? LIMIT 1`,
      [taskId, userId],
    )
  }

  /** 查分析结果 */
  async getAnalysis(taskId: string, userId: string) {
    return this.db.queryOne(
      `SELECT task_id, content_md, total_tokens, created_at
       FROM ai_analyses WHERE task_id = ? AND user_id = ? LIMIT 1`,
      [taskId, userId],
    )
  }
}
