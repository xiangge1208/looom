/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/** 路由 meta 的类型声明，避免 route.meta.title 报类型错误 */
declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    /** 游客可访问（无需登录） */
    guest?: boolean
    /** 该页面计划实现的阶段，占位页用 */
 stage?: string
  }
}

export {}
