import { Module } from '@nestjs/common'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

/**
 * 用户中心模块
 *
 * 导出 UsersService 是为了让业务模块能调 logQuery() 写查询审计。
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
