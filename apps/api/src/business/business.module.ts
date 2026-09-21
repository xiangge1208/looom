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
import { WordPickService } from './wordpick.service'

/**
 * 业务查询模块（P1 核心读流程 + P3 供应商/诊断）
 *
 * 对应 goal.md 页面清单里的核心读流程：
 *   sales / traffic / keywords / keywords-source /
 *   ads(campaigns|groups|keywords) / variations / timeline /
 *   recommendations / competitors
 *
 * 数据来源已不是「全部 seed」——M1~M9 与 M13 的三页是 PG 真实数据 ETL 而来，
 * 只有 M13 的建议竞价页仍是 seed（源 search/cpc/category 未接入）。
 * 各 service 的类注释里写了各自的就绪度。DatabaseModule 是全局模块，无需再 import。
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
    WordPickService,
  ],
  exports: [
    SalesService,
    TrafficService,
    KeywordsService,
    AdsService,
    InsightsService,
    SuppliersService,
    DiagnosisService,
    WordPickService,
  ],
})
export class BusinessModule {}
