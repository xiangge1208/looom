import { createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { CurrentUser } from './jwt.strategy'

/** 需要登录的接口加 @UseGuards(JwtAuthGuard) */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

/**
 * 在 controller 里用 @User() user: CurrentUser 取当前登录用户 */
export const User = createParamDecorator(
  (data: keyof CurrentUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest()
    const user = req.user as CurrentUser
    return data ? user?.[data] : user
  },
)
