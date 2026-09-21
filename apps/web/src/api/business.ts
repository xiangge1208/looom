import { request } from './http'

/**
 * 业务查询接口
 *
 * 对应后端 /api/business/**
 */

// ---- 通用类型 ----

export interface VariantItem {
  asin: string
  title: string | null
  img: string | null
  price: number | null
  score: number | null
  star: number | null
  ratingNum: number | null
  isBestSeller: boolean
  /** 变体属性，键是维度名（Size/Color/…）。维度**不是固定的**，不要写死两列 */
  features: Record<string, string>
  trafficRatio: number | null
  /** 销量是分档字符串，如 "200+"、"<50"，不是精确值 */
  boughtLabel: string | null
  boughtLowerBound: number | null
  /**
   * 是否为父体行。
   *
   * 父体作为第一行出现（对齐原站），但它没有销量和流量占比 ——
   * 销量只存在于子体。前端要据此区别渲染，不能显示成「销量 0」。
   */
  isParent?: boolean
}

export interface SalesOverview {
  target: { asin: string; title: string; img: string; isParentAsin: boolean }
  parentAsin: string | null
  /** 属性维度名，如 ["Size","Color"]。数量随商品变化 */
  dimensions: string[]
  variantCount: number
  variants: VariantItem[]
}

export interface SalesTrend {
  dates: string[]
  series: { asin: string; values: (number | null)[]; labels: (string | null)[] }[]
}

export interface ChannelItem {
  channel: string
  name: string
  color: string | null
  score: number | null
  ratio: number | null
  change: number | null
  changeRatio: number | null
}

export interface TrafficStructure {
  asin: string
  country: string
  timePieceValue: string
  overview: { total: ChannelItem | null; natural: ChannelItem | null; ad: ChannelItem | null }
  adBreakdown: ChannelItem[]
  recommendColumns: {
    recTitle: string
    name: string
    shortCode: string
    ratio: number | null
    campaignCount: number
    keywordCount: number
  }[]
}

export interface KeywordRow {
  /** 可空：多数源接口不返回 keyword_id。不要用它做主键或请求参数 */
  keywordId: string | null
  /** 关键词文本，才是真正的业务主键（配合 country） */
  keyword: string
  translateKeyword: string | null
  estSearchesNum: number | null
  isCore: boolean
  isTarget: boolean
  nfLastRank: number | null
  spLastRank: number | null
  listingScoreRatio: number | null
  exposurePositions: string[]
  channels: Record<string, { score: number; ratio: number | null; changeRatio: number | null }>
}

export interface KeywordPage {
  asin: string
  country: string
  timePieceValue: string
  items: KeywordRow[]
  nextCursor: string | null
  hasMore: boolean
}

/**
 * 用户的默认站点。
 *
 * 原先这里 12 个方法都写死 `country = 'US'`，导致账户设置里的
 * 「默认站点」保存后没有任何查询页会用它 —— 是个纯死设置。
 *
 * 改成从这个模块级变量取：登录/恢复会话后由 auth store 调用
 * `setDefaultCountry()` 灌入用户偏好，未设置时仍回落 'US'。
 *
 * 为什么不直接在方法里 import store：api 层被 store 依赖，
 * 反向 import 会形成循环依赖。用一个显式的 setter 注入更干净。
 */
let defaultCountry = 'US'

export function setDefaultCountry(c: string | null | undefined) {
  if (c && /^[A-Z]{2}$/.test(c)) defaultCountry = c
}

/** 供各 api 方法做默认值用，调用时求值以拿到最新偏好 */
const dc = () => defaultCountry

export const businessApi = {
  salesOverview(asin: string, country = dc()) {
    return request<SalesOverview>({ url: '/business/sales/overview', params: { asin, country } })
  },

  salesTrend(asin: string, country = dc()) {
    return request<SalesTrend>({ url: '/business/sales/trend', params: { asin, country } })
  },

  trafficStructure(asin: string, country = dc(), timePieceValue?: string) {
    return request<TrafficStructure>({
      url: '/business/traffic/structure',
      params: { asin, country, timePieceValue },
    })
  },

  trafficVariants(asin: string, country = dc(), dimension?: string) {
    return request<{ dimension: string; rows: any[] }>({
      url: '/business/traffic/variants',
      params: { asin, country, dimension },
    })
  },

  keywords(params: {
    asin: string
    country?: string
    cursor?: string
    limit?: number
    keyword?: string
    sortBy?: string
  }) {
    return request<KeywordPage>({ url: '/business/keywords', params })
  },

  /**
   * 关键词流量来源。
   *
   * ⚠️ 传的是**关键词文本**而非 keyword_id —— 后者跨站点不唯一、且多数源接口为空。
   * 关键词含空格和特殊字符，必须 encodeURIComponent，否则路径会被截断。
   */
  keywordSource(keyword: string, country = dc(), asin?: string) {
    return request<any>({
      url: `/business/keywords/${encodeURIComponent(keyword)}/source`,
      params: { country, asin },
    })
  },

  adCampaigns(asin: string, country = dc()) {
    return request<{ campaigns: any[] }>({
      url: '/business/ads/campaigns',
      params: { asin, country },
    })
  },

  adProductAds(campaignId: string, country = dc()) {
    return request<{ productAds: any[] }>({
      url: `/business/ads/campaigns/${campaignId}/groups`,
      params: { country },
    })
  },

  adSearchTerms(params: { asin: string; country?: string; cursor?: string; limit?: number }) {
    return request<{ items: any[]; nextCursor: string | null; hasMore: boolean }>({
      url: '/business/ads/keywords',
      params,
    })
  },

  variations(asin: string, country = dc()) {
    return request<any>({ url: '/business/variations', params: { asin, country } })
  },

  timeline(asin: string, country = dc()) {
    return request<any>({ url: '/business/timeline', params: { asin, country } })
  },

  recommendations(asin: string, country = dc()) {
    return request<{ columns: any[] }>({
      url: '/business/recommendations',
      params: { asin, country },
    })
  },

  competitors(asins: string[], country = dc()) {
    return request<{ items: any[] }>({
      url: '/business/competitors',
      params: { asins: asins.join(','), country },
    })
  },
}

// ---- 供应商搜索（P3）----

export interface SupplierItem {
  id: string
  supplierName: string | null
  /** 1688 货源 ID。seed 数据是自造的，不指向真实货源 */
  offerId: string | null
  title: string | null
  img: string | null
  price: number | null
  minOrder: number | null
  location: string | null
  createdAt: string | null
}

export interface SupplierPage {
  items: SupplierItem[]
  nextCursor: string | null
  hasMore: boolean
}

export const suppliersApi = {
  search: (params: {
    keyword?: string
    location?: string
    minPrice?: number
    maxPrice?: number
    cursor?: string
    limit?: number
  }) => request<SupplierPage>({ url: '/business/suppliers', params }),

  locations: () =>
    request<{ items: { location: string; count: number }[] }>({
      url: '/business/suppliers/locations',
    }),
}

// ---- 综合诊断（P3）----

export interface DiagnosisSummary {
  asin: string
  country: string
  sales: { available: boolean; title?: string | null; isParent?: boolean; variantCount?: number; variantSales?: any[] }
  traffic: { available: boolean; naturalRatio?: number | null; adRatio?: number | null; adBreakdown?: any[] }
  keywords: { available: boolean; topKeywords?: any[] }
  ads: { available: boolean; campaignCount?: number; campaigns?: any[] }
  recommendations: { available: boolean; columns?: any[] }
  /** 缺失的数据域，前端据此提示「数据不足」 */
  missingDomains: string[]
  hasAnyData: boolean
}

export const diagnosisApi = {
  summarize: (asin: string, country = dc()) =>
    request<DiagnosisSummary>({ url: '/business/diagnosis', params: { asin, country } }),
}

// ====================================================================
// M13 选词 / 关键词竞争分析（4 个页面）
//
// 与上面各接口的最大区别：**按关键词查**而不是按 ASIN 查，
// 所以没有 AsinSearchBar，用 KeywordSearchBar。
//
// 四页的数据就绪度不同，响应里的 dataScope 字段会说明口径，
// 前端应原样展示给用户，不要吞掉。
// ====================================================================

/** 游标分页的通用响应外壳 */
export interface CursorResp<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

export interface ConversionItem {
  keyword: string
  statWeek: string | null
  searchVolume: number | null
  clickVolume: number | null
  purchaseVolume: number | null
  searchClickRatio: number | null
  searchPurchaseRatio: number | null
  /** 点击购买率：分母是点击数，区别于 searchPurchaseRatio 的分母是搜索数 */
  clickPurchaseRatio: number | null
  /** ABA Top3 点击集中度（不是「份额」） */
  clickShared: number | null
  conversionShared: number | null
  /** 产品均价三档，页面显示成 "$3.99 $19.15 $79.99" */
  avgKwPrice: number | null
  maxKwPrice: number | null
  minKwPrice: number | null
  source: string | null
}

export interface AmountItem {
  keyword: string
  statWeek: string | null
  estSearchesNum: number | null
  searchesRank: number | null
  /** ⚠️ 是「在售产品数」不是销量 */
  activeListingNum: number | null
  nfAsinNum: number | null
  ppcAsinNum: number | null
  spAsinNum: number | null
  spRecommendedAsinNum: number | null
  recommendedAsinNum: number | null
  brandAsinNum: number | null
  videoAsinNum: number | null
  /** ⚠️ 实测恒 0（AC 是稀缺标）。hasCompeteData=true 时要显示 0 而非空白 */
  acAsinNum: number | null
  top3ClickShare: number | null
  top3ConversionShare: number | null
  /**
   * 竞品数量列是否有数据。
   * false 时那 8 列应显示「—」而不是 0 —— 落表只有 321/22,320 行有竞品数据。
   */
  hasCompeteData: boolean
}

export interface CompeteItem {
  asin: string
  rankPosition: number | null
  title: string | null
  img: string | null
  price: number | null
  ratingNum: number | null
  star: number | null
  score: number | null
  /** ⚠️ 分档字符串如 "6,000+"，不是数值，不要参与计算 */
  boughtInPastMonth: string | null
  nfScoreRatio: number | null
  spScoreRatio: number | null
  spRecScoreRatio: number | null
  brandAdScoreRatio: number | null
  videoAdScoreRatio: number | null
  acScoreRatio: number | null
  hasVariants: boolean | null
  ac: string | null
  /** ⚠️ 抓取日不是数据周：源响应无周维度 */
  fetchedDate: string | null
  source: string | null
}

export interface AcosItem {
  keyword: string
  statWeek: string | null
  matchType: string
  bidStrategy: string
  /** auto=「提升与降低」legacy=「仅降低/固定」 */
  bidStrategyLabel: string
  /** ⚠️ ACOS 三档**递减**：start 是悲观档（值最大） */
  acosStart: number | null
  acosMedian: number | null
  acosEnd: number | null
  /** ⚠️ CPA 三档**递增**，与 ACOS 方向相反，不要共用渲染逻辑 */
  cpaStart: number | null
  cpaMedian: number | null
  cpaEnd: number | null
}

export interface BidItem {
  keyword: string
  categoryId: string
  categoryName: string | null
  categoryHref: string | null
  categorySaleNum: number | null
  matchType: string
  bidStrategy: string
  bidStrategyLabel: string
  statMonth: string | null
  /** ⚠️ 三档**递增**（低/中/高档） */
  bidStart: number | null
  bidMedian: number | null
  bidEnd: number | null
  source: string | null
}

/** 各页共用的查询参数 */
interface WordPickParams {
  keyword?: string
  country?: string
  statWeek?: string
  sortBy?: string
  order?: 'asc' | 'desc'
  cursor?: string
  limit?: number
}

export const wordPickApi = {
  /** 关键词转化率：搜索量 → 点击量 → 购买量漏斗 */
  conversion(p: WordPickParams = {}) {
    return request<CursorResp<ConversionItem> & { country: string; statWeek: string | null }>({
      url: '/business/wordpick/conversion',
      params: { country: dc(), ...p },
    })
  },

  /**
   * 流量位竞品数量。
   * onlyWithCompete=true 只返回有竞品数据的词（落表 321/22,320 行）。
   */
  amount(p: WordPickParams & { onlyWithCompete?: boolean } = {}) {
    return request<CursorResp<AmountItem> & { country: string; statWeek: string | null }>({
      url: '/business/wordpick/amount',
      params: { country: dc(), ...p },
    })
  },

  /**
   * 流量位竞争格局：该词下的 ASIN × 流量位份额。
   * ⚠️ keyword 必填 —— 不传返回空列表 + dataScope 提示。
   */
  compete(p: WordPickParams = {}) {
    return request<
      CursorResp<CompeteItem> & { country: string; keyword: string | null; dataScope: string }
    >({
      url: '/business/wordpick/compete',
      params: { country: dc(), ...p },
    })
  },

  /** ACOS / CPA 三档预估（转化率页的两列） */
  acos(p: WordPickParams & { matchType?: string; bidStrategy?: string } = {}) {
    return request<
      CursorResp<AcosItem> & { country: string; statWeek: string | null; dataScope: string }
    >({
      url: '/business/wordpick/acos',
      params: { country: dc(), ...p },
    })
  },

  /** 建议竞价。⚠️ 响应 isSeed=true 时前端必须显示「模拟数据」标记 */
  bid(
    p: WordPickParams & {
      matchType?: string
      bidStrategy?: string
      categoryId?: string
      statMonth?: string
    } = {},
  ) {
    return request<
      CursorResp<BidItem> & {
        country: string
        statMonth: string | null
        isSeed: boolean
        dataScope: string
      }
    >({
      url: '/business/wordpick/bid',
      params: { country: dc(), ...p },
    })
  },
}

/**
 * ACOS 计算：按用户填的毛利率实时算。
 *
 * ⚠️ 这是前端该做的事，不是后端。审计实测原站 /conversion-rate 页的
 * 「ACOS[自定义毛利率]」列就是前端按用户输入实时算的，那个输入框是必填项。
 * 后端返回的 acosStart/Median/End 只是源侧默认毛利率下的参考值。
 *
 * 公式：ACOS = 广告成本 / 销售额。给定 CPA（每单广告成本）与售价，
 *   ACOS = CPA / 售价
 * 而盈亏平衡的 ACOS 上限就是毛利率 —— ACOS 超过毛利率就亏本。
 *
 * @param cpa   每次购买的广告成本（后端返回的 cpaStart/Median/End 之一）
 * @param price 产品售价
 * @returns ACOS 小数（0.25 = 25%），入参不全时返回 null
 */
export function calcAcos(cpa: number | null, price: number | null): number | null {
  if (cpa === null || price === null || price <= 0) return null
  return cpa / price
}

/**
 * 判断某个 ACOS 是否已经亏本（超过毛利率）。
 * 前端据此把数字标红 —— 这是选词场景最关键的一个判断。
 */
export function isAcosLoss(acos: number | null, grossMargin: number | null): boolean {
  if (acos === null || grossMargin === null) return false
  return acos > grossMargin
}
