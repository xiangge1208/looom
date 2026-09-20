import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type {
  AiProvider,
  ChatMessage,
  ChatOptions,
  StreamChunk,
} from './provider.interface'

/**
 * OpenAI 兼容 Provider
 *
 * 适用于任何实现了 /v1/chat/completions 且支持 SSE 流式的服务：
 *   OpenAI、DeepSeek、通义千问、Moonshot、本地 vLLM、Ollama 等。
 *
 * 不硬编码任何厂商或模型名 —— 全部从 .env 读。
 */
@Injectable()
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible'
  private readonly logger = new Logger(OpenAiCompatibleProvider.name)

  constructor(private readonly config: ConfigService) {}

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    const baseUrl = (
      this.config.get<string>('AI_BASE_URL') ?? 'https://api.openai.com/v1'
    ).replace(/\/+$/, '')
    const apiKey = this.config.get<string>('AI_API_KEY') ?? ''

    if (!apiKey) {
      throw new ServiceUnavailableException(
    'AI_API_KEY 未配置。开发环境可设 AI_PROVIDER=mock 跳过真实调用。',
 )
    }

    // 同时受外部取消信号和超时控制
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs)
    options.signal?.addEventListener('abort', () => ctrl.abort(), { once: true })

    let res: Response
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
        headers: {
   'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
messages,
  max_tokens: options.maxTokens,
      temperature: options.temperature,
          stream: true,
          // 要 usage 统计，OpenAI 系需显式声明；不支持的服务会忽略此字段
      stream_options: { include_usage: true },
        }),
   signal: ctrl.signal,
    })
    } catch (err: any) {
   clearTimeout(timer)
      if (err?.name === 'AbortError') {
    this.logger.warn('AI 请求被取消或超时')
        return
      }
    throw new ServiceUnavailableException(`AI 服务请求失败：${err?.message}`)
    }

    if (!res.ok || !res.body) {
  clearTimeout(timer)
      const detail = await res.text().catch(() => '')
      throw new ServiceUnavailableException(
  `AI 服务返回 ${res.status}：${detail.slice(0, 300)}`,
   )
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: StreamChunk['usage']

    try {
      while (true) {
        const { done, value } = await reader.read()
      if (done) break

        buffer += decoder.decode(value, { stream: true })

      // SSE 按空行分事件；这里按行解析 data: 前缀
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
       const trimmed = line.trim()
   if (!trimmed.startsWith('data:')) continue
 const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue

    try {
    const json = JSON.parse(payload)
 const delta = json.choices?.[0]?.delta?.content
      if (delta) {
     yield { delta, done: false }
        }
            if (json.usage) {
    usage = {
      promptTokens: json.usage.prompt_tokens ?? 0,
             completionTokens: json.usage.completion_tokens ?? 0,
       totalTokens: json.usage.total_tokens ?? 0,
              }
            }
       } catch {
            // 单块解析失败不致命，跳过继续读下一块
      this.logger.debug(`跳过无法解析的 SSE 块：${payload.slice(0, 80)}`)
          }
        }
      }
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
    }

    yield { delta: '', done: true, usage }
  }
}
