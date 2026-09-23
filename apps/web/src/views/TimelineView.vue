<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { businessApi, type DailyTrend } from '@/api/business'
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

/**
 * 日粒度因果图的数据（fact_asin_daily_snapshot）。
 *
 * ⚠️ 与下方的月粒度 `data` 是**两套独立数据**，不是同一份的不同视图：
 *   daily  日粒度、多系列并列，来自本次新建的表（只灌了部分 ASIN）
 *   data   月粒度、单系列切换，来自 fact_asin_listing_snapshot（全量 ASIN 都有）
 * 所以 daily 为空时要回落到月粒度图，而不是整页空白。
 */
const daily = ref<DailyTrend | null>(null)
/** 原站因果图是 83 天，这里给 83/120/180 三档 */
const dailyDays = ref(83)

async function search(v: string) {
  asin.value = v
  loading.value = true
  try {
    /**
     * 两个接口一起拉。日粒度用 allSettled 单独兜 ——
     * 它依赖新表，某些 ASIN 没灌数会失败，不该让月粒度图也没得看。
     */
    const [tl, dy] = await Promise.allSettled([
      businessApi.timeline(v),
      businessApi.trafficDaily(v, dailyDays.value),
    ])
    data.value = tl.status === 'fulfilled' ? tl.value : null
    daily.value = dy.status === 'fulfilled' && dy.value.days > 0 ? dy.value : null
  } catch {
    data.value = null
    daily.value = null
  } finally {
    loading.value = false
  }
}

async function onDailyDaysChange(d: number) {
  dailyDays.value = d
  if (!asin.value) return
  try {
    const r = await businessApi.trafficDaily(asin.value, d)
    daily.value = r.days > 0 ? r : null
  } catch {
    daily.value = null
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
      /**
       * ⚠️ 同月多事件时竖线只有一条，标签只能显示一个。
       * 原先写 `names[0]` 把其余事件**静默吞掉**（实测某些月有 3-4 个动作）。
       * 改成显示第一个 + 数量，并把全部事件塞进 tooltip 的 name。
       * 真正要逐个看的话用上面的日粒度因果图，那里是散点、一天一个。
       */
      label: {
        formatter: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0],
        fontSize: 10,
        position: 'insideEndTop',
      },
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

/**
 * 日粒度因果图：多指标**并列**而非切换。
 *
 * 这是「因果图」的关键 —— 运营要看的是「改了价之后流量和排名怎么动」，
 * 三条线必须同时在图上才能读出因果。下面的月粒度图是单系列切换，
 * 一次只能看一个指标，看不出关联。
 *
 * 四条 Y 轴：
 *   轴 0 左   流量得分（柱状，自然/广告堆叠）
 *   轴 1 右   价格（折线）
 *   轴 2 右   BSR（折线，**倒置** —— 名次越小越好）
 *   轴 3 隐藏 评论数（折线，量级 20 万，与其他三个差太远，共用会把别的压平）
 */
const dailyCausalOption = computed(() => {
  const d = daily.value
  if (!d || !d.dates.length) return null

  const t = d.traffic
  const idxOf = new Map(d.dates.map((s, i) => [s, i]))

  /** 事件散点：Y 取当天总流量得分，让图钉落在柱顶 */
  const eventPoints = d.events
    .map((e) => {
      const i = idxOf.get(e.date)
      if (i === undefined) return null
      const y = t.total[i]
      if (y === null || y === undefined) return null
      const labels: string[] = []
      if (e.titleImg !== null) labels.push('改标题/主图')
      if (e.coupon) labels.push(`优惠券 ${e.coupon}`)
      if (e.promotion) labels.push(e.promotion)
      if (e.woot === 1) labels.push('Woot 活动')
      return { value: [i, y], name: labels.join('、') }
    })
    .filter(Boolean) as Array<{ value: [number, number]; name: string }>

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: (ps: any[]) => {
        if (!ps?.length) return ''
        const i = ps[0].dataIndex
        const lines = [`<b>${d.dates[i]}</b>`]
        for (const p of ps) {
          if (p.value === null || p.value === undefined) continue
          const n = p.seriesName as string
          const raw = Array.isArray(p.value) ? p.value[1] : p.value
          if (n.includes('价')) lines.push(`${p.marker}${n}：$${Number(raw).toFixed(2)}`)
          else if (n.includes('BSR')) lines.push(`${p.marker}${n}：#${raw}`)
          else if (n === '运营动作') lines.push(`${p.marker}<b>${p.data?.name ?? '运营动作'}</b>`)
          else lines.push(`${p.marker}${n}：${Math.round(Number(raw)).toLocaleString()}`)
        }
        return lines.join('<br/>')
      },
    },
    legend: { bottom: 0, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: 58, right: 92, top: 24, bottom: 58 },
    xAxis: { type: 'category', data: d.dates, axisLabel: { fontSize: 10 } },
    yAxis: [
      {
        type: 'value',
        name: '流量得分',
        nameTextStyle: { fontSize: 10 },
        axisLabel: {
          fontSize: 10,
          formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)),
        },
        splitLine: { lineStyle: { type: 'dashed', color: '#f3f4f6' } },
      },
      {
        type: 'value',
        name: '价格',
        position: 'right',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10, formatter: (v: number) => `$${v}` },
        splitLine: { show: false },
      },
      {
        type: 'value',
        name: 'BSR',
        position: 'right',
        offset: 46,
        inverse: true,
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10, formatter: (v: number) => `#${v}` },
        splitLine: { show: false },
      },
      // 评论数量级 20 万，给独立的隐藏轴，否则会把价格和 BSR 压成直线
      { type: 'value', show: false },
    ],
    // 83 天点位很密，默认只显示后 60% 并给缩放条
    dataZoom: [{ type: 'slider', height: 16, bottom: 28, start: 40, end: 100 }],
    series: [
      {
        name: '自然流量',
        type: 'bar',
        stack: 'traffic',
        yAxisIndex: 0,
        data: t.nf,
        itemStyle: { color: '#1AB364' },
        barMaxWidth: 12,
      },
      {
        name: '广告流量',
        type: 'bar',
        stack: 'traffic',
        yAxisIndex: 0,
        data: t.ad,
        itemStyle: { color: '#F0AA11' },
        barMaxWidth: 12,
      },
      {
        name: '成交价',
        type: 'line',
        yAxisIndex: 1,
        data: d.price.deal,
        symbol: 'none',
        lineStyle: { width: 1.6, color: '#0d9488' },
        itemStyle: { color: '#0d9488' },
      },
      {
        name: `大类 BSR${d.rank.catName ? `（${d.rank.catName}）` : ''}`,
        type: 'line',
        yAxisIndex: 2,
        data: d.rank.bsr,
        symbol: 'none',
        lineStyle: { width: 1.4, color: '#8C6FE6' },
        itemStyle: { color: '#8C6FE6' },
      },
      {
        name: `小类 BSR${d.rank.subBsrCat ? `（${d.rank.subBsrCat}）` : ''}`,
        type: 'line',
        yAxisIndex: 2,
        data: d.rank.subBsr,
        symbol: 'none',
        lineStyle: { width: 1.2, color: '#c084fc', type: 'dashed' },
        itemStyle: { color: '#c084fc' },
      },
      {
        name: '评论数',
        type: 'line',
        yAxisIndex: 3,
        data: d.reputation.reviewNum,
        symbol: 'none',
        lineStyle: { width: 1, color: '#9ca3af' },
        itemStyle: { color: '#9ca3af' },
      },
      {
        name: '运营动作',
        type: 'scatter',
        yAxisIndex: 0,
        data: eventPoints,
        symbol: 'pin',
        symbolSize: 18,
        itemStyle: { color: '#E2521E' },
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

/**
 * 事件详情的展示文本。
 *
 * 后端 safeJson 对 event_detail 做「能解析就给对象，不能就原样给字符串」，
 * 而库里大多是人读的短句（如 `16.99 → 13.59`、`在投活动数: 2 → 1 个`）。
 * 早先这里无条件 JSON.stringify，把这些纯文本渲染成了 `"16.99 → 13.59"` ——
 * 多出来的引号是 stringify 加的，不是数据里的。
 * 所以字符串直接给，只有对象/数组才序列化。
 */
function formatDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return '—'
  if (typeof detail === 'string') return detail
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
  return JSON.stringify(detail)
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">运营时光机</h1>
    <p class="page-desc">回溯该 ASIN 的运营动作与指标变化，看清「做了什么之后数据怎么变」</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <!-- 加载骨架：请求飞行期间避免页面空白 -->
    <QuerySkeleton v-if="loading && !data" />

    <template v-if="data || daily">
      <!--
        日粒度因果图：多指标并列，能读出「改了什么之后数据怎么动」。
        依赖本次新建的 fact_asin_daily_snapshot，只灌了部分 ASIN，
        没数据时整块不渲染、回落到下面的月粒度图。
      -->
      <div v-if="daily && dailyCausalOption" class="card">
        <div class="card-head">
          <div class="head-left">
            <h2 class="sec-title">日粒度因果图</h2>
            <el-radio-group
              :model-value="dailyDays"
              size="small"
              @update:model-value="onDailyDaysChange(Number($event))"
            >
              <el-radio-button :value="83">83 天</el-radio-button>
              <el-radio-button :value="120">120 天</el-radio-button>
              <el-radio-button :value="180">180 天</el-radio-button>
            </el-radio-group>
          </div>
          <span class="muted small">共 {{ daily.days }} 天</span>
        </div>
        <BaseChart :option="dailyCausalOption" :loading="loading" height="400px" />
        <p class="hint muted">
          流量（柱状）、价格、大小类 BSR、评论数同时在图上，便于看出因果关系。
          BSR 轴<b>已倒置</b>：线往上走代表排名变好。橙色图钉是运营动作，悬停看详情。
          点位较密，可拖下方缩放条看局部。
        </p>
      </div>

      <div v-if="data" class="card">
        <div class="card-head">
          <h2 class="sec-title">月度指标走势</h2>
          <el-radio-group v-model="activeMetric" size="small">
            <el-radio-button value="bought">销量</el-radio-button>
            <el-radio-button value="price">价格</el-radio-button>
            <el-radio-button value="bsr">BSR</el-radio-button>
            <el-radio-button value="score">评分</el-radio-button>
          </el-radio-group>
        </div>
        <BaseChart :option="chartOption" :loading="loading" height="340px" />
        <p class="hint muted">
          月粒度长周期视图，一次看一个指标。红色虚线是系统识别到的运营动作发生月份，
          同月有多个动作时标签显示为「首个动作 +N」，逐个查看请用上方的日粒度图。
        </p>
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
              <!--
                detail 可能是字符串（如「16.99 → 13.59」）也可能是对象 ——
                后端 safeJson 解析成功给对象，失败则原样返回字符串。
                无条件 JSON.stringify 会给纯文本套一层多余的引号，
                所以字符串直接渲染，只有对象才序列化。
              -->
              <span class="mono">{{ formatDetail(row.detail) }}</span>
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

/* 标题 + 档位切换器同行左对齐（与 TrafficView 的 card-head 布局一致） */
.head-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.small {
  font-size: 11.5px;
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
