import { defineStore } from 'pinia'
import { ref } from 'vue'
import { creditsApi, type CreditAccount } from '@/api/user'

/**
 * 积分状态
 *
 * 顶栏的余额和各页面 AI 卡片共用这一份数据。
 *
 * 余额刷新有两条路径：
 *   1. `refresh()` 主动查接口 —— 首次进入、切页面时用
 *   2. `setBalance()` 由 SSE 事件推 —— AI 分析开始/失败退款时用
 *
 * 第 2 条是关键：AI 流里已经带回了扣费后余额，
 * 不用再额外发一次请求，也避免「扣了但顶栏没变」的视觉不一致。
 */
export const useCreditsStore = defineStore('credits', () => {
  const account = ref<CreditAccount | null>(null)
  const loading = ref(false)
  /** 各功能计价，key 是 bizType */
  const pricing = ref<Record<string, number>>({})

  async function refresh() {
    loading.value = true
    try {
      account.value = await creditsApi.balance()
    } catch {
      // 余额查询失败不该打断页面，保持上一次的值
    } finally {
      loading.value = false
    }
  }

  /** 计价表变动极少，只拉一次 */
  async function loadPricing() {
    if (Object.keys(pricing.value).length) return
    try {
      const res = await creditsApi.pricing()
      const map: Record<string, number> = {}
    for (const i of res.items) map[i.bizType] = i.cost
      pricing.value = map
    } catch {
      // 拉不到就留空，前端按「未知价格」处理，不要假设免费
    }
  }

  /** 由 SSE 事件直接更新余额，避免多余的请求 */
  function setBalance(balance: number) {
    if (account.value) {
      account.value = { ...account.value, balance }
    }
  }

  function costOf(bizType: string): number | null {
    return pricing.value[bizType] ?? null
  }

  return { account, loading, pricing, refresh, loadPricing, setBalance, costOf }
})
