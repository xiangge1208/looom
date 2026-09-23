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

/** 分变体/分属性的流量结构表格 */
export interface TrafficVariantRow {
  /** 行标识：变体模式下是 ASIN，属性模式下是属性取值 */
  key: string
  /** 仅变体模式有 */
  asin?: string
  /** 仅属性模式有 */
  dimensionValue?: string
  memberCount?: number
  memberAsins?: string[]
  img: string | null
  title?: string | null
  features?: Record<string, string>
  total: number
  /** 各渠道得分 + 占**本行 total** 的构成比（堆积图用） */
  channels: Record<string, { score: number; ratio: number | null }>
  /** 本行 total ÷ 全部行 total 之和 */
  totalShare: number | null
  /** 各渠道的**列内占比**：本行该渠道 ÷ 全部行该渠道之和（原站表头口径） */
  channelShares: Record<string, number | null>
}

export interface TrafficVariants {
  dimension: string
  /** 该商品可用的属性维度，如 ["Color","Size"] */
  dimensions: string[]
  timePieceValue?: string
  rows: TrafficVariantRow[]
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

// ---- 查推荐专栏 ----
//
// 对应原站 /recommend。契约见 docs/SPEC_REC_COLUMN_UI.md §6。
//
// ⚠️ 当前数据层只支撑一部分列（见 docs/AUDIT_REC_COLUMN_DATA.md）：
//   ratio        ✅ 有源（ops_get_listing_traffic_overview 的 recommend 对象）
//   campaignCnt  ⚠️ 该源不提供，为 null —— 前端必须显示「—」而不是 0
//   keywordCnt   ⚠️ 同上
//   按天趋势     ⚠️ 需 ETL 扩展，暂无
// 所以 null 与 0 必须区别渲染：0 是「真的没有」，null 是「我们没这个数据」。

export interface RecColumnRow {
  /** 专栏英文原文，也是原站请求参数 */
  recTitle: string
  /** 中文展示名。专栏是动态实体，没有中文名时回落英文原文 */
  name: string
  shortCode: string
  /** 流量占比（0~1 小数）。同组各专栏相加为 1 */
  ratio: number | null
  /** 广告活动数。null = 数据源不提供，不要渲染成 0 */
  campaignCount: number | null
  /** 广告词数。null 同上 */
  keywordCount: number | null
  /** 按天趋势序列。null 元素 = 当天该专栏无曝光（画图要断线，不能补 0） */
  campaignTrends?: (number | null)[] | null
  keywordTrends?: (number | null)[] | null
  /** 行尾当前数：取最近有效值，不是数组末位（末位可能是 null） */
  lastCampaignCount?: number | null
  lastKeywordCount?: number | null
}

export interface RecColumnData {
  asin: string
  country: string
  /** 数据截止日 */
  statDate: string | null
  /** 趋势序列共用的日期轴（与 campaignTrends/keywordTrends 同长同序） */
  dates: string[]
  /** 三个计数卡 */
  overview: {
    recCount: number
    campaignCount: number | null
    keywordCount: number | null
  }
  columns: RecColumnRow[]
  /**
   * 数据完备度标记，供前端决定哪些列显示「数据待补」。
   * 不靠前端猜 —— 后端知道自己查了什么表。
   */
  coverage: {
    hasRatio: boolean
    hasCounts: boolean
    hasTrends: boolean
  }
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

/** 数组元素可空 —— 稀疏日（当天无秒杀/无 SB 曝光）是 null 不是 0，画图要断线 */
type Series = (number | null)[]

/**
 * 日粒度序列。dates 是时间轴，各指标数组与它**等长同序、按下标对齐**。
 * events 例外：它是稀疏点列表（只含真正有事件的天）。
 */
export interface DailyTrend {
  asin: string
  country: string
  days: number
  dates: string[]
  price: {
    buybox: Series
    deal: Series
    /** 稀疏：实测 356 天仅 36 天有秒杀 */
    ld: Series
    /** 秒杀原始串，含时段信息，如 "14.99_0_当日19:35-次日07:35" */
    ldRaw: (string | null)[]
    prime: Series
  }
  traffic: {
    total: Series
    nf: Series
    nfRatio: Series
    ad: Series
    adRatio: Series
    sp: Series
    recSp: Series
    sb: Series
    sbv: Series
  }
  rank: {
    /** 大类 BSR */
    bsr: Series
    /** 小类 BSR */
    subBsr: Series
    catName: string | null
    subBsrCat: string | null
  }
  reputation: { star: Series; reviewNum: Series; sellerNum: Series }
  /** 运营事件（稀疏，不与 dates 等长） */
  events: Array<{
    date: string
    titleImg: number | null
    coupon: string | null
    promotion: string | null
    woot: number | null
    buyboxSeller: string | null
  }>
  boughtInPastMonth: Series
}

export interface KeywordAttribution {
  asin: string
  country: string
  granularity: string
  statDate: string | null
  /** 无数据时给出原因说明，不要把空表显示成「无变化」 */
  dataScope?: string
  items: Array<{
    keyword: string
    translateKeyword: string | null
    /** 流量变化量，可负 */
    contriChange: number | null
    contriChangeRatio: number | null
    contriChangeTotal: number | null
    score: number | null
    scoreBefore: number | null
    scoreRatio: number | null
    searchVolume: number | null
    searchRank: number | null
    /** 预格式化的中文原因，可直接渲染。null = 源未归因 */
    reasonSummary: string | null
    changeReasons: string | null
    positive: number | null
  }>
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

  /**
   * 该 ASIN 有流量数据的月份列表（倒序）。
   * 「流量时光机」用它填充月份选择器 —— 只列确实有数据的月，避免用户选到空月。
   */
  trafficMonths(asin: string, country = dc()) {
    return request<{ asin: string; country: string; isGroup: boolean; months: string[] }>({
      url: '/business/traffic/months',
      params: { asin, country },
    })
  },

  trafficVariants(asin: string, country = dc(), dimension?: string) {
    return request<TrafficVariants>({
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
    /** 排序方向。后端一直支持，之前前端没传，导致表头「升序」点了没反应 */
    order?: 'asc' | 'desc'
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

  /**
   * 日粒度序列。一个端点服务两张图（60 天价格复合图 / 83 天因果图），
   * 差别只在 days —— 数据是同一份，不要各自再取一遍。
   *
   * 返回「dates[] 时间轴 + 各指标等长数组」，按下标对齐；
   * events 是**稀疏点列表**（只含真正有事件的天），不与 dates 等长。
   */
  trafficDaily(asin: string, days = 60, country = dc()) {
    return request<DailyTrend>({
      url: '/business/traffic/daily',
      params: { asin, days, country },
    })
  },

  /** 流量变化归因（关键词 / 流量变化 / 影响原因） */
  keywordAttribution(params: {
    asin: string
    country?: string
    granularity?: 'month' | 'day'
    statDate?: string
    limit?: number
  }) {
    return request<KeywordAttribution>({
      url: '/business/keywords/attribution',
      params: { country: dc(), ...params },
    })
  },

  /** ABA 搜索趋势（自身量 + 词根综合量 + 排名）。本期只有端点，页面下一期 */
  abaTrend(keyword: string, country = dc(), granularity = 'week') {
    return request<{
      keyword: string
      periods: number
      dates: string[]
      searchesNum: (number | null)[]
      extSearchesNum: (number | null)[]
      searchesRank: (number | null)[]
    }>({
      url: `/business/keywords/${encodeURIComponent(keyword)}/aba-trend`,
      params: { country, granularity },
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

  /**
   * 查推荐专栏。
   *
   * 沿用既有路由 /business/recommendations（原站 /recommend）——
   * 不新开一个页面：仓库里 RecommendationsView 的标题已经是「查推荐专栏」，
   * 再建一个会让同一导航下出现两个同名页。
   */
  recommendations(asin: string, country = dc()) {
    return request<RecColumnData>({
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
