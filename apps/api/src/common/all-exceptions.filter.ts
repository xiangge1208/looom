import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { Response } from 'express'

/**
 * 全局异常过滤器
 *
 * 统一成 { code, message, data } 格式；
 * 业务错误用 HTTP 状态码 + code 非 0，不学原站「HTTP 恒 200、靠 code 区分」的做法。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest()

    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let message = '服务器内部错误'

    if (exception instanceof HttpException) {
   status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'string') {
        message = body
      } else if (body && typeof body === 'object') {
        const m = (body as any).message
        // class-validator 的校验错误是数组，拼成一句中文提示
        message = Array.isArray(m) ? m.join('；') : (m ?? exception.message)
      }

      /**
       * 限流异常的默认文案是英文的 "ThrottlerException: Too Many Requests"，
       * 会直接弹给用户。这里替换成可读的中文提示。
       */
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        message = '操作过于频繁，请稍后再试'
      }
    } else if (exception instanceof Error) {
      /**
       * 非 HttpException 一律返回通用文案，不回传 exception.message。
       *
       * 原始 message 里常常带内部细节：Doris 的表名/列名/SQL 片段、
       * DorisService 抛出的库名提示等，回给客户端等于送探测线索。
       * 详情已经完整写进下面的日志（含 stack），排查不受影响。
       */
      message = '服务器内部错误'
      this.logger.error(
        `未捕获异常 ${req?.method} ${req?.url}: ${exception.message}`,
        exception.stack,
      )
    }

    // 已经开始流式输出（SSE）时不能再写 JSON，会破坏格式
    if (res.headersSent) {
  res.end()
      return
    }

    res.status(status).json({
      code: status,
      message,
      data: null,
    })
  }
}
