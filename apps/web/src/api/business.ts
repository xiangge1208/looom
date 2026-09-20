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
  keywordId: string
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

  keywordSource(keywordId: string, country = dc(), asin?: string) {
    return request<any>({
      url: `/business/keywords/${keywordId}/source`,
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
