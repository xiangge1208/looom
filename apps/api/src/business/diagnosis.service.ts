import { Injectable, Logger } from '@nestjs/common'
import { DorisService } from '../database/doris.service'
import { SalesService } from './sales.service'
import { TrafficService } from './traffic.service'
import { KeywordsService } from './keywords.service'
import { AdsService } from './ads.service'
import { InsightsService } from './insights.service'

/**
 * AI 综合诊断（对应 goal.md 第 14 页 /diagnosis + AI 插入点 6）
 *
 * 把四个域的数据汇总成一份摘要，交给模型做根因分析。
 *
 * ## 两个设计取舍
 *
 * 1. **复用各域 Service，不重写 SQL。**
 *    否则同一份口径要维护两遍，改了一处忘另一处就会出现
 *    「诊断页数字和详情页不一致」这种最难查的问题。
 *
 * 2. **单域失败不拖垮整页。**
 *    用 allSettled 而不是 all —— seed 数据分布不均，
 *    某个 ASIN 很可能只有销量没有广告。缺一块就标记为不可用，
 *    让模型知道「这块没数据」，而不是整个诊断挂掉。
 *    这也是 goal.md 要求的「数据不足就明确说数据不足，不要编造」。
 */
@Injectable()
export class DiagnosisService {
  private readonly logger = new Logger(DiagnosisService.name)

  constructor(
    private readonly db: DorisService,
    private readonly sales: SalesService,
    private readonly traffic: TrafficService,
    private readonly keywords: KeywordsService,
    private readonly ads: AdsService,
    private readonly insights: InsightsService,
  ) {}

  /**
   * 汇总一个 ASIN 的全域现状。
   *
   * 返回结构里每一块都带 available 标记，前端据此显示「暂无数据」，
   * 送给 AI 的 prompt 也据此说明缺哪块。
   */
  async summarize(asin: string, country: string) {
    const [salesRes, trafficRes, kwRes, adsRes, recRes] = await Promise.allSettled([
      this.sales.getSalesOverview(asin, country),
      this.traffic.getTrafficStructure(asin, country),
      this.keywords.listKeywords({ asin, country, limit: 10 } as any),
      this.ads.listCampaigns(asin, country),
      this.insights.getRecommendColumns(asin, country),
    ])

    const pick = <T>(r: PromiseSettledResult<T>, label: string): T | null => {
      if (r.status === 'fulfilled') return r.value
      this.logger.warn(`诊断汇总：${label} 取数失败 —— ${r.reason?.message}`)
      return null
    }

    const sales = pick(salesRes, '销量')
    const structure = pick(trafficRes, '流量结构')
    const kws = pick(kwRes, '关键词')
    const campaigns = pick(adsRes, '广告')
    const recs = pick(recRes, '推荐专栏')

    // 各块摘要。刻意只保留模型判断需要的字段，
    // 整页原始数据塞进 prompt 会挤爆上下文也降低信噪比
    /**
     * ⚠️ available 的含义是「**确实有数据**」，不是「查询没报错」。
     *
     * 关键词和广告接口对没有数据的 ASIN 会正常返回空数组而不是抛错。
     * 如果只看 allSettled 的 fulfilled 就标成 available，页面会显示
     * 「关键词：Top 0 词」「广告：0 个活动」并当成有效维度 ——
     * 这正是「0」与「无数据」混淆的坑：用户会以为该商品真的一个词都没排上，
     * 模型也会据此得出错误结论。所以按**实际行数**判断。
     */
    const variantItems = ((sales as any)?.variants ?? []) as any[]
    const kwItems = ((kws as any)?.items ?? []) as any[]
    const campaignItems = ((campaigns as any)?.campaigns ?? []) as any[]
    const recItems = ((recs as any)?.columns ?? []) as any[]
    const hasTraffic =
      !!structure &&
      ((structure as any).overview?.natural !== null ||
 (structure as any).overview?.ad !== null)

    const salesPart =
      sales && variantItems.length
 ? {
     available: true,
            title: (sales as any).target?.title ?? null,
     isParent: (sales as any).target?.isParentAsin ?? false,
     variantCount: (sales as any).variantCount ?? 0,
     /**
      * 销量是**分档字符串**（如「100+」），不是精确值。
      * 各变体各有档位，所以逐变体列出而不给总数 ——
      * prompt 里也讲明这是区间，不能拿来做精确加减。
      */
            variantSales: variantItems.slice(0, 10).map((v: any) => ({
       asin: v.asin,
       boughtLabel: v.boughtLabel,
       trafficRatio: v.trafficRatio,
            })),
   }
        : { available: false }

    const trafficPart = hasTraffic
      ? {
          available: true,
          naturalRatio: (structure as any).overview?.natural?.ratio ?? null,
          adRatio: (structure as any).overview?.ad?.ratio ?? null,
   adBreakdown: ((structure as any).adBreakdown ?? []).map((c: any) => ({
     channel: c.channel,
     name: c.name,
     ratio: c.ratio,
          })),
        }
      : { available: false }

    const keywordPart = kwItems.length
      ? {
          available: true,
          topKeywords: kwItems.slice(0, 10).map((k: any) => ({
     keyword: k.keyword,
     rank: k.nfLastRank,
     searches: k.estSearchesNum,
     scoreRatio: k.listingScoreRatio,
          })),
        }
      : { available: false }

    const adPart = campaignItems.length
      ? {
   available: true,
   campaignCount: campaignItems.length,
   campaigns: campaignItems.map((c: any) => ({
     fakeCampaignId: c.fakeCampaignId,
     adTypeName: c.adTypeName,
     strategy: c.strategy,
     involvedAdNum: c.involvedAdNum,
     totalScore: c.totalScore,
   })),
        }
      : { available: false }

    const recPart = recItems.length
      ? {
          available: true,
          columns: recItems.map((c: any) => ({
            name: c.name,
     totalRatio: c.totalRatio,
   })),
 }
      : { available: false }

    const missing = [
      salesPart.available ? null : '销量',
      trafficPart.available ? null : '流量结构',
      keywordPart.available ? null : '关键词',
      adPart.available ? null : '广告',
    ].filter(Boolean) as string[]

    return {
      asin,
      country,
      sales: salesPart,
      traffic: trafficPart,
      keywords: keywordPart,
      ads: adPart,
      recommendations: recPart,
      /** 缺失的域，前端和 prompt 都用它提示「数据不足」 */
      missingDomains: missing,
      /** 四个核心域全缺时诊断没有意义，前端据此直接提示换 ASIN */
      hasAnyData: missing.length < 4,
    }
  }
}
