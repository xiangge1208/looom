import { Module } from '@nestjs/common'
import { CreditsController } from './credits.controller'
import { CreditsService } from './credits.service'

/**
 * 积分模块
 *
 * 导出 CreditsService 供 AiModule 扣费用。
 * DorisService 是全局模块提供的，这里不用再导入。
 */
@Module({
  controllers: [CreditsController],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
