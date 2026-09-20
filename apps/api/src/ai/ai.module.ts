import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { CreditsModule } from '../credits/credits.module'
import { UsersModule } from '../users/users.module'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'
import { MockProvider } from './providers/mock.provider'
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider'
import { AI_PROVIDER } from './providers/provider.interface'

/**
 * AI 模块
 *
 * Provider 由 .env 的 AI_PROVIDER 决定：
 *   mock              开发环境默认，返回预置假结果，不烧钱
 *   openai-compatible 任何兼容 /v1/chat/completions 的服务
 */
@Module({
  imports: [ConfigModule, CreditsModule, UsersModule],
  controllers: [AiController],
providers: [
    AiService,
    MockProvider,
OpenAiCompatibleProvider,
    {
    provide: AI_PROVIDER,
      inject: [ConfigService, MockProvider, OpenAiCompatibleProvider],
      useFactory: (
     config: ConfigService,
        mock: MockProvider,
     real: OpenAiCompatibleProvider,
  ) => {
        const kind = config.get<string>('AI_PROVIDER', 'mock')
        return kind === 'openai-compatible' ? real : mock
      },
    },
  ],
  exports: [AiService],
})
export class AiModule {}
