import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig(({ mode }) => {
  // 从项目根目录读 .env（apps/web 的上两级）
  const env = loadEnv(mode, '../../', '')
  const apiPort = env.API_PORT || '3000'
  const webPort = Number(env.WEB_PORT || 5173)

  return {
    plugins: [
    vue(),
      // Element Plus 组件自动引入。
 // importStyle: false —— 不让插件注入每个组件的 CSS：
      //   main.ts 已整体引入 element-plus/dist/index.css，
      //   插件注入的样式会在运行时插到 main.css **之后**，
    //   把我们覆盖的 --el-color-primary 主色顶回 Element 默认蓝。
      AutoImport({ resolvers: [ElementPlusResolver({ importStyle: false })] }),
  Components({ resolvers: [ElementPlusResolver({ importStyle: false })] }),
    ],
 resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: webPort,
      host: '0.0.0.0',
      proxy: {
        // 开发环境把 /api 转给后端，前端代码里就能用相对路径，
        // 免去跨域配置，也让生产环境（同域部署）行为一致
        '/api': {
          target: `http://localhost:${apiPort}`,
     changeOrigin: true,
          // SSE 需要关闭代理缓冲，否则流式内容会被攒着一次性吐出
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
        if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
           proxyRes.headers['x-accel-buffering'] = 'no'
 }
        })
          },
        },
      },
    },
    build: {
   outDir: 'dist',
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
   output: {
          // 把大依赖拆开，避免单个 chunk 过大
        manualChunks: {
    vue: ['vue', 'vue-router', 'pinia'],
         element: ['element-plus'],
            echarts: ['echarts', 'vue-echarts'],
    },
        },
  },
    },
  }
})
