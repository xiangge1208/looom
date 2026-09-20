import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { PermissionsGuard, RequirePermissions } from '../auth/permissions'
import { User } from '../auth/jwt-auth.guard'
import type { CurrentUser } from '../auth/jwt.strategy'
import { UsersService } from '../users/users.service'
import { AdsService } from './ads.service'
import { InsightsService } from './insights.service'
import { KeywordsService } from './keywords.service'
import { SalesService } from './sales.service'
import { TrafficService } from './traffic.service'
import { SuppliersService } from './suppliers.service'
import { DiagnosisService } from './diagnosis.service'
import {
  AsinQueryDto,
  COUNTRIES,
  KeywordListDto,
  SupplierSearchDto,
  TimePieceQueryDto,
} from './dto/query.dto'

class CompareDto {
  @IsArray({ message: 'asins 必须是数组' })
  @IsString({ each: true })
  asins: string[]

  @IsOptional()
  @IsIn(COUNTRIES as unknown as string[])
  country?: string = 'US'
}

/**
 * 业务查询接口
 *
 * 全部需要登录。路由命名按 goal.md 的页面清单，
 * 不沿用原站的命名（原站 /keywords 是「以词拓词」，会引起歧义）。
 */
@Controller('business')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BusinessController {
  constructor(
    private readonly sales: SalesService,
    private readonly traffic: TrafficService,
    private readonly keywords: KeywordsService,
    private readonly ads: AdsService,
    private readonly insights: InsightsService,
    private readonly suppliers: SuppliersService,
    private readonly diagnosis: DiagnosisService,
    private readonly users: UsersService,
  ) {}

  /**
   * 记一条查询审计。
   *
   * 包成助手是为了让各路由一行搞定，且**绝不 await 失败传播** ——
   * UsersService.logQuery 内部已吞掉异常，审计失败不能影响用户拿数据。
   *
   * ⚠️ query_logs 是高频写入表，schema 注释建议批量写。
   * 这里先用单条 INSERT 跑通功能（不 await，不阻塞响应），
   * 量大了要换成缓冲 + 定时刷盘。
   */
  private track(
    user: CurrentUser,
    ip: string,
    queryType: string,
    queryValue: string,
    country: string,
    pageRoute: string,
    startedAt: number,
    resultCount?: number,
  ) {
    void this.users.logQuery({
      userId: user.id,
      queryType,
      queryValue,
      country,
      pageRoute,
      durationMs: Date.now() - startedAt,
      resultCount,
      ip,
    })
  }

  // ---- 查销量 ----

  @Get('sales/overview')
  async salesOverview(
    @Query() q: AsinQueryDto,
    @User() user: CurrentUser,
    @Ip() ip: string,
  ) {
    const t0 = Date.now()
    const res = await this.sales.getSalesOverview(q.asin, q.country ?? 'US')
    this.track(user, ip, 'asin', q.asin, q.country ?? 'US', '/sales', t0, res.variantCount)
    return res
  }

  @Get('sales/trend')
  salesTrend(@Query() q: AsinQueryDto) {
    return this.sales.getSalesTrend(q.asin, q.country ?? 'US')
  }

  // ---- 查流量结构 ----

  @Get('traffic/structure')
  async trafficStructure(
    @Query() q: TimePieceQueryDto,
    @User() user: CurrentUser,
    @Ip() ip: string,
  ) {
    const t0 = Date.now()
    const res = await this.traffic.getTrafficStructure(
      q.asin,
      q.country ?? 'US',
      q.timePieceValue,
    )
    this.track(user, ip, 'asin', q.asin, q.country ?? 'US', '/traffic', t0)
    return res
  }

  @Get('traffic/variants')
  trafficVariants(
    @Query() q: TimePieceQueryDto,
    @Query('dimension') dimension?: string,
  ) {
    return this.traffic.getVariantTraffic(
      q.asin,
      q.country ?? 'US',
      dimension,
      q.timePieceValue,
    )
  }

  // ---- 反查流量词 ----

  @Get('keywords')
  async listKeywords(
    @Query() q: KeywordListDto,
    @User() user: CurrentUser,
    @Ip() ip: string,
  ) {
    const t0 = Date.now()
    const res = await this.keywords.listKeywords(q)
    this.track(user, ip, 'asin', q.asin, q.country ?? 'US', '/keywords', t0, res.items?.length)
    return res
  }

  /** 单个关键词的流量来源。对应 goal.md 的 /keywords/source */
  @Get('keywords/:keywordId/source')
  keywordSource(
    @Param('keywordId') keywordId: string,
    @Query('country') country = 'US',
    @Query('asin') asin?: string,
  ) {
    return this.keywords.getKeywordSource(keywordId, country, asin)
  }

  // ---- 广告透视 ----

  @Get('ads/campaigns')
  adCampaigns(@Query() q: AsinQueryDto) {
    return this.ads.listCampaigns(q.asin, q.country ?? 'US')
  }

  @Get('ads/campaigns/:campaignId/groups')
  adProductAds(
    @Param('campaignId') campaignId: string,
    @Query('country') country = 'US',
  ) {
    return this.ads.listProductAds(campaignId, country)
  }

  @Get('ads/keywords')
  adSearchTerms(
    @Query() q: AsinQueryDto,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: number,
    @Query('campaignId') campaignId?: string,
  ) {
    return this.ads.listSearchTerms(q.asin, q.country ?? 'US', {
      cursor,
      limit,
      campaignId,
    })
  }

  // ---- 多变体自然位 / 时光机 / 推荐专栏 / 竞品对比 ----

  @Get('variations')
  variations(@Query() q: AsinQueryDto) {
    return this.insights.getVariationNaturalRank(q.asin, q.country ?? 'US')
  }

  @Get('timeline')
  timeline(@Query() q: AsinQueryDto) {
    return this.insights.getTimeline(q.asin, q.country ?? 'US')
  }

  @Get('recommendations')
  recommendations(@Query() q: AsinQueryDto) {
    return this.insights.getRecommendColumns(q.asin, q.country ?? 'US')
  }

  @Get('competitors')
  competitors(@Query('asins') asins: string, @Query('country') country = 'US') {
    // query 里用逗号分隔，避免 asins[]=x&asins[]=y 这种在不同客户端行为不一致的写法
    const list = (asins ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return this.insights.compareAsins(list, country)
  }
  // ---- 供应商搜索（P3）----
  //
  // ⚠️ goal.md 硬约束：本期只做占位 UI + 表结构，
  // 不实现任何采集/爬虫/1688 对接，数据只来自 seed。
  //
  // 加了权限点 supplier:read 作为权限控制的落地示例 ——
  // seed 里普通用户只有 query:read，所以默认访问不到，需要管理员或补授权。

  @Get('suppliers')
  @RequirePermissions('supplier:read')
  async searchSuppliers(
    @Query() q: SupplierSearchDto,
    @User() user: CurrentUser,
    @Ip() ip: string,
  ) {
    const t0 = Date.now()
    const res = await this.suppliers.search(q)
    // 供应商不是 ASIN 查询，country 记 CN（货源在国内）
    this.track(
      user,
      ip,
      'supplier',
      q.keyword || q.location || '（全部）',
      'CN',
      '/suppliers',
      t0,
      res.items?.length,
    )
    return res
  }

  @Get('suppliers/locations')
  @RequirePermissions('supplier:read')
  supplierLocations() {
    return this.suppliers.listLocations()
  }

  // ---- AI 综合诊断汇总（P3）----

  @Get('diagnosis')
  async getDiagnosis(
    @Query() q: AsinQueryDto,
    @User() user: CurrentUser,
    @Ip() ip: string,
  ) {
    const t0 = Date.now()
    const res = await this.diagnosis.summarize(q.asin, q.country ?? 'US')
    this.track(user, ip, 'asin', q.asin, q.country ?? 'US', '/diagnosis', t0)
    return res
  }
}
