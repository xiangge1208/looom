import { Controller, Get, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AiModule } from './ai/ai.module'
import { AuthModule } from './auth/auth.module'
import { BusinessModule } from './business/business.module'
import { CreditsModule } from './credits/credits.module'
import { DatabaseModule } from './database/database.module'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler'
import { DorisService } from './database/doris.service'
import { UsersModule } from './users/users.module'

/** 健康检查。用于 Docker healthcheck 和排查「后端起没起来」 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: DorisService) {}

  /**
   * ⚠️ 这个接口无鉴权（Docker healthcheck 要用），所以**不要**回传
   * 库名、表数量等内部信息 —— 那是免费送给攻击者的侦察线索。
   *
   * 仍然真的查一次库来验证连通性（这是健康检查的意义），
   * 只是把结果收敛成 ok / error，细节留给服务端日志和内部监控。
   */
  @Get()
  async check() {
    await this.db.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [this.db.database],
    )
    return { status: 'ok' }
  }
}

@Module({
  imports: [
    // 从项目根目录读 .env（apps/api 的上两级）
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    /**
     * 全局限流。
     *
     * 之前登录/注册/刷新完全无限流，可以无限次撞密码。
     * 这里给一个宽松的全局兜底（业务查询用），
     * auth 相关接口在 AuthController 上用 @Throttle 单独收紧。
     *
     * ⚠️ 默认是内存存储：多副本部署时每个实例各算一份，
     * 真要严格限流需换 Redis storage（当前单副本够用）。
     */
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: seconds(60), limit: 120 }],
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    CreditsModule,
    AiModule,
    BusinessModule,
  ],
  controllers: [HealthController],
  providers: [
    // 全局启用，所有路由默认受 default 限流约束
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
