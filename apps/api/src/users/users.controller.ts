import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard, User } from '../auth/jwt-auth.guard'
import type { CurrentUser } from '../auth/jwt.strategy'
import { UsersService } from './users.service'
import {
  ChangePasswordDto,
  CreateApiKeyDto,
  QueryLogsDto,
  UpdateProfileDto,
} from './dto/user.dto'

/**
 * 用户中心
 *
 * 对应 goal.md 第 16 页 /settings。积分相关在 /api/credits 下，
 * 这里只管资料、密码、API Key、查询历史。
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me/profile')
  profile(@User() user: CurrentUser) {
    return this.users.getProfile(user.id)
  }

  @Patch('me/profile')
  updateProfile(@User() user: CurrentUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto)
  }

  @Post('me/password')
  changePassword(@User() user: CurrentUser, @Body() dto: ChangePasswordDto) {
    return this.users.changePassword(user.id, dto.oldPassword, dto.newPassword)
  }

  /** 概览页统计：查询总次数 + 最近查询 */
  @Get('me/stats')
  stats(@User() user: CurrentUser) {
    return this.users.getOverviewStats(user.id)
  }

  /** 我的查询历史，游标分页 */
  @Get('me/query-logs')
  queryLogs(@User() user: CurrentUser, @Query() dto: QueryLogsDto) {
    return this.users.listQueryLogs(user.id, {
      cursor: dto.cursor,
      limit: dto.limit,
      queryType: dto.queryType,
    })
  }

  // ---- API Key ----

  @Get('me/api-keys')
  listKeys(@User() user: CurrentUser) {
    return this.users.listApiKeys(user.id)
  }

  /** ⚠️ 响应里的 key 字段是明文，仅此一次返回 */
  @Post('me/api-keys')
  createKey(@User() user: CurrentUser, @Body() dto: CreateApiKeyDto) {
    return this.users.createApiKey(user.id, dto.name, dto.expiresInDays)
  }

  @Delete('me/api-keys/:id')
  revokeKey(@User() user: CurrentUser, @Param('id') id: string) {
    return this.users.revokeApiKey(user.id, id)
  }
}
