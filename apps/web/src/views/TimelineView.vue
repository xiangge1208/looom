<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { businessApi } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import QuerySkeleton from '@/components/QuerySkeleton.vue'
import BaseChart from '@/components/BaseChart.vue'

/**
 * 运营时光机
 *
 * 把运营动作事件叠加到指标时间轴上，回答「什么时候做了什么、之后数据怎么变了」。
 *
 * 事件性质（侦察已确认）：是**系统识别的变化点**，不是用户手动标注的。
 * 数据很稀疏 —— 库里只存有事件的那些天，图上按日期打点。
 */
const route = useRoute()
const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const data = ref<any>(null)
const activeMetric = ref<'bought' | 'price' | 'bsr' | 'score'>('bought')

async function search(v: string) {
  asin.value = v
  loading.value = true
  try {
    data.value = await businessApi.timeline(v)
  } catch {
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (asin.value) search(asin.value)
})

const METRIC_META: Record<string, { label: string; color: string; unit?: string }> = {
  bought: { label: '销量（分档下界）', color: '#4f46e5' },
  price: { label: '价格', color: '#0d9488', unit: '$' },
  bsr: { label: 'BSR 排名', color: '#d97706' },
  score: { label: '评分', color: '#dc2626' },
}

/**
 * 指标曲线 + 事件标注。
 *
 * 事件用 markLine 竖线标在对应月份上 —— 这样能直观看出
 * 「某次改标题/加广告之后，曲线有没有变化」。
 */
const chartOption = computed(() => {
  const d = data.value
  if (!d?.months?.length) return null

  const meta = METRIC_META[activeMetric.value]
  const values = d.metrics[activeMetric.value] ?? []

  // 事件按月份归组：一个事件日期可能落在某个月份区间内
  const eventMonths = new Map<string, string[]>()
  for (const e of d.events ?? []) {
    const m = (e.date ?? '').slice(0, 7)
    if (!m) continue
    if (!eventMonths.has(m)) eventMonths.set(m, [])
    eventMonths.get(m)!.push(e.eventName)
  }

  const markLines = [...eventMonths.entries()]
    .filter(([m]) => d.months.includes(m))
    .map(([m, names]) => ({
      xAxis: m,
      label: { formatter: names[0], fontSize: 10, position: 'insideEndTop' },
      lineStyle: { color: '#dc2626', type: 'dashed', width: 1 },
    }))

  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 56, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: 'category',
      data: d.months,
      axisLabel: { fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: meta.label,
      nameTextStyle: { fontSize: 11 },
      axisLabel: { fontSize: 11 },
      splitLine: { lineStyle: { color: '#f3f4f6' } },
    },
    series: [
      {
        name: meta.label,
        type: 'line',
        smooth: true,
        connectNulls: false,
        data: values,
        itemStyle: { color: meta.color },
        areaStyle: { opacity: 0.1 },
        symbolSize: 4,
        markLine:
          markLines.length > 0
            ? {
                silent: true,
                symbol: 'none',
                data: markLines,
              }
            : undefined,
      },
    ],
  }
})

const EVENT_COLORS: Record<string, string> = {
  titleImg: 'warning',
  campaignId: 'success',
  priceChange: '',
  coupon: 'danger',
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">运营时光机</h1>
    <p class="page-desc">回溯该 ASIN 的运营动作与指标变化，看清「做了什么之后数据怎么变」</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <!-- 加载骨架：请求飞行期间避免页面空白 -->
    <QuerySkeleton v-if="loading && !data" />

    <template v-if="data">
      <div class="card">
        <div class="card-head">
          <h2 class="sec-title">指标走势与运营动作</h2>
          <el-radio-group v-model="activeMetric" size="small">
            <el-radio-button value="bought">销量</el-radio-button>
            <el-radio-button value="price">价格</el-radio-button>
            <el-radio-button value="bsr">BSR</el-radio-button>
            <el-radio-button value="score">评分</el-radio-button>
          </el-radio-group>
        </div>
        <BaseChart :option="chartOption" :loading="loading" height="340px" />
        <p class="hint muted">红色虚线是系统识别到的运营动作发生时间点。</p>
      </div>

      <div class="card">
        <h2 class="sec-title">
          运营动作
          <span class="muted">（共 {{ data.events.length }} 条）</span>
        </h2>
        <el-empty v-if="!data.events.length" description="该 ASIN 暂无识别的运营动作" :image-size="70" />
        <el-table v-else :data="data.events" stripe>
          <el-table-column prop="date" label="日期" width="120" />
          <el-table-column label="动作类型" width="150">
            <template #default="{ row }">
              <el-tag :type="EVENT_COLORS[row.eventType] || 'info'" size="small" effect="plain">
                {{ row.eventName }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="240">
            <template #default="{ row }">
              <span class="mono">{{ JSON.stringify(row.detail) }}</span>
            </template>
          </el-table-column>
        </el-table>
        <p class="hint muted">
          这些动作是系统从数据变化中识别出来的，不是人工标注 —— 所以可能有遗漏或误判。
        </p>
      </div>
    </template>

    <el-empty v-else-if="!loading" description="输入 ASIN 开始查询" :image-size="90" />
  </div>
</template>

<style scoped>
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

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
</style>
