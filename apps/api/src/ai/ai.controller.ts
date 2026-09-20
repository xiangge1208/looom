import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { IsObject, IsString } from 'class-validator'
import type { Request, Response } from 'express'
import { AiService } from './ai.service'
import { JwtAuthGuard, User } from '../auth/jwt-auth.guard'
import type { CurrentUser } from '../auth/jwt.strategy'

export class AnalyzeDto {
  @IsString({ message: 'insertPoint 不能为空' })
  insertPoint: string

  @IsObject({ message: 'input 必须是对象' })
  input: Record<string, any>
}

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  /**
   * SSE 流式分析端点
   *
   * 前端用 fetch + ReadableStream 消费（不用 EventSource，
   * 因为 EventSource 不支持自定义请求头，带不了 Authorization）。
   *
   * 事件格式：`data: {"type":"delta","content":"..."}\n\n`
   */
  @Post('analyze')
  async analyze(
    @Body() dto: AnalyzeDto,
    @User() user: CurrentUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    // 关掉 nginx 缓冲，否则流式内容会被攒成一坨再发
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    // 客户端断开时取消模型调用，避免继续烧 token
    const ctrl = new AbortController()
    req.on('close', () => ctrl.abort())

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    try {
   for await (const ev of this.ai.analyze(
     { userId: user.id, insertPoint: dto.insertPoint, input: dto.input },
        ctrl.signal,
      )) {
        send(ev)
      }
    } catch (err: any) {
      send({ type: 'error', message: err?.message ?? 'AI 分析异常' })
    } finally {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }

  /** 查任务状态（轮询兜底，SSE 断开时用） */
  @Get('tasks/:id')
  getTask(@Param('id') id: string, @User() user: CurrentUser) {
    return this.ai.getTask(id, user.id)
  }

  /** 查已完成的分析结果 */
  @Get('tasks/:id/result')
  getResult(@Param('id') id: string, @User() user: CurrentUser) {
    return this.ai.getAnalysis(id, user.id)
  }
}
