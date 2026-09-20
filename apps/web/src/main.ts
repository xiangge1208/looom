import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import './styles/main.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)

/**
 * 全局错误兜底
 *
 * 为什么需要：在此之前，组件渲染期抛出的异常会让整个页面白屏，
 * 控制台之外没有任何提示。接口错误有 axios 拦截器兜着，
 * 但**渲染错误**（比如某字段结构和预期不符导致的 undefined 访问）没人管。
 *
 * 这里只做「记录 + 提示」，不尝试恢复渲染 ——
 * 组件树已经处于不一致状态，硬恢复容易掩盖真实问题。
 * 提示文案刻意不暴露技术细节，具体堆栈留在 console 给开发看。
 */
app.config.errorHandler = (err, _instance, info) => {
  // eslint-disable-next-line no-console
  console.error('[Vue 渲染错误]', info, err)
  // 动态导入避免在应用启动早期就把 Element Plus 的消息组件拉进主包
  void import('element-plus').then(({ ElMessage }) => {
    ElMessage.error('页面出现异常，请刷新重试')
  })
}

/** 未捕获的 Promise 拒绝。axios 拦截器已提示过的会重复，所以只记日志 */
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[未处理的 Promise 拒绝]', e.reason)
})

app.use(createPinia())
app.use(router)
// 中文语言包，让 Element Plus 的分页、日期选择器等内置文案是中文
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')
