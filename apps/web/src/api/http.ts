import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios'
import { ElMessage } from 'element-plus'

/** 后端统一响应信封。注意 code:0 表示成功（不是原站的 code:1） */
export interface ApiResponse<T = any> {
  code: number
  message: string
  data: T
}

const TOKEN_KEY = 'looom_access_token'
const REFRESH_KEY = 'looom_refresh_token'

export const tokenStore = {
  get access() {
    return localStorage.getItem(TOKEN_KEY)
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY)
  },
  set(access: string, refresh: string) {
    localStorage.setItem(TOKEN_KEY, access)
    localStorage.setItem(REFRESH_KEY, refresh)
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_KEY)
  },
}

const http: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30_000,
})

// ---- 请求拦截：自动带 token ----
http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const t = tokenStore.access
  if (t) {
    // 用标准 Bearer 前缀。原站是裸 token，我们按通行规范来
 config.headers.Authorization = `Bearer ${t}`
  }
  return config
})

/**
 * 401 自动刷新
 *
 * 用一个共享的 refreshing Promise 做并发合并：
 * 多个请求同时 401 时只发一次 refresh，其余的等它完成后重放，
 * 否则会打出一串 refresh 请求，且可能互相把对方的 token 顶掉。
 */
let refreshing: Promise<string | null> | null = null

/**
 * 供 axios 拦截器之外的调用方（AI 的 SSE 走裸 fetch，见 api/ai.ts）复用的刷新入口。
 *
 * 必须共用同一个 `refreshing` Promise：否则 SSE 和普通请求同时 401 时会各发
 * 一次 refresh，后完成的那个会把先完成的 token 顶掉，导致其中一路继续 401。
 */
export function refreshAccessToken(): Promise<string | null> {
  refreshing = refreshing ?? doRefresh()
  const p = refreshing
  // 无论成败都清掉，下次 401 能重新发起（与拦截器内的处理保持一致）
  void p.finally(() => {
    if (refreshing === p) refreshing = null
  })
  return p
}

async function doRefresh(): Promise<string | null> {
  const rt = tokenStore.refresh
  if (!rt) return null
  try {
    // 用裸 axios，避免走拦截器造成递归
    const res = await axios.post<ApiResponse<{ accessToken: string; refreshToken: string }>>(
    '/api/auth/refresh',
      { refreshToken: rt },
    )
    if (res.data.code === 0) {
      tokenStore.set(res.data.data.accessToken, res.data.data.refreshToken)
 return res.data.data.accessToken
  }
    return null
  } catch {
    return null
  }
}

http.interceptors.response.use(
  (res) => {
    const body = res.data as ApiResponse
 // 业务失败（HTTP 200 但 code 非 0）也要提示
    if (body && typeof body.code === 'number' && body.code !== 0) {
      ElMessage.error(body.message || '请求失败')
      return Promise.reject(new Error(body.message))
    }
    return res
  },
  async (error) => {
  const cfg = error.config as AxiosRequestConfig & { _retried?: boolean }
const status = error.response?.status

  if (status === 401 && cfg && !cfg._retried) {
      cfg._retried = true
      refreshing = refreshing ?? doRefresh()
      const newToken = await refreshing
      refreshing = null

if (newToken) {
        cfg.headers = { ...cfg.headers, Authorization: `Bearer ${newToken}` }
        return http.request(cfg)
      }

      // 刷新失败：清 token 并回登录页
      tokenStore.clear()
  if (location.pathname !== '/login') {
        location.href = `/login?redirect=${encodeURIComponent(location.pathname)}`
      }
      return Promise.reject(error)
    }

    /**
     * 错误提示文案。
     *
     * ⚠️ 不能无脑用 `error.response.data.message`：
     * 框架级错误（比如路由不存在）返回的是 Express 原始文案
     * `Cannot GET /api/business/xxx`，弹给用户既看不懂又泄露内部路径。
     * P4 实测踩到了这个。
     *
     * 规则：先按状态码给人话；只有后端返回的是**业务错误信息**
     * （我们自己的异常过滤器产生的，不是 "Cannot GET/POST" 这类框架文案）
     * 才优先展示 —— 那些本来就是给用户看的，比如「积分不足」。
     */
    const raw = error.response?.data?.message
    const isFrameworkMsg =
      typeof raw === 'string' &&
      /^Cannot (GET|POST|PUT|PATCH|DELETE)\s/i.test(raw)
    const byStatus =
      status === 400
        ? '请求参数有误'
        : status === 403
   ? '没有权限访问'
   : status === 404
     ? '请求的资源不存在'
     : status === 429
? '操作过于频繁，请稍后再试'
       : status && status >= 500
         ? '服务暂时不可用，请稍后重试'
         : '网络异常，请检查连接后重试'

    const msg = raw && !isFrameworkMsg ? raw : byStatus
    ElMessage.error(msg)
    return Promise.reject(error)
  },
)

/** 业务代码直接拿 data，不用每次剥信封 */
export async function request<T = any>(config: AxiosRequestConfig): Promise<T> {
  const res = await http.request<ApiResponse<T>>(config)
  return res.data.data
}

export default http
