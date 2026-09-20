import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { UsersModule } from '../users/users.module'
import { BusinessController } from './business.controller'
import { AdsService } from './ads.service'
import { InsightsService } from './insights.service'
import { KeywordsService } from './keywords.service'
import { SalesService } from './sales.service'
import { TrafficService } from './traffic.service'
import { SuppliersService } from './suppliers.service'
import { DiagnosisService } from './diagnosis.service'

/**
 * 业务查询模块（P1 核心读流程 + P3 供应商/诊断）
 *
 * 对应 goal.md 页面清单里的核心读流程：
 *   sales / traffic / keywords / keywords-source /
 *   ads(campaigns|groups|keywords) / variations / timeline /
 *   recommendations / competitors
 *
 * 数据全部来自 seed。DatabaseModule 是全局模块，这里无需再 import。
 */
@Module({
  // PermissionsGuard 由 AuthModule 提供；UsersModule 提供查询埋点
  imports: [AuthModule, UsersModule],
  controllers: [BusinessController],
  providers: [
    SalesService,
    TrafficService,
    KeywordsService,
    AdsService,
    InsightsService,
    SuppliersService,
    DiagnosisService,
  ],
  exports: [
    SalesService,
    TrafficService,
    KeywordsService,
    AdsService,
    InsightsService,
    SuppliersService,
    DiagnosisService,
  ],
})
export class BusinessModule {}
