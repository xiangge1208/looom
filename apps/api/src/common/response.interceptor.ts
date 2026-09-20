import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'

/**
 * 统一响应格式：{ code, message, data }
 *
 * 说明（与原站的差异，有意为之）：
 *   原站用 code:1 表示成功、且信封是 {code, data, commonMsg}。
 *   我们按 goal.md 用 {code, message, data}，且 **code:0 表示成功**
 *   —— 0 表示无错误更符合通行惯例，不照抄原站的 code:1。
 */
export interface ApiResponse<T = any> {
  code: number
  message: string
  data: T
}

/** SSE 流式响应不能被包装，否则会破坏 text/event-stream 格式 */
export const SKIP_WRAP = Symbol('SKIP_WRAP')

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T> | T>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T> | T> {
    const res = context.switchToHttp().getResponse()

    return next.handle().pipe(
      map((data) => {
        // SSE / 文件下载等场景跳过包装
    const contentType = res.getHeader?.('Content-Type')
        if (
       typeof contentType === 'string' &&
          (contentType.includes('text/event-stream') ||
   contentType.includes('application/octet-stream'))
        ) {
      return data
        }
        if (data && typeof data === 'object' && SKIP_WRAP in data) {
     return (data as any)[SKIP_WRAP]
     }

     return { code: 0, message: 'ok', data: data ?? null }
  }),
    )
  }
}
