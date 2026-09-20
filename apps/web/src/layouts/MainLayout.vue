<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { useCreditsStore } from '@/stores/credits'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const credits = useCreditsStore()

// 顶栏要显示余额。放在布局里加载一次，
// 各页面的 AI 卡片扣费后通过 store 推送新值，不用各自再查一遍
onMounted(() => {
  void credits.refresh()
  void credits.loadPricing()
})

/** 侧边导航。按功能分组，与 goal.md 的页面清单对应 */
const navGroups = [
  {
    title: '概览',
    items: [{ name: 'dashboard', label: '概览', icon: '◱' }],
  },
  {
    title: '商品分析',
    items: [
      { name: 'sales', label: '查销量', icon: '↗' },
      { name: 'traffic', label: '查流量结构', icon: '◲' },
      { name: 'variations', label: '查多变体自然位', icon: '⑉' },
      { name: 'timeline', label: '运营时光机', icon: '⟲' },
    ],
  },
  {
    title: '关键词',
    items: [
      { name: 'keywords', label: '反查流量词', icon: '⌕' },
      { name: 'recommendations', label: '查推荐专栏', icon: '☆' },
    ],
  },
  {
    title: '广告与竞品',
    items: [
      { name: 'ads', label: '广告透视', icon: '⊞' },
      { name: 'competitors', label: '竞品对比', icon: '⇄' },
    ],
  },
  {
    title: '其他',
    items: [
      { name: 'diagnosis', label: 'AI 综合诊断', icon: '✦' },
      { name: 'suppliers', label: '供应商搜索', icon: '⚑' },
      { name: 'history', label: '我的查询历史', icon: '⏱' },
    ],
  },
]

const currentName = computed(() => route.name as string)

async function handleLogout() {
  await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
    confirmButtonText: '退出',
    cancelButtonText: '取消',
    type: 'warning',
  })
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="logo">
 <span class="logo-mark">L</span>
        <span class="logo-text">Looom</span>
      </div>

      <nav class="nav">
        <div v-for="g in navGroups" :key="g.title" class="nav-group">
          <div class="nav-group-title">{{ g.title }}</div>
   <RouterLink
     v-for="item in g.items"
     :key="item.name"
     :to="{ name: item.name }"
     class="nav-item"
     :class="{ active: currentName === item.name }"
   >
     <span class="nav-icon">{{ item.icon }}</span>
     <span>{{ item.label }}</span>
          </RouterLink>
 </div>
      </nav>
    </aside>

    <div class="main">
      <header class="topbar">
 <div class="crumb">{{ route.meta.title ?? '' }}</div>
       <div class="topbar-right">
       <RouterLink :to="{ name: 'settings' }" class="credit" title="积分余额">
          <span class="credit-dot">◆</span>
<span class="credit-num">{{ credits.account?.balance ?? '—' }}</span>
          </RouterLink>
   <RouterLink :to="{ name: 'settings' }" class="email">
     {{ auth.user?.email ?? '未登录' }}
   </RouterLink>
   <el-button link size="small" @click="handleLogout">退出</el-button>
 </div>
      </header>

      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.sidebar {
  width: 208px;
  flex-shrink: 0;
  background: #fff;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}

.logo-mark {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--brand-500);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  display: grid;
  place-items: center;
}

.logo-text {
  font-weight: 600;
  letter-spacing: -0.01em;
}

.nav {
  padding: 12px 8px;
}

.nav-group + .nav-group {
  margin-top: 14px;
}

.nav-group-title {
  padding: 0 10px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-500);
  letter-spacing: 0.04em;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: 6px;
  color: var(--ink-700);
  font-size: 13.5px;
  transition: background 0.12s;
}

.nav-item:hover {
  background: var(--ink-100);
}

.nav-item.active {
  background: var(--brand-50);
  color: var(--brand-600);
  font-weight: 500;
}

.nav-icon {
  width: 16px;
  text-align: center;
  font-size: 13px;
  opacity: 0.75;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.topbar {
  height: 52px;
  flex-shrink: 0;
  background: #fff;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.crumb {
  font-size: 14px;
  font-weight: 500;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
}

/* 积分余额。点击进设置页，所以做成链接样式 */
.credit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-700);
  text-decoration: none;
  transition: border-color 0.15s, background 0.15s;
}

.credit:hover {
  border-color: var(--brand-200, var(--brand-100, var(--line)));
  background: var(--brand-50);
}

.credit-dot {
  color: var(--brand-500);
  font-size: 10px;
}

.credit-num {
  font-variant-numeric: tabular-nums;
}

.email {
  font-size: 13px;
  color: var(--ink-500);
}

.email:hover {
  color: var(--brand-500);
}

.content {
  flex: 1;
  overflow-y: auto;
}

/* 窄屏收起侧栏文字，只留图标 */
@media (max-width: 900px) {
  .sidebar {
    width: 56px;
  }

  .logo-text,
  .nav-group-title,
  .nav-item span:not(.nav-icon) {
    display: none;
  }

  .nav-item {
    justify-content: center;
  }
}

/**
 * 极窄屏（<560px）的顶栏保护。
 *
 * 实测在 ~280px 宽时，面包屑标题「我的查询历史」会逐字竖排换行，
 * 把 52px 高的顶栏撑开并与下方内容重叠。
 * 这里让标题单行截断，并把邮箱藏起来（积分余额保留 —— 它更重要且很短）。
 */
@media (max-width: 560px) {
  .crumb {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .email {
    display: none;
  }

  .topbar {
    padding: 0 12px;
    gap: 8px;
  }
}
</style>
