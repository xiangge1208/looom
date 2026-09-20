import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { DorisService } from './doris.service'

/**
 * 数据库模块（全局）
 *
 * 用 mysql2 直连 Doris（Doris 兼容 MySQL 协议）。
 * 不用 ORM：Doris 缺少 ORM 依赖的能力（外键、事务、自增主键），
 * 硬套 ORM 会产生大量不被支持的 SQL，不如显式写查询。
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [DorisService],
  exports: [DorisService],
})
export class DatabaseModule {}
