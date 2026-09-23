import { Transform } from 'class-transformer'
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

/**
 * 13 个亚马逊站点。
 * 来源：实测原站 axios 拦截器对所有业务请求强制追加 country，支持这 13 个。
 */
export const COUNTRIES = [
  'US', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP', 'CA', 'MX', 'AU', 'AE', 'SA', 'BR',
] as const

/**
 * 时间粒度。
 *
 * 实测结论：
 *   month —— 唯一可用，格式 YYYY-MM。库内实测 time_piece_type 全为 'month'
 *   day   —— 多变体自然位是日粒度，但那个接口本身没有 timePiece 参数
 *             （它直接返回 dates 数组），所以不走 TimePieceQueryDto
 *   week  —— 声明可用但非广告域实测报「服务异常」，不实现
 *
 * 曾经导出过 TIME_PIECE_TYPES = ['month','day']，但 'day' 在所有走
 * TimePieceQueryDto 的接口上都没有数据、且下游 SQL 写死 month，
 * 留着只会让调用方以为能传。已移除，取值直接内联在 @IsIn 里。
 */

/** ASIN 格式：10 位大写字母数字，B0 开头是常见形态但不强制 */
const ASIN_RE = /^[A-Z0-9]{10}$/

/**
 * 匹配方式与投放策略（M13 ACOS/竞价两页共用）。
 *
 * ⚠️ 2026-09-21 返工：原先是 6 个拼接值（`autoForSales_broad` 等），
 * 直接照抄 web-keyword-conversion 的 JSON 键名。schema-07 把库里的
 * `match_type` 列拆成了 `match_type` × `bid_strategy` 两维，
 * 对外参数也跟着拆 —— 拼接值不再接受。
 *
 * 拆分对应：`autoForSales_exact` → matchType=exact, bidStrategy=auto
 *
 * 之所以拆：真正的「建议竞价」表（fact_keyword_bid_estimate）主键是
 * (keyword, country, category_id, match_type, bid_strategy, stat_month)，
 * 两张表维度对齐后 service 只写一套解析。
 *
 * ⚠️ 必须定义在使用它的类之前 —— @IsIn 是装饰器，
 * 在类定义求值时就要读到这个常量，放在文件末尾会得到 undefined。
 */
export const MATCH_TYPES = ['broad', 'phrase', 'exact'] as const

/** auto=自动投放 legacy=手动投放。原站已把「仅降低」与「固定」合并为一档 */
export const BID_STRATEGIES = ['auto', 'legacy'] as const

export class AsinQueryDto {
  @IsString({ message: 'asin 不能为空' })
  @Matches(ASIN_RE, { message: 'ASIN 格式不正确（应为 10 位大写字母或数字）' })
  asin: string

  @IsOptional()
  @IsIn(COUNTRIES as unknown as string[], { message: '不支持的站点代码' })
  country?: string = 'US'
}

export class TimePieceQueryDto extends AsinQueryDto {
  /**
   * 时间粒度。
   *
   * ⚠️ 目前**只接受 month**，传其他值直接报错。
   *
   * 原因：这些事实表（fact_asin_traffic_channel / fact_asin_keyword_snapshot 等）
   * 实测库内 time_piece_type 全部是 'month'，day 与 week 零行。
   * 早先这里允许 'day'，但下游 SQL 写死 `time_piece_type = 'month'`，
   * 传 day 会被**静默忽略**并返回月度数据 —— 用户以为看的是日数据，其实不是，
   * 这比直接报错更糟。等真有日粒度数据入库，再把 'day' 加回来并同步改 SQL。
   */
  @IsOptional()
  @IsIn(['month'], {
    message: '时间粒度目前只支持 month（day/week 暂无数据，week 原站实测不可用）',
  })
  timePieceType?: string = 'month'

  /** month 格式 YYYY-MM */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}(-\d{2})?$/, { message: '时间值格式应为 YYYY-MM 或 YYYY-MM-DD' })
  timePieceValue?: string
}

export class CursorQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt({ message: 'limit 必须是整数' })
  @Min(1)
  @Max(100, { message: 'limit 最大 100' })
  limit?: number
}

/** 反查流量词等列表接口：ASIN + 时间片 + 游标 + 排序 */
export class KeywordListDto extends TimePieceQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  /** 关键词模糊搜索。Doris 上走倒排索引 */
  @IsOptional()
  @IsString()
  keyword?: string

  @IsOptional()
  @IsIn(['score', 'rank', 'searches'], { message: '不支持的排序字段' })
  sortBy?: string = 'score'

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: string = 'desc'
}

/**
 * 供应商搜索（P3）
 *
 * 字段按 seed 的通用货源字段设计（关键词/地区/价格区间）——
 * 侦察阶段没有 1688 域的真实响应，所以这些不是实测字段。
 * goal.md 也明确本期只做占位，不接真实数据源。
 */
export class SupplierSearchDto {
  /** 匹配供应商名或货源标题 */
  @IsOptional()
  @IsString()
  keyword?: string

  /** 精确匹配地区，如「深圳」。可选值走 /suppliers/locations */
  @IsOptional()
  @IsString()
  location?: string

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsNumber({}, { message: 'minPrice 必须是数字' })
  @Min(0)
  minPrice?: number

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsNumber({}, { message: 'maxPrice 必须是数字' })
  @Min(0)
  maxPrice?: number

  @IsOptional()
  @IsString()
  cursor?: string

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}

/**
 * M13 选词 / 关键词竞争分析（4 个页面共用）
 *
 * 与 AsinQueryDto 的区别：这几个页面是**按关键词查**而不是按 ASIN 查，
 * 所以主参数是 keyword。ASIN 那套 10 位格式校验在这里不适用。
 *
 * keyword 归一：ETL 侧统一 btrim(lower())（schema-04 的规则），
 * 所以这里也要小写化后再查，否则大写输入查不到。
 */
export class WordPickQueryDto extends CursorQueryDto {
  /**
   * 关键词。可选 —— 不传时返回该站点的榜单（按销量/搜索量排序），
   * 传了则精确匹配单词。实测 dim_keyword 最长 128 字符。
   */
  @IsOptional()
  @IsString()
  @MaxLength(128, { message: '关键词最长 128 字符' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  keyword?: string

  @IsOptional()
  @IsIn(COUNTRIES as unknown as string[], { message: '不支持的站点代码' })
  country?: string = 'US'

  /** ABA 周起始日。不传用库里最新一周 */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '周起始日格式应为 YYYY-MM-DD' })
  statWeek?: string

  /**
   * 只返回有竞品数量数据的词（/amount 页用）。
   *
   * 默认 false —— 竞品数量列落表只有 318/22,320 行（compete 源覆盖面窄），
   * 默认开启会让用户以为库里只有 318 个词。
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  onlyWithCompete?: boolean

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'order 只能是 asc 或 desc' })
  order?: string = 'desc'

  /**
   * 排序字段。各页可用值不同，具体白名单在 wordpick.service.ts 里，
   * 这里只校验是字符串 —— 白名单校验放 service 是因为 4 个页面的可排序列不同，
   * 塞进 DTO 会变成一个大杂烩的 @IsIn。
   */
  @IsOptional()
  @IsString()
  sortBy?: string
}

/**
 * ACOS/CPA 页（/conversion-rate 的三档预估）专用：匹配方式 + 投放策略两维筛选。
 *
 * 两者都不传则返回该词的全部组合（最多 6 行，实测 13% 的词只有 3 行 ——
 * 只有 auto 或只有 legacy，见 wordpick.service.ts 的口径说明）。
 */
export class AcosEstimateQueryDto extends WordPickQueryDto {
  @IsOptional()
  @IsIn(MATCH_TYPES as unknown as string[], {
    message: '匹配方式只能是 broad / phrase / exact',
  })
  matchType?: string

  @IsOptional()
  @IsIn(BID_STRATEGIES as unknown as string[], {
    message: '投放策略只能是 auto / legacy',
  })
  bidStrategy?: string
}

/**
 * 建议竞价页（/cpc-browsetree）专用：比 ACOS 多一个**类目**维。
 *
 * ⚠️ 类目是这个指标的核心维度 —— 原站页面说明第 1 条明确
 * 「建议竞价与产品无关，与品类强相关」。不带类目的竞价数字没有意义。
 * ⚠️ 本页数据是 seed（源 search/cpc/category 未爬），前端需显示「模拟数据」标记。
 */
export class BidEstimateQueryDto extends AcosEstimateQueryDto {
  /** 类目 ID。不传返回该词的全部类目（实测每词 4~14 个，均值 10.3） */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  categoryId?: string

  /** 统计月 YYYY-MM。竞价每月更新一次，不用周 */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: '统计月格式应为 YYYY-MM' })
  statMonth?: string
}
