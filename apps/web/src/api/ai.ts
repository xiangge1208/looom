import { refreshAccessToken, tokenStore } from './http'

export type AiEventType = 'start' | 'delta' | 'done' | 'error' | 'cached'

export interface AiEvent {
  type: AiEventType
  taskId?: string
  content?: string
  message?: string
  /** 扣费后余额，随 start / cached / error 下发 */
  balance?: number
  /** 本次实际扣减的积分。缓存命中为 0 */
  cost?: number
}

export interface AnalyzeHandlers {
  onStart?: (taskId: string) => void
  /**
* 余额变动。start / cached / error 都可能带余额，
   * 前端据此刷新积分显示，不用再单独发查询请求。
   */
  onBalance?: (balance: number, cost: number) => void
  /** 流式增量，追加到已有内容后面 */
  onDelta?: (chunk: string) => void
  /** 命中缓存，直接给出完整结果（不会再有 delta） */
  onCached?: (full: string) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

/**
 * 发起 AI 流式分析
 *
 * 为什么用 fetch 而不是 EventSource：
 *   EventSource 不支持自定义请求头，带不了 Authorization。
 *   用 fetch + ReadableStream 手动解析 SSE 更可控，也能用 AbortController 取消。
 *
 * 返回一个 cancel 函数，调用即中断（后端会收到 close 并停止调模型，不继续烧 token）。
 */
export function analyzeStream(
  insertPoint: string,
  input: Record<string, any>,
  handlers: AnalyzeHandlers,
): () => void {
  const ctrl = new AbortController()

  void (async () => {
    try {
      /**
       * SSE 必须走裸 fetch（axios 不支持流式读取），所以拿不到 axios 拦截器里的
       * 401→refresh→重放能力，得在这里自己补一次，否则 access token 过期后
       * 点「开始分析」只会看到生硬的 HTTP 401，必须整页刷新才能恢复。
       */
      const send = (token: string | null) =>
        fetch('/api/ai/analyze', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ insertPoint, input }),
          signal: ctrl.signal,
        })

      if (!tokenStore.access) {
        handlers.onError?.('登录状态已失效，请重新登录')
        return
      }

      let res = await send(tokenStore.access)

      if (res.status === 401) {
        // 与普通请求共用同一个刷新 Promise，避免把彼此的新 token 顶掉
        const fresh = await refreshAccessToken()
        if (!fresh) {
          handlers.onError?.('登录状态已失效，请重新登录')
          return
        }
        res = await send(fresh)
      }

      if (!res.ok || !res.body) {
        handlers.onError?.(`请求失败（HTTP ${res.status}）`)
        return
      }

const reader = res.body.getReader()
  const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
   const { done, value } = await reader.read()
    if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE 以空行分隔事件；这里按行取 data: 前缀
        const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

     for (const line of lines) {
    const t = line.trim()
          if (!t.startsWith('data:')) continue
 const payload = t.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

      let ev: AiEvent
     try {
  ev = JSON.parse(payload)
  } catch {
      continue
        }

      switch (ev.type) {
    case 'start':
        handlers.onStart?.(ev.taskId ?? '')
       if (typeof ev.balance === 'number') {
                handlers.onBalance?.(ev.balance, ev.cost ?? 0)
  }
    break
            case 'delta':
   if (ev.content) handlers.onDelta?.(ev.content)
       break
            case 'cached':
         if (ev.content) handlers.onCached?.(ev.content)
              // 缓存命中 cost=0，但余额仍可能被别处消耗过，一并刷新
      if (typeof ev.balance === 'number') {
          handlers.onBalance?.(ev.balance, ev.cost ?? 0)
     }
  break
            case 'done':
     handlers.onDone?.()
   break
case 'error':
    handlers.onError?.(ev.message ?? 'AI 分析失败')
    // 失败会退款，余额要同步回来
     if (typeof ev.balance === 'number') {
          handlers.onBalance?.(ev.balance, 0)
         }
     break
      }
    }
      }
    } catch (err: any) {
      // 主动取消不算错误
      if (err?.name === 'AbortError') return
      handlers.onError?.(err?.message ?? '网络异常')
    }
  })()

  return () => ctrl.abort()
}
