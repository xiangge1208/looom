import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { DorisService } from '../database/doris.service'

export interface JwtPayload {
  sub: string
  email: string
}

export interface CurrentUser {
  id: string
  email: string
  status: number
}

/**
 * JWT 策略
 *
 * 注意与原站的差异：
 *   原站请求头是小写 `authorization` 且**不带 Bearer 前缀**（裸 token）。
 *   我们按标准用 `Authorization: Bearer <token>` —— 这是通行做法，
 *   且 passport-jwt 默认就按此解析。前端 Axios 拦截器要对应加前缀。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly db: DorisService,
  ) {
    const secret = config.get<string>('JWT_SECRET')
    // 绝不能回退到硬编码默认值：签发侧（auth.service.ts issueTokens）没有回退，
    // 验证侧一旦回退成众所周知的字符串，环境变量漏配时攻击者就能用该字符串
    // 自签任意 { sub } 通过 JwtAuthGuard。宁可启动失败也不要静默降级。
    if (!secret) {
      throw new Error('JWT_SECRET 未配置，拒绝启动（禁止使用默认密钥）')
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    })
  }

  async validate(payload: JwtPayload): Promise<CurrentUser> {
    const user = await this.db.queryOne<CurrentUser>(
      'SELECT id, email, status FROM users WHERE id = ? AND is_deleted = 0 LIMIT 1',
      [payload.sub],
    )
    if (!user) {
      throw new UnauthorizedException('用户不存在')
    }
    if (user.status === 2) {
      throw new UnauthorizedException('账号已被封禁')
    }
    if (user.status !== 1) {
      throw new UnauthorizedException('账号不可用')
    }
    // BIGINT 转 string，避免传给前端时丢精度
    return { ...user, id: String(user.id) }
  }
}
