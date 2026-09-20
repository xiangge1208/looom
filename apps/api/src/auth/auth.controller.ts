import { Body, Controller, Get, Ip, Post, Req, UseGuards } from '@nestjs/common'
import { Throttle, seconds } from '@nestjs/throttler'
import type { Request } from 'express'
import { AuthService } from './auth.service'
import { LoginDto, RefreshDto, RegisterDto } from './dto/auth.dto'
import { JwtAuthGuard, User } from './jwt-auth.guard'
import type { CurrentUser } from './jwt.strategy'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * 注册（邮箱 + 密码，不抄原站的微信扫码）
   *
   * 限流比登录更严：注册是写操作，批量刷号会污染数据。
   */
  @Post('register')
  @Throttle({ default: { ttl: seconds(600), limit: 5 } })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto)
  }

  /**
   * 登录。
   *
   * ⚠️ 限流是防爆破的底线：原先完全无限流，可以无限次撞密码。
   * 10 次/5 分钟 对真人足够（打错几次还能重试），对脚本则基本无用。
   *
   * 注意 ThrottlerGuard 默认按 IP 计数，所以这挡的是「单 IP 爆破」，
   * 挡不住分布式撞库 —— 那需要额外的账号级锁定/验证码，本期不做。
   */
  @Post('login')
  @Throttle({ default: { ttl: seconds(300), limit: 10 } })
  login(@Body() dto: LoginDto, @Ip() ip: string, @Req() req: Request) {
    return this.auth.login(dto, { ip, ua: req.headers['user-agent'] })
  }

  /**
   * 刷新 access token。原站无此机制，是 goal.md 要求的新增设计。
   *
   * 限流放宽一些：正常用户每 2h 才刷一次，但页面多标签并发时
   * 短时间内可能有几次，20 次/5 分钟 留足余量。
   */
  @Post('refresh')
  @Throttle({ default: { ttl: seconds(300), limit: 20 } })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken)
  }

  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken)
  }

  /** 取当前登录用户。对应原站的 /api/user/basic/info 探针 */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@User() user: CurrentUser) {
    return user
  }
}
