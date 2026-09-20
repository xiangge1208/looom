import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  MinLength,
} from 'class-validator'
import { Type } from 'class-transformer'

/** 游标分页的公共参数 */
export class PageQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 32, { message: '昵称长度需在 1-32 字符之间' })
  nickname?: string

  @IsOptional()
  @IsString()
  avatarUrl?: string

  @IsOptional()
  @IsString()
  defaultCountry?: string
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1, { message: '请输入旧密码' })
  oldPassword!: string

  @IsString()
  @MinLength(8, { message: '新密码至少 8 位' })
  newPassword!: string
}

export class CreateApiKeyDto {
  @IsString()
  @Length(1, 32, { message: '名称长度需在 1-32 字符之间' })
  name!: string

  /** 不传表示永不过期 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number
}

export class QueryLogsDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['asin', 'keyword', 'supplier'], { message: '不支持的查询类型' })
  queryType?: string
}

export class TransactionsDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['recharge', 'consume', 'refund', 'gift', 'expire'], {
    message: '不支持的流水类型',
  })
  type?: string
}
