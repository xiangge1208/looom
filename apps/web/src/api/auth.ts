import { request, tokenStore } from './http'

export interface LoginResult {
  accessToken: string
  refreshToken: string
  user: { id: string; email: string }
}

export interface UserInfo {
  id: string
  email: string
  status: number
}

export const authApi = {
  register(payload: { email: string; password: string; nickname: string }) {
    return request<LoginResult>({ url: '/auth/register', method: 'POST', data: payload })
  },

  login(payload: { email: string; password: string }) {
    return request<LoginResult>({ url: '/auth/login', method: 'POST', data: payload })
  },

  me() {
    return request<UserInfo>({ url: '/auth/me', method: 'GET' })
  },

  async logout() {
    const rt = tokenStore.refresh
    if (rt) {
      // 登出失败也要清本地 token，否则用户会卡在「看起来已登录但接口全 401」
      await request({ url: '/auth/logout', method: 'POST', data: { refreshToken: rt } }).catch(
 () => void 0,
      )
    }
    tokenStore.clear()
  },
}
