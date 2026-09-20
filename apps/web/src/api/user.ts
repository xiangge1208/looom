import { request } from './http'

export interface CreditAccount {
  userId: string
  balance: number
  totalRecharged: number
  totalConsumed: number
  frozen: number
  channel: string
  integralLimit: number | null
  version: number
  updatedAt: string | null
}

export interface CreditTx {
  id: string
  type: 'recharge' | 'consume' | 'refund' | 'gift' | 'expire'
  amount: number
  balanceAfter: number
  bizType: string | null
  bizId: string | null
  remark: string | null
  createdAt: string
}

export interface UserProfile {
  id: string
  email: string
  nickname: string
  avatarUrl: string | null
  status: number
  defaultCountry: string
  lastLoginAt: string | null
  lastLoginIp: string | null
  createdAt: string
}

export interface ApiKeyItem {
  id: string
  name: string
  keyPrefix: string
  scopes: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  /** 三态由后端判定，前端不要自己按日期算 */
  status: 'active' | 'expired' | 'revoked'
  createdAt: string
}

export interface QueryLogItem {
  id: string
  queryType: string
  queryValue: string
  country: string
  pageRoute: string | null
  creditsCost: number
  resultCount: number | null
  durationMs: number | null
  success: boolean
  errorMsg: string | null
  createdAt: string
}

interface Page<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

/** 积分相关接口 */
export const creditsApi = {
  balance: () => request<CreditAccount>({ url: '/credits/balance' }),

  transactions: (
    params: { cursor?: string; limit?: number; type?: string } = {},
  ) => request<Page<CreditTx>>({ url: '/credits/transactions', params }),

  /** 计价表。按钮上「消耗 N 积分」的提示用它，避免前端硬编码价格 */
  pricing: () =>
    request<{ items: { bizType: string; cost: number }[] }>({
      url: '/credits/pricing',
    }),
}

/** 用户中心接口 */
export const usersApi = {
  profile: () => request<UserProfile>({ url: '/users/me/profile' }),

  updateProfile: (data: {
  nickname?: string
    avatarUrl?: string
defaultCountry?: string
  }) =>
    request<UserProfile>({ url: '/users/me/profile', method: 'PATCH', data }),

  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    request<{ ok: boolean; message: string }>({
   url: '/users/me/password',
      method: 'POST',
      data,
    }),

  stats: () =>
  request<{
      totalQueries: number
      recentQueries: {
        queryType: string
        queryValue: string
        country: string
createdAt: string
      }[]
    }>({ url: '/users/me/stats' }),

  queryLogs: (
  params: { cursor?: string; limit?: number; queryType?: string } = {},
  ) => request<Page<QueryLogItem>>({ url: '/users/me/query-logs', params }),

  apiKeys: () => request<{ items: ApiKeyItem[] }>({ url: '/users/me/api-keys' }),

  /** ⚠️ 返回的 key 是明文，仅此一次，前端必须提示用户立即保存 */
  createApiKey: (data: { name: string; expiresInDays?: number }) =>
    request<ApiKeyItem & { key: string }>({
      url: '/users/me/api-keys',
      method: 'POST',
      data,
    }),

  revokeApiKey: (id: string) =>
    request<{ ok: boolean; message: string }>({
      url: `/users/me/api-keys/${id}`,
      method: 'DELETE',
    }),
}
