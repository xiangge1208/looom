import { defineStore } from 'pinia'
import { ref } from 'vue'
import { authApi, type UserInfo } from '@/api/auth'
import { setDefaultCountry } from '@/api/business'
import { tokenStore } from '@/api/http'
import { usersApi } from '@/api/user'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserInfo | null>(null)
  const loading = ref(false)
  /** 是否已尝试过恢复登录态，避免路由守卫重复拉取 */
  const initialized = ref(false)

  /**
   * 拉用户偏好里的默认站点，灌进 api 层。
   *
   * `/auth/me` 只返回 id/email/status，不含 defaultCountry，
   * 所以要单独取 profile。失败静默：拿不到就用 'US' 兜底，
   * 不能因为一个偏好项拉取失败就阻断登录流程。
   */
  async function loadPreferences() {
    try {
      const profile = await usersApi.profile()
      setDefaultCountry(profile.defaultCountry)
    } catch {
      // 保持 api 层的 'US' 默认值
    }
  }

  async function login(email: string, password: string) {
    loading.value = true
    try {
      const res = await authApi.login({ email, password })
      tokenStore.set(res.accessToken, res.refreshToken)
      user.value = { id: res.user.id, email: res.user.email, status: 1 }
      initialized.value = true
      // 登录后加载默认站点偏好（不阻塞返回，失败也不影响登录）
      void loadPreferences()
      return res
    } finally {
      loading.value = false
    }
  }

  async function register(email: string, password: string, nickname: string) {
    loading.value = true
    try {
      const res = await authApi.register({ email, password, nickname })
      tokenStore.set(res.accessToken, res.refreshToken)
      user.value = { id: res.user.id, email: res.user.email, status: 1 }
      initialized.value = true
      void loadPreferences()
      return res
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    await authApi.logout()
    user.value = null
    initialized.value = true
  }

  /** 页面刷新后用本地 token 恢复登录态 */
  /**
   * 恢复登录态。
   *
   * force=true 时忽略「已初始化」短路，重新拉一次用户信息 ——
* 改完昵称后顶栏要立刻反映新值，否则得刷新页面才看得到。
   */
  async function restore(force = false) {
    if (initialized.value && !force) return user.value
    initialized.value = true
    if (!tokenStore.access) return null
    try {
      user.value = await authApi.me()
      // 刷新页面后同样要恢复站点偏好，否则查询会退回 US
      void loadPreferences()
    } catch {
      // token 失效，http 拦截器已处理跳转，这里只清状态
      user.value = null
    }
    return user.value
  }

  return { user, loading, initialized, login, register, logout, restore, loadPreferences }
})
