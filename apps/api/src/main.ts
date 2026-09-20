import 'reflect-metadata'
import { Logger, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { ResponseInterceptor } from './common/response.interceptor'

async function bootstrap() {
  const logger = new Logger('Bootstrap')
  const app = await NestFactory.create(AppModule, {
    // 用 Nest 自带日志，中文输出
    logger: ['error', 'warn', 'log'],
  })

  app.setGlobalPrefix('api')

  /**
   * CORS 按环境区分。
   *
   * 原先无条件 `origin: true` + `credentials: true` —— 注释写的是「开发环境放开」，
   * 但没有真的按环境判断，生产镜像同样会反射任意 Origin 并允许带凭据。
   * 当前认证走 Bearer header、CSRF 风险有限，但这是个危险默认：
   * 一旦将来改用 Cookie 就是现成的洞。
   *
   * 生产环境通过 WEB_ORIGIN 配置允许的源（逗号分隔）；没配则不启用 CORS
   * （同域 nginx 反代部署本来就不需要跨域）。
   */
  const isProd = process.env.NODE_ENV === 'production'
  const allowedOrigins = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (!isProd) {
    // 开发环境放开，让 Vite dev server 能直连
    app.enableCors({ origin: true, credentials: true })
  } else if (allowedOrigins.length) {
    app.enableCors({ origin: allowedOrigins, credentials: true })
  } else {
    logger.log('未配置 WEB_ORIGIN，生产环境不启用 CORS（同域部署无需跨域）')
  }

  // 后端也要校验（goal.md 要求前后端双重校验）
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 剔除 DTO 未声明的字段
      forbidNonWhitelisted: false,
      transform: true,
    }),
  )

  app.useGlobalInterceptors(new ResponseInterceptor())
  app.useGlobalFilters(new AllExceptionsFilter())

  const port = Number(process.env.API_PORT ?? 3000)
  await app.listen(port, '0.0.0.0')

  logger.log(`后端已启动：http://localhost:${port}/api`)
  logger.log(`健康检查：http://localhost:${port}/api/health`)
  logger.log(`AI Provider：${process.env.AI_PROVIDER ?? 'mock'}`)
}

bootstrap().catch((err) => {
  // 启动失败要给出可操作的提示，而不是一堆栈
  new Logger('Bootstrap').error(`启动失败：${err?.message ?? err}`)
  process.exit(1)
})
