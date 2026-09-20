<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { businessApi, type SalesOverview, type SalesTrend } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import QuerySkeleton from '@/components/QuerySkeleton.vue'
import BaseChart from '@/components/BaseChart.vue'
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
        <el-table :data="overview.variants" stripe style="width: 100%">
          <el-table-column label="图片" width="72">
            <template #default="{ row }">
              <img v-if="row.img" :src="row.img" class="cell-img" alt="" />
            </template>
          </el-table-column>
          <el-table-column prop="asin" label="ASIN" width="130">
            <template #default="{ row }">
              <span class="mono">{{ row.asin }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
          <el-table-column v-for="d in overview.dimensions" :key="d" :label="d" width="110">
            <template #default="{ row }">{{ row.features[d] ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="评分" width="120">
            <template #default="{ row }">
              <template v-if="row.score !== null">
                {{ row.score }}
                <span class="muted">({{ (row.ratingNum ?? 0).toLocaleString() }})</span>
              </template>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="价格" width="92">
            <template #default="{ row }">
              <span v-if="row.price !== null">${{ row.price }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="近一月销量" width="110">
            <template #default="{ row }">
              <el-tag v-if="row.boughtLabel" size="small" effect="plain">
                {{ row.boughtLabel }}
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="流量占比" width="100">
            <template #default="{ row }">
              <span v-if="row.trafficRatio !== null">
                {{ (row.trafficRatio * 100).toFixed(1) }}%
              </span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="router.push({ name: 'traffic', query: { asin: row.asin } })">
                流量结构
              </el-button>
              <el-button link type="primary" size="small" @click="router.push({ name: 'keywords', query: { asin: row.asin } })">
                流量词
              </el-button>
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
</style>
