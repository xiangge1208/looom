<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useCreditsStore } from '@/stores/credits'
import { usersApi } from '@/api/user'

/**
 * 概览页
 *
 * 注意：原站**没有** dashboard 页面，这是 goal.md 的原创设计
 * （goal.md 第 2 页「概览：最近查询记录、积分余额、快速查询入口、使用指南」）。
 *
 * 这里不放 AI 卡片：原先 P0 时为验证 SSE 链路放了一个，
 * 但它传的 `channels` 恒为空数组 —— 模型拿不到任何流量数据，
 * 只能产出空泛内容，反而误导用户以为「AI 分析没用」。
 * AI 分析要在有数据的页面上做，概览只负责导流。
 */
const router = useRouter()
const auth = useAuthStore()
const credits = useCreditsStore()

const asin = ref('')
const totalQueries = ref(0)
const recent = ref<
  { queryType: string; queryValue: string; country: string; createdAt: string | null }[]
>([])
const loadingStats = ref(false)

/**
 * AI 分析单价提示。
 *
 * 价格必须来自后端计价表（credits.costOf），不能写死 ——
 * 之前这里硬编码「AI 分析 5 积分/次」，改价格就会和实际扣费不一致。
 * 计价表还没加载好时返回空串，避免闪现一个错的数字。
 */
const aiCostHint = computed(() => {
  const cost = credits.costOf('ai_analysis')
  return cost === null ? '' : `AI 分析 ${cost} 积分/次`
})

/**
 * 快速入口。
 *
 * ⚠️ name 必须与 router 里的路由名严格一致。
 * 这里原先写的是 `ads-campaigns`，而实际路由名是 `ads` ——
 * 点击会直接抛路由错误。改名时漏了这处，靠审查才发现。
 */
const quickEntries = [
  { name: 'sales', label: '查销量', desc: '看变体销量趋势与月度走势', icon: '↗' },
  { name: 'traffic', label: '查流量结构', desc: '自然与广告流量的构成比例', icon: '◲' },
  { name: 'keywords', label: '反查流量词', desc: '找出带来流量的所有关键词', icon: '⌕' },
  { name: 'ads', label: '广告透视', desc: '还原竞品的广告活动结构', icon: '⊞' },
  { name: 'diagnosis', label: 'AI 综合诊断', desc: '四个维度汇总的根因分析', icon: '✦' },
  { name: 'competitors', label: '竞品对比', desc: '多个 ASIN 指标并排比较', icon: '⇄' },
]

function go(name: string) {
  router.push({ name, query: asin.value.trim() ? { asin: asin.value.trim() } : undefined })
}

/**
 * 点历史记录跳回去重查。
 *
 * 按 queryType 分派，不能一律当 ASIN 处理：
 *   - keyword 类型的 queryValue 是关键词文本，塞进 asin 参数会被
 *     后端 ASIN 正则挡下返回 400（之前就是这个 bug）；
 *   - supplier 类型 SuppliersView 根本不读 query，带参数没有意义，
 *     所以只跳页不传参。
 */
function replay(item: { queryType: string; queryValue: string; country: string }) {
  if (item.queryType === 'supplier') {
    router.push({ name: 'suppliers' })
    return
  }
  if (item.queryType === 'keyword') {
    // 反查流量词页当前按 ASIN 维度查询，没有「按词文本反查」入口，
    // 所以这里只把用户送到该页，不传会导致 400 的参数。
    router.push({ name: 'keywords' })
    return
  }
  router.push({
    name: 'sales',
    query: { asin: item.queryValue, country: item.country },
  })
}

const TYPE_LABEL: Record<string, string> = {
  asin: 'ASIN',
  keyword: '关键词',
  supplier: '供应商',
}

onMounted(async () => {
  loadingStats.value = true
  try {
    // 并行拉，任一失败不影响另一个
    const [stats] = await Promise.allSettled([
      usersApi.stats(),
      credits.refresh(),
      // 计价表供 aiCostHint 使用；store 内部有「已加载则跳过」的短路
      credits.loadPricing(),
    ])
    if (stats.status === 'fulfilled') {
      totalQueries.value = stats.value.totalQueries
      recent.value = stats.value.recentQueries
    }
  } finally {
    loadingStats.value = false
  }
})
</script>

<template>
  <div class="page">
    <h1 class="page-title">概览</h1>
    <p class="page-desc">
      欢迎回来{{ auth.user?.email ? `，${auth.user.email}` : '' }}。输入 ASIN 开始分析。
    </p>

    <!-- 快速查询 -->
    <div class="card search-card">
      <el-input
        v-model="asin"
 placeholder="粘贴 ASIN，例如 B0SEEDSSP0"
        size="large"
 clearable
        @keyup.enter="go('sales')"
      >
        <template #prepend>ASIN</template>
        <template #append>
   <el-button type="primary" @click="go('sales')">开始分析</el-button>
 </template>
      </el-input>
      <p class="hint muted">
        输入后点任意功能入口，ASIN 会一起带过去。
      </p>
    </div>

    <!-- 账户概况 -->
    <div class="stat-row">
      <div class="stat-card primary">
        <div class="stat-label">积分余额</div>
        <div class="stat-value">{{ credits.account?.balance ?? '—' }}</div>
        <RouterLink :to="{ name: 'settings' }" class="stat-link">积分管理 →</RouterLink>
      </div>
      <div class="stat-card">
 <div class="stat-label">累计查询</div>
        <div class="stat-value">{{ totalQueries }}</div>
        <RouterLink :to="{ name: 'history' }" class="stat-link">查询历史 →</RouterLink>
      </div>
      <div class="stat-card">
        <div class="stat-label">累计消耗</div>
        <div class="stat-value">{{ credits.account?.totalConsumed ?? '—' }}</div>
        <!-- 价格从后端计价表读，不要硬编码：credits store 已有 costOf() 机制 -->
        <span class="stat-link muted">{{ aiCostHint }}</span>
      </div>
    </div>

    <!-- 功能入口 -->
    <div class="card">
      <h2 class="sec-title">功能入口</h2>
      <div class="entries">
        <button
          v-for="e in quickEntries"
   :key="e.name"
   class="entry"
          type="button"
          @click="go(e.name)"
 >
   <span class="entry-icon">{{ e.icon }}</span>
   <span class="entry-body">
     <span class="entry-label">{{ e.label }}</span>
     <span class="entry-desc">{{ e.desc }}</span>
   </span>
        </button>
      </div>
    </div>

    <!-- 最近查询 -->
    <div class="card">
      <h2 class="sec-title">最近查询</h2>
      <el-skeleton v-if="loadingStats" :rows="3" animated />
      <template v-else-if="recent.length">
        <div v-for="(r, i) in recent" :key="i" class="recent-row" @click="replay(r)">
          <el-tag size="small" effect="plain" type="info">
     {{ TYPE_LABEL[r.queryType] ?? r.queryType }}
   </el-tag>
   <span class="mono">{{ r.queryValue }}</span>
          <span class="muted country">{{ r.country }}</span>
          <span class="muted time">{{ r.createdAt }}</span>
        </div>
      </template>
      <el-empty v-else description="还没有查询记录，从上方输入 ASIN 开始" :image-size="70" />
    </div>

    <!-- 使用指南 -->
    <section class="card guide">
      <h2 class="sec-title">怎么用</h2>
      <ol class="guide-list">
        <li>在上方输入框粘贴要分析的 ASIN</li>
        <li>先看「查流量结构」了解自然与广告的比例</li>
        <li>再用「反查流量词」找出值得投放的关键词</li>
        <li>用「广告透视」还原竞品的投放打法</li>
        <li>最后用「AI 综合诊断」拿一份四维度汇总的行动计划</li>
      </ol>
      <p class="tip muted">
        演示数据的分布不均：查销量 / 流量结构用父体
 <code>B0SEEDSSP0</code>，反查流量词 / 推荐专栏用子体
 <code>B0SEEDSS02</code>，广告透视用 <code>B0SEEDHD03</code>。
      </p>
    </section>
  </div>
</template>

<style scoped>
.search-card {
  margin-bottom: 16px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
}

.stat-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.stat-card {
  flex: 1;
  min-width: 148px;
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.stat-card.primary {
  background: var(--brand-50);
  border-color: var(--brand-100, var(--line));
}

.stat-label {
  font-size: 12px;
  color: var(--ink-500);
}

.stat-value {
  margin: 6px 0 8px;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.stat-link {
  font-size: 12px;
  color: var(--brand-500);
}

.stat-link.muted {
  color: var(--ink-500);
}

.sec-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.entries {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 10px;
}

.entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: border-color 0.15s, background 0.15s;
}

.entry:hover {
  border-color: var(--brand-500);
  background: var(--brand-50);
}

.entry-icon {
  font-size: 15px;
  color: var(--brand-500);
  line-height: 1.4;
}

.entry-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.entry-label {
  font-size: 13.5px;
  font-weight: 600;
}

.entry-desc {
  font-size: 12px;
  color: var(--ink-500);
  line-height: 1.4;
}

.recent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  font-size: 13px;
}

.recent-row:last-child {
  border-bottom: none;
}

.recent-row:hover .mono {
  color: var(--brand-500);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.country {
  font-size: 12px;
}

.time {
  margin-left: auto;
  font-size: 12px;
}

.guide-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--ink-700);
}

.tip {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
}

.tip code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--ink-100, #f0f2f5);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}

@media (max-width: 960px) {
  .entries {
    grid-template-columns: 1fr;
  }
}
</style>
