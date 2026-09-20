/**
 * AI Provider 抽象
 *
 * 所有实现都走 OpenAI 兼容协议（/v1/chat/completions），
 * 这样 OpenAI / DeepSeek / 通义千问 / Moonshot / 本地 vLLM / Ollama 都能接，
 * 切换只需改 .env 的 AI_BASE_URL / AI_API_KEY / AI_MODEL 三项。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model: string
  maxTokens: number
  temperature: number
  timeoutMs: number
  signal?: AbortSignal
  /**
   * 插入点标识。真实 provider 不用它，
   * mock provider 靠它精确选择假结果 ——
   * 早先 mock 是按 prompt 文本里的关键词猜的，
   * 结果「综合诊断」的提示词里含「销量」二字就命中了销量模板，
   * 返回了完全不相干的内容。传标识进来避免这种误判。
   */
  insertPoint?: string
}

/** 流式增量。done=true 时 usage 才有值 */
export interface StreamChunk {
  delta: string
  done: boolean
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface AiProvider {
  readonly name: string

  /** 流式对话。返回异步迭代器，逐块吐出增量内容 */
  chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncIterable<StreamChunk>
}

export const AI_PROVIDER = Symbol('AI_PROVIDER')
