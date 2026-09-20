import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard, User } from '../auth/jwt-auth.guard'
import type { CurrentUser } from '../auth/jwt.strategy'
import { CreditsService } from './credits.service'
import { TransactionsDto } from '../users/dto/user.dto'

/**
 * 积分接口
 *
 * 只读。充值入口不做 —— goal.md 明确「不要引入需要我付费的第三方服务」，
 * 接支付网关超出范围。测试额度直接由 seed 灌。
 */
@Controller('credits')
@UseGuards(JwtAuthGuard)
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  /** 账户余额 */
  @Get('balance')
  balance(@User() user: CurrentUser) {
    return this.credits.getAccount(user.id)
  }

  /** 积分流水，游标分页 */
  @Get('transactions')
  transactions(@User() user: CurrentUser, @Query() dto: TransactionsDto) {
    return this.credits.listTransactions(user.id, {
      cursor: dto.cursor,
      limit: dto.limit,
      type: dto.type,
    })
  }

  /**
   * 计价表。前端在按钮上提示「本次消耗 N 积分」要用，
   * 免得把价格硬编码在前端两处。
   *
   * ⚠️ 这里只列**实际会扣费**的业务项。
   * 之前还下发了 reverse_keyword / query_sales / query_traffic，
   * 但全仓唯一的 credits.spend() 调用点是 ai.service.ts 的 ai_analysis，
   * 那三项在 system_configs 里有价格却从不扣费（业务查询 track() 恒传
   * creditsCost=0）。对外报价却永不收费会让用户以为自己在被计费，
   * 属于界面说谎。等真的接上扣费再把对应项加回来。
   */
  @Get('pricing')
  async pricing() {
    const BILLED = ['ai_analysis']
    const items = await Promise.all(
      BILLED.map(async (k) => ({ bizType: k, cost: await this.credits.getCost(k) })),
    )
    return { items }
  }
}
