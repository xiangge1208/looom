<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { businessApi, type SalesOverview, type SalesTrend } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import QuerySkeleton from '@/components/QuerySkeleton.vue'
import BaseChart from '@/components/BaseChart.vue'
import Sparkline from '@/components/Sparkline.vue'
import AiAnalysisCard from '@/components/AiAnalysisCard.vue'

/**
 * 查销量
 *
 * 图表维度切换（不同变体 / Color / Size）的实现在这里：
 * 维度名来自接口返回的 dimensions（随商品变化），
 * 不硬编码 Size/Color 两列 —— 因为有的商品只有一个维度。
 */
const route = useRoute()
const router = useRouter()

const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const overview = ref<SalesOverview | null>(null)
const trend = ref<SalesTrend | null>(null)

/** 折线图按什么维度聚合 */
const chartDimension = ref('variant')

/** 可选维度：先把 "不同变体" 放前面，再接商品自身的属性维度 */
const dimensionOptions = computed(() => {
  const opts = [{ label: '不同变体', value: 'variant' }]
  for (const d of overview.value?.dimensions ?? []) {
    opts.push({ label: `不同 ${d}`, value: d })
  }
  return opts
})

async function search(v: string) {
  asin.value = v
  loading.value = true
  try {
    const [ov, tr] = await Promise.all([
      businessApi.salesOverview(v),
      businessApi.salesTrend(v),
    ])
    overview.value = ov
    trend.value = tr
    // 把 ASIN 写进 URL，便于分享和刷新保持
    router.replace({ query: { ...route.query, asin: v } })
  } catch {
    overview.value = null
    trend.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (asin.value) search(asin.value)
})

/**
 * ASIN → 逐月销量序列。
 *
 * trend.series 本来只用于页面上方那张大图，但它已经带了每个变体的
 * 完整月度序列，正好是表格行内迷你趋势图要的数据 —— 不必新增接口。
 */
const seriesByAsin = computed(() => {
  const map = new Map<string, { values: (number | null)[]; labels: (string | null)[] }>()
  for (const s of trend.value?.series ?? []) {
    map.set(s.asin, { values: s.values, labels: s.labels })
  }
  return map
})

/**
 * 行内趋势图的峰值标注文案。
 *
 * 销量是分档字符串（"200+"、"<50"），不是精确值，所以标注取
 * **峰值那个月的分档标签**而不是把数字格式化 —— 后者会凭空造出
 * 一个原站不存在的精确销量。
 */
function peakLabelOf(asinKey: string): string | null {
  const s = seriesByAsin.value.get(asinKey)
  if (!s) return null
  let bestIdx = -1
  let bestVal = -Infinity
  s.values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v) && v > bestVal) {
      bestVal = v
      bestIdx = i
    }
  })
  return bestIdx >= 0 ? (s.labels[bestIdx] ?? null) : null
}

/**
 * 「最畅销变体」的 ASIN 集合。
 *
 * 对应原站销量列上的 🔥 徽标。用 boughtLowerBound 比较而不是
 * boughtLabel 字符串 —— 后者是 "200+" 这类文本，没法直接比大小。
 *
 * ⚠️ 返回的是 Set 而不是单个 ASIN：销量是**分档区间**，并列最高
 * 非常常见（实测 seed 里就有两个变体同为 10,000+）。只标其中一个
 * 会让用户以为另一个卖得更差，而数据根本区分不出高低。
 *
 * 全组都没有销量数据时返回空集，不给任何行打标记 —— 否则会出现
 * 「无数据反而拿了最佳」的误导（竞品对比页踩过这个坑）。
 */
const bestSellingAsins = computed(() => {
  const vs = overview.value?.variants ?? []
  let max = -Infinity
  for (const v of vs) {
    const n = v.boughtLowerBound
    if (n === null || !Number.isFinite(n) || n <= 0) continue
    if (n > max) max = n
  }
  if (max === -Infinity) return new Set<string>()

  // 只有一个变体时标「最畅销」没有意义
  const withData = vs.filter(
    (v) => v.boughtLowerBound !== null && Number.isFinite(v.boughtLowerBound) && v.boughtLowerBound > 0,
  )
  if (withData.length < 2) return new Set<string>()

  return new Set(withData.filter((v) => v.boughtLowerBound === max).map((v) => v.asin))
})

/**
 * 「最畅销属性」：按某个维度（如 Size）聚合销量后最高的属性值。
 *
 * 对应原站 Size 列上的 🔥 徽标。返回 { 维度名: 最佳属性值 }。
 */
const bestFeatureByDim = computed(() => {
  const result: Record<string, Set<string>> = {}
  const dims = overview.value?.dimensions ?? []
  const vs = overview.value?.variants ?? []

  for (const d of dims) {
    const sum = new Map<string, number>()
    for (const v of vs) {
      const fv = v.features?.[d]
      const n = v.boughtLowerBound
      if (!fv || n === null || !Number.isFinite(n) || n <= 0) continue
      sum.set(fv, (sum.get(fv) ?? 0) + n)
    }
    // 同样要支持并列：分档销量聚合后属性值打平很常见
    let max = -Infinity
    for (const n of sum.values()) if (n > max) max = n
    // 只有一个属性值时标「最畅销」没有意义，跳过
    if (max > -Infinity && sum.size > 1) {
      result[d] = new Set([...sum.entries()].filter(([, n]) => n === max).map(([fv]) => fv))
    }
  }
  return result
})

/**
 * 表格排序状态。null 表示用后端返回的原始顺序（display_order）。
 */
const sortKey = ref<'price' | 'bought' | 'traffic' | 'score' | null>(null)
const sortAsc = ref(false)

/** 点表头切换排序：同一列反复点 → 降序 → 升序 → 取消 */
function toggleSort(key: 'price' | 'bought' | 'traffic' | 'score') {
  if (sortKey.value !== key) {
    sortKey.value = key
    sortAsc.value = false
    return
  }
  if (!sortAsc.value) {
    sortAsc.value = true
    return
  }
  sortKey.value = null
}

/**
 * 排序后的表格行。
 *
 * 两条规则：
 *   1. **父体行永远钉在第一行**，不参与排序 —— 它是这一组的主体，
 *      被排到中间会让表格读不出父子结构（原站父体也固定在首行）。
 *   2. 空值一律排在末尾，不论升降序。否则降序时一堆 null 占据顶部，
 *      有数据的行反而被挤下去。
 */
const sortedVariants = computed(() => {
  const all = overview.value?.variants ?? []
  const parents = all.filter((v) => v.isParent)
  const children = all.filter((v) => !v.isParent)

  if (!sortKey.value) return [...parents, ...children]

  const valueOf = (v: (typeof children)[number]): number | null => {
    switch (sortKey.value) {
      case 'price':
        return v.price
      case 'bought':
        return v.boughtLowerBound
      case 'traffic':
        return v.trafficRatio
      case 'score':
        return v.score
      default:
        return null
    }
  }

  const sorted = [...children].sort((a, b) => {
    const av = valueOf(a)
    const bv = valueOf(b)
    // 空值恒定沉底
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    return sortAsc.value ? av - bv : bv - av
  })

  return [...parents, ...sorted]
})

/** 表头排序指示箭头 */
function sortArrow(key: 'price' | 'bought' | 'traffic' | 'score') {
  if (sortKey.value !== key) return '↕'
  return sortAsc.value ? '↑' : '↓'
}

/**
 * 按维度聚合折线图。
 *
 * variant 维度：每个变体一条线
 * 属性维度（如 Color）：同一属性值的变体求平均，合成一条线
 */
const trendOption = computed(() => {
  const t = trend.value
  const ov = overview.value
  if (!t || !ov) return null

  const PALETTE = ['#4f46e5', '#0d9488', '#d97706', '#dc2626', '#7c3aed', '#0284c7']

  let series: any[]
  const labels = t.dates

  if (chartDimension.value === 'variant') {
    series = t.series.map((s, i) => ({
      name: shortName(s.asin, ov),
      type: 'line',
      smooth: true,
      // 缺月不要补 0（会被误读成销量归零），留 null 让 ECharts 断线
      data: s.values,
      connectNulls: false,
      symbolSize: 4,
      itemStyle: { color: PALETTE[i % PALETTE.length] },
    }))
  } else {
    // 按属性值聚合：属于同一属性值的变体，其数值取平均
    const groupMap = new Map<string, number[][]>()
    t.series.forEach((s) => {
      const feat = ov.variants.find((v) => v.asin === s.asin)?.features ?? {}
      const key = feat[chartDimension.value]
      if (!key) return
      if (!groupMap.has(key)) groupMap.set(key, labels.map(() => []))
      const buckets = groupMap.get(key)!
      s.values.forEach((v, i) => {
        if (v !== null) buckets[i].push(v)
      })
    })

    series = [...groupMap.entries()].map(([key, buckets], i) => ({
      name: key,
      type: 'line',
      smooth: true,
      data: buckets.map((b) => (b.length ? Math.round(b.reduce((a, c) => a + c, 0) / b.length) : null)),
      connectNulls: false,
      symbolSize: 4,
      itemStyle: { color: PALETTE[i % PALETTE.length] },
    }))
  }

  return {
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 48, right: 16, top: 16, bottom: 44 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { fontSize: 11, rotate: labels.length > 20 ? 40 : 0 },
    },
    yAxis: {
      type: 'value',
      name: '销量',
      nameTextStyle: { fontSize: 11 },
      axisLabel: { fontSize: 11 },
      splitLine: { lineStyle: { color: '#f3f4f6' } },
    },
    series,
  }
})

/** 变体简称：优先用属性值，没有就截 ASIN 尾号 */
function shortName(vAsin: string, ov: SalesOverview) {
  const v = ov.variants.find((x) => x.asin === vAsin)
  const vals = v ? Object.values(v.features) : []
  if (vals.length) return vals.join(' / ')
  return vAsin.slice(-4)
}

/** AI 分析的输入。单独算出来而不是写在模板里，避免模板表达式的空值收窄问题 */
const aiInput = computed(() => {
  const ov = overview.value
  const t = trend.value
  return {
    asin: ov?.target.asin ?? asin.value,
    country: 'US',
    monthlySales:
      t?.dates.map((d, i) => ({
        month: d,
        variants: t.series.map((s) => ({ asin: s.asin, label: s.labels[i] })),
      })) ?? [],
  }
})

/** 近一月销量合计（各变体分档下界之和，仅作量级参考） */
const totalBoughtLower = computed(() => {
  const ov = overview.value
  if (!ov) return null
  const nums = ov.variants.map((v) => v.boughtLowerBound ?? 0)
  const sum = nums.reduce((a, c) => a + c, 0)
  return sum > 0 ? sum : null
})
</script>

<template>
  <div class="page">
    <h1 class="page-title">查销量</h1>
    <p class="page-desc">查看变体维度的销量趋势与月度走势</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <!-- 加载骨架：请求飞行期间避免页面空白 -->
    <QuerySkeleton v-if="loading && !overview" />

    <template v-if="overview">
      <!-- 顶部概要 -->
      <div class="card summary">
        <img v-if="overview.target.img" :src="overview.target.img" class="thumb" alt="" />
        <div class="summary-body">
          <div class="summary-title">{{ overview.target.title }}</div>
          <div class="summary-meta">
            <span class="mono">{{ overview.parentAsin ?? overview.target.asin }}</span>
            <el-tag v-if="overview.target.isParentAsin" size="small" type="info" effect="plain">
              父体
            </el-tag>
            <span class="muted">共 {{ overview.variantCount }} 个变体</span>
            <span v-if="totalBoughtLower" class="muted">
              近一月合计销量 ≥ {{ totalBoughtLower.toLocaleString() }}
            </span>
          </div>
        </div>
      </div>

      <!-- 销量趋势 -->
      <div class="card">
        <div class="card-head">
          <h2 class="sec-title">销量趋势</h2>
          <el-radio-group v-model="chartDimension" size="small">
            <el-radio-button
              v-for="d in dimensionOptions"
              :key="d.value"
              :value="d.value"
            >
              {{ d.label }}
            </el-radio-button>
          </el-radio-group>
        </div>
        <BaseChart :option="trendOption" :loading="loading" height="340px" />
        <p class="hint muted">
          纵轴为销量分档下界（原站销量以区间形式给出，如「200+」），缺数据的月份断线不补零。
        </p>
      </div>

      <!-- 变体表格。列按 dimensions 动态生成，不写死 Size/Color -->
      <div class="card">
        <h2 class="sec-title">变体明细</h2>
        <!--
          row-key 必须给：排序会改变行顺序，没有稳定 key 时 Vue 按索引复用
          DOM 节点，徽标会残留在错误的行上（实测排序后 5,000+ 的变体也被
          标成「最畅销变体」，且 BS 徽标重复出现 3 次）。
        -->
        <el-table :data="sortedVariants" row-key="asin" stripe style="width: 100%">
          <el-table-column label="图片" width="72">
            <template #default="{ row }">
              <img v-if="row.img" :src="row.img" class="cell-img" alt="" />
            </template>
          </el-table-column>
          <el-table-column prop="asin" label="ASIN 信息" min-width="230">
            <template #default="{ row }">
              <!-- 原站把 ASIN / 标题 / 评分聚在一格，信息密度更高 -->
              <div class="asin-cell">
                <div class="asin-line">
                  <span class="mono asin-code">{{ row.asin }}</span>
                  <el-tag v-if="row.isParent" size="small" type="info" effect="plain">
                    父体
                  </el-tag>
                  <el-tag v-else size="small" effect="plain">变体</el-tag>
                  <el-tag v-if="row.isBestSeller" size="small" type="danger" effect="plain">
                    BS
                  </el-tag>
                </div>
                <div class="asin-title" :title="row.title ?? ''">{{ row.title ?? '—' }}</div>
                <div class="asin-rating muted">
                  <template v-if="row.score !== null">
                    {{ row.score }}
                    <span>({{ (row.ratingNum ?? 0).toLocaleString() }})</span>
                  </template>
                  <span v-else>暂无评分</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column v-for="d in overview.dimensions" :key="d" :label="d" width="126">
            <template #default="{ row }">
              <div class="feat-cell">
                <span>{{ row.features[d] ?? '—' }}</span>
                <!-- 最畅销属性：该维度下销量合计最高的属性值 -->
                <el-tag
                  v-if="row.features[d] && bestFeatureByDim[d]?.has(row.features[d])"
                  size="small"
                  type="danger"
                  effect="plain"
                >
                  最畅销属性
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column width="100">
            <template #header>
              <button type="button" class="sort-th" @click="toggleSort('price')">
                价格 <span class="sort-ind">{{ sortArrow('price') }}</span>
              </button>
            </template>
            <template #default="{ row }">
              <span v-if="row.price !== null">${{ row.price }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column width="146">
            <template #header>
              <button type="button" class="sort-th" @click="toggleSort('bought')">
                子体近 30 天销量 <span class="sort-ind">{{ sortArrow('bought') }}</span>
              </button>
            </template>
            <template #default="{ row }">
              <div class="sales-cell">
                <el-tag v-if="row.boughtLabel" size="small" effect="plain">
                  {{ row.boughtLabel }}
                </el-tag>
                <!--
                  父体和「查不到数据」要分开说：父体维度本来就不存在销量，
                  显示 — 会被读成「没查到」，其实是「不适用」。
                -->
                <span v-else-if="row.isParent" class="muted na">不适用</span>
                <span v-else class="muted">—</span>
                <!-- 最畅销变体：组内销量分档下界最高的那个 -->
                <el-tag
                  v-if="bestSellingAsins.has(row.asin)"
                  size="small"
                  type="danger"
                  effect="plain"
                >
                  最畅销变体
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <!--
            月销量趋势：数据来自 trend.series（本来只喂上方大图），
            峰值标注用该月的销量分档标签，不把区间值当精确数字显示。
          -->
          <el-table-column label="月销量趋势" width="164">
            <template #default="{ row }">
              <Sparkline
                :values="seriesByAsin.get(row.asin)?.values ?? []"
                :peak-label="peakLabelOf(row.asin)"
                :width="148"
                :height="42"
              />
            </template>
          </el-table-column>
          <el-table-column width="112">
            <template #header>
              <button type="button" class="sort-th" @click="toggleSort('traffic')">
                流量占比 <span class="sort-ind">{{ sortArrow('traffic') }}</span>
              </button>
            </template>
            <template #default="{ row }">
              <span v-if="row.trafficRatio !== null">
                {{ (row.trafficRatio * 100).toFixed(1) }}%
              </span>
              <span v-else-if="row.isParent" class="muted na">整组</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <!-- 操作列对齐原站的 4 项下钻入口（原先只有前两项） -->
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <div class="ops">
                <el-button
                  link
                  type="primary"
                  size="small"
                  @click="router.push({ name: 'traffic', query: { asin: row.asin } })"
                >
                  查流量结构
                </el-button>
                <el-button
                  link
                  type="primary"
                  size="small"
                  @click="router.push({ name: 'keywords', query: { asin: row.asin } })"
                >
                  反查流量词
                </el-button>
                <el-button
                  link
                  type="primary"
                  size="small"
                  @click="router.push({ name: 'ads', query: { asin: row.asin } })"
                >
                  查广告架构
                </el-button>
                <el-button
                  link
                  type="primary"
                  size="small"
                  @click="router.push({ name: 'timeline', query: { asin: row.asin } })"
                >
                  查运营节奏
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <p class="hint muted">
          注意：父体本身没有销量数据，销量只存在于子体。
        </p>
      </div>

      <!-- AI 插入点 1：销量趋势解读 -->
      <AiAnalysisCard
        insert-point="sales-trend"
        title="AI 销量趋势解读"
        :input="aiInput"
      />
    </template>

    <el-empty
      v-else-if="!loading"
      description="输入 ASIN 开始查询"
      :image-size="90"
    />
  </div>
</template>

<style scoped>
.summary {
  display: flex;
  gap: 14px;
  margin-bottom: 16px;
  align-items: flex-start;
}

.thumb {
  width: 64px;
  height: 64px;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  flex-shrink: 0;
}

.summary-body {
  min-width: 0;
}

.summary-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  margin-bottom: 6px;
}

.summary-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
}

.card {
  margin-bottom: 16px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.sec-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.card-head .sec-title {
  margin: 0;
}

.cell-img {
  width: 44px;
  height: 44px;
  object-fit: contain;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

/* ---- 变体表格的复合单元格（对齐原站的信息密度）---- */

.asin-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 2px 0;
}

.asin-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.asin-code {
  font-weight: 600;
}

.asin-title {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink-700);
  /* 标题较长，最多两行，超出省略 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.asin-rating {
  font-size: 12px;
}

.feat-cell,
.sales-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

/* 可排序表头：做成 button 以便键盘可达 */
.sort-th {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.sort-th:hover {
  color: var(--brand-500);
}

.sort-ind {
  font-size: 10px;
  opacity: 0.55;
}

.sort-th:hover .sort-ind {
  opacity: 1;
}

/* 「不适用」与「无数据」在视觉上要有区别 */
.na {
  font-size: 12px;
  font-style: italic;
}

/* 操作列纵向排布，与原站一致；横排在 4 项时会挤成两行且难点中 */
.ops {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.ops :deep(.el-button) {
  margin-left: 0;
  height: 22px;
  padding: 0;
}
</style>
