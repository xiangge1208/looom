import { Transform } from 'class-transformer'
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
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
 *   month —— 可用，格式 YYYY-MM
 *   day   —— 多变体自然位专用，该接口无 timePiece 参数
 *   week  —— 声明可用但非广告域实测报「服务异常」，我们不实现（见 system_configs 开关）
 */
export const TIME_PIECE_TYPES = ['month', 'day'] as const

/** ASIN 格式：10 位大写字母数字，B0 开头是常见形态但不强制 */
const ASIN_RE = /^[A-Z0-9]{10}$/

export class AsinQueryDto {
  @IsString({ message: 'asin 不能为空' })
  @Matches(ASIN_RE, { message: 'ASIN 格式不正确（应为 10 位大写字母或数字）' })
  asin: string

  @IsOptional()
  @IsIn(COUNTRIES as unknown as string[], { message: '不支持的站点代码' })
  country?: string = 'US'
}

export class TimePieceQueryDto extends AsinQueryDto {
  @IsOptional()
  @IsIn(TIME_PIECE_TYPES as unknown as string[], {
message: '时间粒度只支持 month 或 day（week 原站实测不可用）',
  })
  timePieceType?: string = 'month'

  /** month 格式 YYYY-MM；day 格式 YYYY-MM-DD */
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
