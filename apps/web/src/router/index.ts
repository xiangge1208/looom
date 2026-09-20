import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    /** 页面描述，写进 <meta name="description">。不填用站点默认值 */
    description?: string
    /** true = 免登录页。同时决定是否允许搜索引擎收录 */
    guest?: boolean
  }
}
import { tokenStore } from '@/api/http'
import { useAuthStore } from '@/stores/auth'

/**
 * 路由表
 *
 * 严格按 goal.md 的 16 页清单实现。
 *
 * 路由命名与原站的差异（有意为之）：
 *   原站 /keywords 实际是「以词拓词」，而「反查流量词」在 /reverse。
 *   这里用语义明确的英文路径，避免两套命名混在一起产生歧义。
 *
 * P1 已实现：dashboard / sales / traffic / keywords / ads / variations /
 *            timeline / recommendations / competitors
 * P2 已实现：settings（账户设置 / 积分管理 / API Key）
 * P3 已实现：diagnosis（AI 综合诊断）/ suppliers（占位 UI，仅 seed 数据）/ history
 * P4 待做：加载态、空状态、错误处理、响应式、基础 SEO 的收尾打磨
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/auth/LoginView.vue'),
    meta: {
      title: '登录',
      description: '登录 Looom，查看亚马逊 Listing 的流量结构与广告分析。',
      guest: true,
    },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/auth/RegisterView.vue'),
    meta: {
      title: '注册',
      description: '注册 Looom 账号，开始分析亚马逊 Listing 的销量、流量与广告投放。',
      guest: true,
    },
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '概览' },
      },

      // ---- P1：核心读流程 ----
      {
        path: 'sales',
        name: 'sales',
        component: () => import('@/views/SalesView.vue'),
        meta: {
          title: '查销量',
   description: '按变体维度查看销量趋势与月度走势。',
        },
      },
      {
        path: 'traffic',
        name: 'traffic',
        component: () => import('@/views/TrafficView.vue'),
        meta: {
        title: '查流量结构',
    description: '拆解 Listing 的自然流量与各类广告流量构成比例。',
        },
      },
      {
        path: 'keywords',
        name: 'keywords',
        component: () => import('@/views/KeywordsView.vue'),
        meta: {
    title: '反查流量词',
 description: '反查 ASIN 的流量关键词、自然位排名与流量占比。',
   },
      },
      {
        path: 'variations',
        name: 'variations',
        component: () => import('@/views/VariationsView.vue'),
        meta: { title: '查多变体自然位' },
      },
      {
        path: 'timeline',
        name: 'timeline',
        component: () => import('@/views/TimelineView.vue'),
        meta: { title: '运营时光机' },
      },
      {
        path: 'ads',
        name: 'ads',
        component: () => import('@/views/AdsView.vue'),
        meta: {
          title: '广告透视',
        description: '还原竞品广告架构：活动、投放小组与买家搜索词。',
        },
      },
      {
        path: 'recommendations',
        name: 'recommendations',
        component: () => import('@/views/RecommendationsView.vue'),
        meta: { title: '查推荐专栏' },
      },
      {
        path: 'competitors',
        name: 'competitors',
        component: () => import('@/views/CompetitorsView.vue'),
        meta: { title: '竞品对比' },
      },

      {
        path: 'diagnosis',
        name: 'diagnosis',
        component: () => import('@/views/DiagnosisView.vue'),
        meta: {
  title: 'AI 综合诊断',
        description: '汇总销量、流量、关键词、广告四个维度，给出根因分析与行动计划。',
},
      },
      {
        path: 'suppliers',
        name: 'suppliers',
        component: () => import('@/views/SuppliersView.vue'),
        meta: { title: '供应商搜索' },
      },
      {
        path: 'history',
        name: 'history',
        component: () => import('@/views/HistoryView.vue'),
        meta: { title: '我的查询历史' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '账户设置' },
      },
    ],
  },

  // 错误页。原站有对应页面（500→/maintain、403→/blacklist），我们也补上
  {
    path: '/maintain',
    name: 'maintain',
    component: () => import('@/views/error/MaintainView.vue'),
    meta: { title: '系统维护中', guest: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/error/NotFoundView.vue'),
    meta: { title: '页面不存在', guest: true },
  },
]

const DEFAULT_DESC =
  '面向亚马逊卖家的流量与广告分析工具：查销量、查流量结构、反查流量词、广告架构分析。'

/**
 * 写 <meta name="x" content="y">，不存在就创建。
 *
 * 每次路由切换都覆盖，避免上一个页面的描述残留 ——
 * 分享链接时预览卡片取的就是当前 DOM 里的值。
 */
function setMeta(name: string, content: string) {
  let el = document.head.querySelector(`meta[name="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('name', name)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 切页面回到顶部，否则从长表格跳转会停在中间
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  // ---- 基础 SEO ----
  //
  // 这是个纯前端 SPA，爬虫拿到的初始 HTML 里没有业务内容，
  // 所以这里设的 title / description 主要服务于**分享预览和浏览器历史**，
  // 对搜索引擎收录的作用有限（真要做 SEO 得上 SSR，超出本期范围）。
  //
  // 业务页面统一 noindex：页面内容都需要登录且是用户私有的查询结果，
  // 被收录既无意义也可能泄露数据。只有登录/注册页允许收录。
  document.title = to.meta.title ? `${to.meta.title} — Looom` : 'Looom'
  setMeta('description', (to.meta.description as string) ?? DEFAULT_DESC)
  setMeta('robots', to.meta.guest === true ? 'index,follow' : 'noindex,nofollow')

  const isGuestPage = to.meta.guest === true

  if (!isGuestPage && !tokenStore.access) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (tokenStore.access) {
    const auth = useAuthStore()
    await auth.restore()
    if (isGuestPage && to.name !== 'maintain' && to.name !== 'not-found' && auth.user) {
      return { name: 'dashboard' }
    }
  }

  return true
})

export default router
