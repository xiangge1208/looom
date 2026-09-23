<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  businessApi,
  type DailyTrend,
  type KeywordAttribution,
  type TrafficStructure,
  type TrafficVariantRow,
} from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import BaseChart from '@/components/BaseChart.vue'
import QuerySkeleton from '@/components/QuerySkeleton.vue'
import AiAnalysisCard from '@/components/AiAnalysisCard.vue'

/**
 * 查流量结构
 *
 * 对应原站 /search。版面对齐原站：
 *   上方一张卡里横排三块分布（自然-广告 / 广告细分 / 推荐专栏）
 *   下方「流量结构」表格，维度 tab（不同变体 / 不同 Color / 不同 Size）
 *   + 展示模式切换（分列对比 / 堆积图）+ 流量得分可勾选
 */
const route = useRoute()
const router = useRouter()

const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const tableLoading = ref(false)
const data = ref<TrafficStructure | null>(null)
const variantRows = ref<TrafficVariantRow[]>([])
/** 该商品可用的属性维度，由后端下发（不同商品不一样，不能写死 Color/Size） */
const dimensions = ref<string[]>([])
/** 表格聚合维度：'variant' 或某个属性名 */
const tableDim = ref('variant')
/** 默认分列对比（对齐原站默认视图） */
const viewMode = ref<'stack' | 'split'>('split')
/** 分列模式下是否在条内显示得分数字（原站是个勾选框，默认勾上） */
const showScore = ref(true)

/**
 * 「流量时光机」：可选月份列表 + 当前选中的月份。
 *
 * 之前这个页面只能看最新月，月份选择器缺失 —— 后端一直支持 timePieceValue，
 * 只是前端从不传。这里补上：月份列表只含确实有数据的月，选空月没有意义。
 */
const months = ref<string[]>([])
const currentMonth = ref<string>('')

async function search(v: string) {
  asin.value = v
  loading.value = true
  tableDim.value = 'variant'
  try {
    /**
     * 月份列表、首屏数据、日粒度序列、归因一起拉。
     *
     * ⚠️ 日粒度和归因用 allSettled 而不是塞进上面的 all —— 它们依赖
     * 本次新建的表，某个 ASIN 没灌数时会返回空/报错，不该把整页拖垮。
     * 前者失败只是少两个模块，总览三块分布图仍然可用。
     */
    const [st, vt, mo] = await Promise.all([
      businessApi.trafficStructure(v),
      businessApi.trafficVariants(v, undefined, 'variant'),
      businessApi.trafficMonths(v),
    ])
    data.value = st
    variantRows.value = vt.rows ?? []
    dimensions.value = vt.dimensions ?? []
    months.value = mo.months ?? []
    // 后端返回的就是它实际用的月份，以它为准（可能与 months[0] 不同）
    currentMonth.value = st.timePieceValue ?? months.value[0] ?? ''
    router.replace({ query: { ...route.query, asin: v } })

    const [dailyRes, attrRes] = await Promise.allSettled([
      businessApi.trafficDaily(v, dailyDays.value),
      businessApi.keywordAttribution({ asin: v, limit: 30 }),
    ])
    daily.value = dailyRes.status === 'fulfilled' ? dailyRes.value : null
    attribution.value = attrRes.status === 'fulfilled' ? attrRes.value : null
  } catch {
    data.value = null
    variantRows.value = []
    dimensions.value = []
    months.value = []
    currentMonth.value = ''
    daily.value = null
    attribution.value = null
  } finally {
    loading.value = false
  }
}

/**
 * 日粒度复合图 + 流量归因表的状态。
 *
 * 数据源是本次新建的 fact_asin_daily_snapshot 与
 * fact_asin_keyword_attribution，只灌了部分 ASIN，所以两者都可能为 null，
 * 模板里必须判空（不要假设有数据）。
 */
const daily = ref<DailyTrend | null>(null)
const attribution = ref<KeywordAttribution | null>(null)
/** 窗口天数。原站这张图是 60 天，给 30/60/90 三档便于对比 */
const dailyDays = ref(60)

async function onDailyDaysChange(d: number) {
  dailyDays.value = d
  if (!asin.value) return
  try {
    daily.value = await businessApi.trafficDaily(asin.value, d)
  } catch {
    daily.value = null
  }
}

/**
 * 切换月份 —— 流量时光机的核心交互。
 *
 * 只重拉总览三块分布图。变体表格走的是另一个接口（trafficVariants），
 * 它目前不接受时间参数，所以保持不变，不做假的联动。
 */
async function onMonthChange(m: string) {
  if (!asin.value || !m) return
  loading.value = true
  try {
    data.value = await businessApi.trafficStructure(asin.value, undefined, m)
    currentMonth.value = data.value.timePieceValue ?? m
  } catch {
    // 保留上一次的数据，只提示失败 —— 比整页清空更可用
  } finally {
    loading.value = false
  }
}

/**
 * 切换聚合维度时重新拉表格。
 *
 * 聚合放在后端做：属性取值的各渠道得分要求和、列内占比要按聚合后的行重算，
 * 前端拿到的 channelShares 才是对的。在前端二次聚合等于把同一套口径实现两遍。
 */
async function loadDimension(dim: string) {
  tableDim.value = dim
  if (!asin.value) return
  tableLoading.value = true
  try {
    // country 交给 API 层的默认站点，不要在这里写死 'US'
    const vt = await businessApi.trafficVariants(asin.value, undefined, dim)
    variantRows.value = vt.rows ?? []
  } catch {
    variantRows.value = []
  } finally {
    tableLoading.value = false
  }
}

/** 维度 tab：先「不同变体」，再接商品自身的属性维度 */
const dimTabs = computed(() => [
  { label: '不同变体', value: 'variant' },
  ...dimensions.value.map((d) => ({ label: `不同 ${d}`, value: d })),
])

/** 首列表头：变体模式显示「变体 ASIN」，属性模式显示属性名 */
const firstColLabel = computed(() =>
  tableDim.value === 'variant' ? '变体 ASIN' : tableDim.value,
)

onMounted(() => {
  if (asin.value) search(asin.value)
})

/**
 * 上方三块一律用「标签 + 条 + 百分比」的横条，不用 ECharts。
 *
 * 原站这三块就是横条（见 SIF_UI_AUDIT 的截图），而且要挤在同一张卡的三栏里 ——
 * 每栏宽约 1/3 屏。饼图在这个宽度下只剩一个小圈，标签还得另起一行放；
 * 横条则天然是「一行一项」，标签、数值、百分比同一行读完，密度高得多。
 * 三块结构相同，所以共用 barRow 的渲染与 barWidth 归一逻辑。
 */

/** 自然 vs 广告：两行横条 */
const overviewBars = computed(() => {
  const d = data.value
  if (!d?.overview.natural && !d?.overview.ad) return []
  return [
    { name: '自然流量', score: d?.overview.natural?.score ?? 0, ratio: d?.overview.natural?.ratio ?? 0, color: '#1AB364' },
    { name: '广告流量', score: d?.overview.ad?.score ?? 0, ratio: d?.overview.ad?.ratio ?? 0, color: '#F0AA11' },
  ]
})

/** 广告细分：每个广告类型一行横条 */
const adBars = computed(() =>
  (data.value?.adBreakdown ?? []).map((x) => ({
    name: x.name,
    score: x.score ?? 0,
    ratio: x.ratio ?? 0,
    color: x.color || '#F2732F',
  })),
)

/** 推荐专栏：每个专栏一行横条 */
const recBars = computed(() =>
  (data.value?.recommendColumns ?? []).map((x, i) => ({
    name: x.name,
    title: x.recTitle,
    score: null as number | null,
    ratio: x.ratio ?? 0,
    campaignCount: x.campaignCount,
    // 专栏没有固定配色，按序轮换一组绿→青色，与原站观感接近
    color: ['#7CC00A', '#22C3A6', '#8A6D1F', '#2F6FED', '#F2732F'][i % 5],
  })),
)

/**
 * 横条宽度：按**组内最大值**归一。
 *
 * 不按 100% 归一 —— 广告细分里各项常是个位数百分比，按 100% 画出来
 * 全是几乎看不见的短条，条就失去意义了。按组内最大值归一后最强的那项占满，
 * 其余按比例收缩；最长的条对应的确实是最大值，不会误导。
 *
 * ⚠️ 曾经写成 `ratio * 100 * 6`（乘 6 放大），46.9% 就画成满条，
 * 视觉和旁边的数字对不上 —— 那是在骗人，不要退回那个做法。
 */
function barWidthOf(list: { ratio: number | null }[], ratio: number | null): string {
  const max = Math.max(...list.map((x) => x.ratio ?? 0), 0)
  if (max <= 0) return '0%'
  return `${Math.max(ratio ? 3 : 0, ((ratio ?? 0) / max) * 100)}%`
}

/** 分变体表格的渠道列，按表格里实际出现的渠道动态生成 */
const CHANNEL_META: Record<string, { name: string; color: string }> = {
  nf: { name: '自然', color: '#1AB364' },
  sp: { name: 'SP常规', color: '#F2732F' },
  spRec: { name: 'SP推荐', color: '#FF8F18' },
  sb: { name: 'SB常规', color: '#FFB302' },
  sbv: { name: 'SBV', color: '#EEDB47' },
}

const channelKeys = Object.keys(CHANNEL_META)

/** 堆积条里某段的宽度：该渠道占**本行各渠道之和**的比例 */
function segWidth(row: any, key: string): string {
  const total = channelKeys.reduce((a, k) => a + (row.channels?.[k]?.ratio ?? 0), 0) || 1
  return `${((row.channels?.[key]?.ratio ?? 0) / total) * 100}%`
}

/** 段够宽才在条内写数字，否则文字会溢出到相邻段上 */
function segLabel(row: any, key: string): string {
  const r = row.channels?.[key]?.ratio ?? 0
  const total = channelKeys.reduce((a, k) => a + (row.channels?.[k]?.ratio ?? 0), 0) || 1
  return (r / total) * 100 >= 12 ? `${(r * 100).toFixed(1)}%` : ''
}

/**
 * 分列模式的条宽：按**该列最大值**归一，不是按 100%。
 *
 * 用的是后端算的 channelShares（列内占比），不是 channels[].ratio（行内构成比）——
 * 这两个含义不同，混用会画错：实测原站第 1 行「自然流量占比 43%」对应的是
 * 「本行 nf ÷ 全组 nf 之和 = 42.9%」，而不是「nf 占本行 total 的 99.1%」。
 *
 * 归一按列内最大值而非 100%：各渠道占比常是个位数，按 100% 画所有条都短到
 * 看不出差别。最强的那行占满格，其余按比例收缩。
 */
function shareBarWidth(row: any, key: string): string {
  const max = Math.max(
    ...variantRows.value.map((r: any) => r.channelShares?.[key] ?? 0),
    0,
  )
  if (max <= 0) return '0%'
  const v = row.channelShares?.[key] ?? 0
  // 有值就至少给 4% 宽度，否则 0.2% 这种会渲染成一条看不见的线
  return `${Math.max(v > 0 ? 4 : 0, (v / max) * 100)}%`
}

/** 总流量占比列的条宽，口径同上（按列内最大值归一） */
function totalBarWidth(row: any): string {
  const max = Math.max(...variantRows.value.map((r: any) => r.totalShare ?? 0), 0)
  if (max <= 0) return '0%'
  const v = row.totalShare ?? 0
  return `${Math.max(v > 0 ? 4 : 0, (v / max) * 100)}%`
}

/** 百分比文案。null 表示该渠道整组都没有流量，原站显示 0 而不是 0% */
function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return '0'
  return `${(v * 100).toFixed(digits)}%`
}

/** 得分文案：整数化，太长的数字在窄列里会换行 */
function scoreText(v: number | null | undefined): string {
  if (v === null || v === undefined) return '0'
  return Math.round(v).toLocaleString()
}

/** 首列的属性摘要：变体模式拼 "White | 18x18 Inch"，属性模式显示成员数 */
function rowSubtitle(row: any): string {
  if (tableDim.value !== 'variant') {
    return row.memberCount ? `${row.memberCount} 个变体` : ''
  }
  const vals = Object.values(row.features ?? {}) as string[]
  return vals.join(' | ')
}

/**
 * 日粒度复合图：价格 + 流量 + BSR + 运营事件，四个量纲挤在一张图里。
 *
 * 三条 Y 轴（原站也是这个布局）：
 *   轴 0 左  流量得分（柱状，自然/广告堆叠）—— 量级上万
 *   轴 1 右  价格（折线）—— 量级十几
 *   轴 2 右  BSR（折线，**倒置**）—— 名次越小越好，不倒置的话"变好"会往下走，反直觉
 *
 * 运营事件用 scatter 打在流量柱顶部，而不是 markLine 竖线 ——
 * 竖线在 60 个点位上会糊成一片，散点可以 hover 看详情。
 */
const dailyOption = computed(() => {
  const d = daily.value
  if (!d || !d.dates.length) return null

  const t = d.traffic
  const money = (v: any) => (v === null || v === undefined ? '-' : `$${Number(v).toFixed(2)}`)

  /**
   * 事件散点的 Y 值取当天的总流量得分 —— 让点落在柱子顶端。
   * 当天没有得分就跳过这个点（画在 0 处会贴底，看不出对应哪根柱子）。
   */
  const idxOf = new Map(d.dates.map((s, i) => [s, i]))
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
      // 默认 formatter 会把三个量纲混成一串看不出单位，这里按系列名分别格式化
      formatter: (ps: any[]) => {
        if (!ps?.length) return ''
        const i = ps[0].dataIndex
        const lines = [`<b>${d.dates[i]}</b>`]
        for (const p of ps) {
          if (p.value === null || p.value === undefined) continue
          const n = p.seriesName as string
          const raw = Array.isArray(p.value) ? p.value[1] : p.value
          if (n.includes('价')) lines.push(`${p.marker}${n}：${money(raw)}`)
          else if (n.includes('BSR')) lines.push(`${p.marker}${n}：#${raw}`)
          else if (n === '运营动作') lines.push(`${p.marker}<b>${p.data?.name ?? '运营动作'}</b>`)
          else lines.push(`${p.marker}${n}：${Math.round(Number(raw)).toLocaleString()}`)
        }
        // 秒杀时段只在原始串里，有就补一行
        const ldRaw = d.price.ldRaw[i]
        if (ldRaw) lines.push(`秒杀：${ldRaw}`)
        return lines.join('<br/>')
      },
    },
    legend: { bottom: 0, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: 56, right: 88, top: 24, bottom: 56 },
    xAxis: { type: 'category', data: d.dates, axisLabel: { fontSize: 10 } },
    yAxis: [
      {
        type: 'value',
        name: '流量得分',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10, formatter: (v: number) => (v >= 1000 ? `${v / 1000}k` : String(v)) },
        splitLine: { lineStyle: { type: 'dashed' } },
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
        offset: 44,
        // ⚠️ 倒置：BSR 越小越好，正序会让"排名变好"表现为折线下探
        inverse: true,
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10, formatter: (v: number) => `#${v}` },
        splitLine: { show: false },
      },
    ],
    // 60 个以上点位时给缩放条，否则 x 轴标签糊成一团
    dataZoom:
      d.dates.length > 45
        ? [{ type: 'slider', height: 16, bottom: 26, start: 50, end: 100 }]
        : undefined,
    series: [
      {
        name: '自然流量',
        type: 'bar',
        stack: 'traffic',
        yAxisIndex: 0,
        data: t.nf,
        itemStyle: { color: '#1AB364' },
        barMaxWidth: 14,
      },
      {
        name: '广告流量',
        type: 'bar',
        stack: 'traffic',
        yAxisIndex: 0,
        data: t.ad,
        itemStyle: { color: '#F0AA11' },
        barMaxWidth: 14,
      },
      {
        name: '购物车价',
        type: 'line',
        yAxisIndex: 1,
        data: d.price.buybox,
        symbol: 'none',
        lineStyle: { width: 1.6, color: '#3B82F6' },
        itemStyle: { color: '#3B82F6' },
      },
      {
        name: '秒杀价',
        type: 'line',
        yAxisIndex: 1,
        data: d.price.ld,
        // ⚠️ connectNulls 保持 false：稀疏日（实测 356 天仅 36 天有秒杀）
        //    连起来会画出一条"每天都在秒杀"的假线
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 0 },
        itemStyle: { color: '#D95140' },
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
        name: '运营动作',
        type: 'scatter',
        yAxisIndex: 0,
        data: eventPoints,
        symbol: 'pin',
        symbolSize: 20,
        itemStyle: { color: '#E2521E' },
      },
    ],
  }
})
</script>

<template>
  <div class="page">
    <h1 class="page-title">查流量结构</h1>
    <p class="page-desc">拆解 Listing 的自然流量与各类广告流量的构成比例</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <!-- 加载骨架：请求飞行期间避免页面空白 -->
    <QuerySkeleton v-if="loading && !data" />

    <!--
      流量时光机：按月回看这个 Listing 的流量结构。
      只列出确实有数据的月份 —— 各 ASIN 采集起点不同，补全中间空月会让用户选到空页。
    -->
    <div v-if="data && months.length > 1" class="tm-bar">
      <span class="tm-label">流量时光机</span>
      <el-select
        v-model="currentMonth"
        size="small"
        style="width: 132px"
        :disabled="loading"
        @change="onMonthChange"
      >
        <el-option v-for="m in months" :key="m" :label="m" :value="m" />
      </el-select>
      <span class="tm-hint">共 {{ months.length }} 个月有数据</span>
    </div>

    <template v-if="data">
      <!--
        三块分布在**同一张卡**里横排（对齐原站）。
        原先拆成两张卡（自然-广告 + 广告细分一张、推荐专栏另一张），
        推荐专栏被挤到第二屏，而这三块本是一组「这个 Listing 的流量从哪来」，
        分开看就要上下滚动来回对照。
      -->
      <div class="card dist-card">
        <div class="dist-grid">
          <!-- 分块 1：自然 vs 广告 -->
          <section class="dist-col">
            <header class="dist-head">
              <h2 class="sec-title">Listing 自然-广告流量分布</h2>
            </header>
            <div class="bars">
              <div v-for="b in overviewBars" :key="b.name" class="bar-row">
                <span class="bar-label">{{ b.name }}</span>
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    :style="{ width: barWidthOf(overviewBars, b.ratio), background: b.color }"
                  >
                    <span class="bar-score">{{ scoreText(b.score) }}</span>
                  </div>
                </div>
                <span class="bar-pct">{{ pct(b.ratio) }}</span>
              </div>
            </div>
          </section>

          <!-- 分块 2：广告细分 -->
          <section class="dist-col">
            <header class="dist-head">
              <h2 class="sec-title">广告流量分布</h2>
              <el-button
                size="small"
                @click="router.push({ name: 'ads', query: { asin } })"
              >
                查广告架构
              </el-button>
            </header>
            <el-empty v-if="!adBars.length" description="暂无广告流量" :image-size="54" />
            <div v-else class="bars">
              <div v-for="b in adBars" :key="b.name" class="bar-row">
                <span class="bar-label">{{ b.name }}</span>
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    :style="{ width: barWidthOf(adBars, b.ratio), background: b.color }"
                  >
                    <span class="bar-score">{{ scoreText(b.score) }}</span>
                  </div>
                </div>
                <span class="bar-pct">{{ pct(b.ratio) }}</span>
              </div>
            </div>
          </section>

          <!-- 分块 3：推荐专栏 -->
          <section class="dist-col">
            <!--
              原站这里还有个「查推荐专栏」按钮，本项目尚未实现那个页面
              （路由表里没有 rec-columns），所以不放按钮 —— 放了点下去是 404。
            -->
            <header class="dist-head">
              <h2 class="sec-title">推荐专栏流量分布</h2>
            </header>
            <el-empty
              v-if="!recBars.length"
              description="暂无推荐专栏流量"
              :image-size="54"
            />
            <!-- 专栏数量不固定（原站没有枚举），多了就在本栏内滚动，不撑高整张卡 -->
            <div v-else class="bars bars-scroll">
              <div v-for="b in recBars" :key="b.title" class="bar-row">
                <span class="bar-label" :title="b.title">{{ b.name }}</span>
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    :style="{ width: barWidthOf(recBars, b.ratio), background: b.color }"
                  />
                </div>
                <span class="bar-pct">{{ pct(b.ratio) }}</span>
              </div>
            </div>
          </section>
        </div>
        <p class="hint muted">
          推荐专栏是动态实体：原站没有固定枚举，专栏标题由后端下发，新标题会自动入库。
        </p>
      </div>

      <!--
        区块 1.5：日粒度复合图。
        数据来自本次新建的 fact_asin_daily_snapshot，只灌了部分 ASIN，
        所以 daily 为空时整块不渲染（而不是显示一张空图）。
      -->
      <div v-if="daily && daily.days" class="card">
        <div class="card-head">
          <div class="head-left">
            <h2 class="sec-title">价格、流量与运营动作</h2>
            <el-radio-group
              :model-value="dailyDays"
              size="small"
              @update:model-value="onDailyDaysChange(Number($event))"
            >
              <el-radio-button :value="30">30 天</el-radio-button>
              <el-radio-button :value="60">60 天</el-radio-button>
              <el-radio-button :value="90">90 天</el-radio-button>
            </el-radio-group>
          </div>
          <span class="muted small">共 {{ daily.days }} 天</span>
        </div>
        <BaseChart v-if="dailyOption" :option="dailyOption" height="360px" />
        <p class="hint muted">
          三条纵轴量纲不同：左轴流量得分（柱状，自然 + 广告堆叠），右轴价格，最右轴 BSR
          <b>已倒置</b>（名次越小越靠前，所以线往上走代表排名变好）。
          橙色图钉是运营动作，悬停看详情。秒杀价是稀疏点不连线 —— 只有真正做了秒杀的那几天才有。
        </p>
      </div>

      <!--
        区块 1.6：流量变化归因。
        原站在「查流量(词)」页用它回答「为什么这个词的流量变了」。
      -->
      <div v-if="attribution && attribution.items.length" class="card">
        <div class="card-head">
          <div class="head-left">
            <h2 class="sec-title">流量变化归因</h2>
            <span class="muted small">
              {{ attribution.statDate }} · {{ attribution.granularity === 'month' ? '月度' : '日度' }}
            </span>
          </div>
          <span class="muted small">{{ attribution.items.length }} 个词</span>
        </div>
        <el-table :data="attribution.items" size="small" max-height="420">
          <el-table-column label="流量词" min-width="180">
            <template #default="{ row }">
              <div class="kw-cell">
                <span class="kw">{{ row.keyword }}</span>
                <span v-if="row.translateKeyword" class="muted small">{{ row.translateKeyword }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="流量变化" width="128" align="right">
            <template #default="{ row }">
              <!-- 正负用颜色区分，并显式带符号 —— 光看数字容易漏掉负号 -->
              <span
                v-if="row.contriChange !== null"
                class="mono"
                :class="row.contriChange >= 0 ? 'up' : 'down'"
              >
                {{ row.contriChange >= 0 ? '+' : '' }}{{ Math.round(row.contriChange).toLocaleString() }}
              </span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="周搜索量" width="112" align="right">
            <template #default="{ row }">
              <span class="mono">{{ row.searchVolume?.toLocaleString() ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="影响原因" min-width="300">
            <template #default="{ row }">
              <span v-if="row.reasonSummary">{{ row.reasonSummary }}</span>
              <!-- 源没归因时说清楚是"没给原因"，不是"没有原因" -->
              <span v-else class="muted">源未给出归因</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 区块 2：流量结构表格 -->
      <div class="card">
        <div class="card-head">
          <div class="head-left">
            <h2 class="sec-title">流量结构</h2>
            <!--
              维度 tab：不同变体 / 不同 Color / 不同 Size。
              tab 由后端下发的 dimensions 生成，不写死 —— 不同商品维度不一样
              （抱枕有 Color+Size，SSD 只有 Size）。
              切 tab 要重新请求：属性聚合与列内占比都在后端算，
              前端二次聚合等于把同一套口径实现两遍。
            -->
            <el-radio-group
              :model-value="tableDim"
              size="small"
              @update:model-value="loadDimension(String($event))"
            >
              <el-radio-button
                v-for="t in dimTabs"
                :key="t.value"
                :value="t.value"
              >
                {{ t.label }}
              </el-radio-button>
            </el-radio-group>
          </div>
          <div class="head-right">
            <!-- 图例只在堆积模式需要，放表头一次不在每行重复 -->
            <div v-if="viewMode === 'stack'" class="legend">
              <span v-for="k in channelKeys" :key="k" class="legend-item">
                <i class="dot sm" :style="{ background: CHANNEL_META[k].color }" />
                {{ CHANNEL_META[k].name }}
              </span>
            </div>
            <!-- 展示流量得分：分列模式下控制条内是否写得分数字（原站同名勾选框） -->
            <el-checkbox v-if="viewMode === 'split'" v-model="showScore" size="small">
              展示流量得分
            </el-checkbox>
            <el-radio-group v-model="viewMode" size="small">
              <el-radio-button value="split">分列对比模式</el-radio-button>
              <el-radio-button value="stack">堆积图模式</el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <el-table
          v-loading="tableLoading"
          :data="variantRows"
          stripe
          style="width: 100%"
        >
          <el-table-column type="index" label="#" width="52" />
          <!--
            首列：变体模式是「图片 + ASIN + 属性摘要」（对齐原站），
            属性模式是属性取值 + 成员变体数。
          -->
          <el-table-column :label="firstColLabel" min-width="188">
            <template #default="{ row }">
              <div class="id-cell">
                <img v-if="row.img" :src="row.img" class="id-img" alt="" />
                <span v-else class="id-img id-img-ph" />
                <span class="id-text">
                  <span :class="tableDim === 'variant' ? 'mono id-main' : 'id-main'">
                    {{ tableDim === 'variant' ? row.asin : row.dimensionValue }}
                  </span>
                  <span v-if="rowSubtitle(row)" class="id-sub">{{ rowSubtitle(row) }}</span>
                </span>
              </div>
            </template>
          </el-table-column>

          <!--
            堆积图模式：一根彩色条，**数字写在段内**。
            原先把 5 个「色点 + 名称 + 百分比」平铺在条下面，占两行且
            要在图例与色段之间来回对照。现在够宽的段直接显示百分比，
            窄段靠 hover 的 title 看 —— 行高省一半，也不用对照。
          -->
          <el-table-column v-if="viewMode === 'stack'" label="自然-广告流量分布" min-width="260">
            <template #default="{ row }">
              <div class="stack">
                <div
                  v-for="k in channelKeys"
                  :key="k"
                  class="stack-seg"
                  :style="{ width: segWidth(row, k), background: CHANNEL_META[k].color }"
                  :title="`${CHANNEL_META[k].name} ${((row.channels?.[k]?.ratio ?? 0) * 100).toFixed(1)}%`"
                >
                  {{ segLabel(row, k) }}
                </div>
              </div>
            </template>
          </el-table-column>

          <!--
            分列模式的列序对齐原站：
              总流量占比 → 自然-广告流量分布（迷你堆积） → 各渠道占比
            「占比」用的是后端的 channelShares（列内占比：本行该渠道 ÷ 全组该渠道），
            不是 channels[].ratio（行内构成比）。实测原站第 1 行「自然流量占比 43%」
            等于 nf 49,583.6 ÷ 全组 nf 115,485.3 = 42.9%，证实是前者。
          -->
          <template v-else>
            <el-table-column label="总流量占比" min-width="132">
              <template #default="{ row }">
                <div class="cell-metric">
                  <div class="cell-bar">
                    <div
                      class="cell-fill cell-fill-total"
                      :style="{ width: totalBarWidth(row) }"
                    >
                      <span v-if="showScore" class="cell-score">{{ scoreText(row.total) }}</span>
                    </div>
                  </div>
                  <span class="cell-num">{{ pct(row.totalShare) }}</span>
                </div>
              </template>
            </el-table-column>

            <!--
              自然-广告流量分布：一根两段的迷你堆积条，两侧写百分比。
              这里用的是**行内构成比**（自然占本行 total 多少），与相邻的
              「占比」列口径不同，所以左右各标一个数字，避免被读成同一口径。
            -->
            <el-table-column label="自然-广告流量分布" min-width="188">
              <template #default="{ row }">
                <div class="split-dist">
                  <span class="sd-pct">{{ pct(row.channels?.nf?.ratio) }}</span>
                  <div class="sd-track">
                    <div
                      class="sd-nf"
                      :style="{ width: `${(row.channels?.nf?.ratio ?? 0) * 100}%` }"
                    />
                    <div
                      class="sd-ad"
                      :style="{ width: `${(1 - (row.channels?.nf?.ratio ?? 0)) * 100}%` }"
                    />
                  </div>
                  <span class="sd-pct">{{ pct(1 - (row.channels?.nf?.ratio ?? 0)) }}</span>
                </div>
              </template>
            </el-table-column>

            <el-table-column
              v-for="k in channelKeys"
              :key="k"
              :label="`${CHANNEL_META[k].name}流量占比`"
              min-width="132"
            >
              <template #default="{ row }">
                <div class="cell-metric">
                  <div class="cell-bar">
                    <div
                      class="cell-fill"
                      :style="{
                        width: shareBarWidth(row, k),
                        background: CHANNEL_META[k].color,
                      }"
                    >
                      <span v-if="showScore" class="cell-score">
                        {{ scoreText(row.channels?.[k]?.score) }}
                      </span>
                    </div>
                  </div>
                  <span class="cell-num">{{ pct(row.channelShares?.[k]) }}</span>
                </div>
              </template>
            </el-table-column>
          </template>

          <!-- 堆积模式才单列显示总得分；分列模式的得分已写在条内 -->
          <el-table-column
            v-if="viewMode === 'stack'"
            label="总流量得分"
            width="112"
            align="right"
          >
            <template #default="{ row }">
              <span class="mono">{{ scoreText(row.total) }}</span>
            </template>
          </el-table-column>
        </el-table>

        <!--
          必须说明条宽口径。分列模式下条按**列内最大值**归一，
          所以 SBV 列里 0.8% 也会画成满条 —— 不说清会被误读成「占 80%」。
        -->
        <p class="hint muted">
          <template v-if="viewMode === 'split'">
            「占比」为该行该渠道占<strong>全部行该渠道之和</strong>的比例（同列可横向比较）；
            条长按该列最大值归一，不代表占满 100%。
            「自然-广告流量分布」是该行内部的构成比，与占比列口径不同。
            某渠道整组都无流量时显示 0。
          </template>
          <template v-else>
            条内百分比为该行各流量渠道的构成比；窄段的数值悬停可见。
          </template>
        </p>
      </div>

      <!-- AI 插入点 3：流量构成诊断 -->
      <AiAnalysisCard
        insert-point="traffic-insight"
        title="AI 流量构成诊断"
        :input="{
          asin: data.asin,
          country: data.country,
          channels: [data.overview.natural, data.overview.ad, ...data.adBreakdown]
            .filter(Boolean)
            .map((c: any) => ({ channel: c.channel, name: c.name, ratio: c.ratio })),
        }"
      />
    </template>

    <el-empty v-else-if="!loading" description="输入 ASIN 开始查询" :image-size="90" />
  </div>
</template>

<style scoped>
/* 流量时光机的月份选择条 */
.tm-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.tm-label {
  font-size: 13px;
  font-weight: 600;
}

.tm-hint {
  font-size: 12px;
  color: var(--text-muted, #909399);
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

.head-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.sec-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.card-head .sec-title,
.dist-head .sec-title {
  margin: 0;
}

/* ---- 上方三块分布：同一张卡内三栏 ---- */
.dist-grid {
  display: grid;
  /* 三等分。分隔线用 gap + border-left，不用额外元素 */
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}

/* 窄屏落到单栏，否则每栏不足 300px 时标签会被压成两行 */
@media (max-width: 1100px) {
  .dist-grid {
    grid-template-columns: 1fr;
  }
}

.dist-col {
  min-width: 0;
}

.dist-col + .dist-col {
  padding-left: 20px;
  border-left: 1px solid var(--line);
}

@media (max-width: 1100px) {
  .dist-col + .dist-col {
    padding-left: 0;
    border-left: none;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
}

.dist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  min-height: 24px;
}

/* ---- 横条：标签 + 条 + 百分比 ---- */
.bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 专栏数不固定，超高就在本栏内滚动，不把整张卡撑长 */
.bars-scroll {
  max-height: 148px;
  overflow-y: auto;
}

.bar-row {
  display: grid;
  /* 标签定宽、百分比定宽，中间条自适应 —— 三块的条左右边界因此对齐 */
  grid-template-columns: 74px 1fr 42px;
  align-items: center;
  gap: 8px;
}

.bar-label {
  font-size: 12px;
  color: var(--ink-700);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar-track {
  height: 18px;
  background: var(--ink-100);
  border-radius: 3px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 3px;
  display: flex;
  align-items: center;
  padding-left: 5px;
  transition: width 0.2s;
}

/* 得分写在条内。白字加阴影，浅色条（SBV 的黄）上也读得清 */
.bar-score {
  font-size: 10.5px;
  line-height: 1;
  color: #fff;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bar-pct {
  font-size: 12px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--ink-700);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex-shrink: 0;
}

.dot.sm {
  width: 7px;
  height: 7px;
}

/* ---- 表格首列：图片 + 标识 + 属性 ---- */
.id-cell {
  display: flex;
  align-items: center;
  gap: 9px;
}

.id-img {
  width: 34px;
  height: 34px;
  object-fit: contain;
  border-radius: 4px;
  background: #fff;
  flex-shrink: 0;
}

/* 无图占位：留同尺寸，保证有图/无图的行高一致 */
.id-img-ph {
  background: var(--ink-100);
}

.id-text {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  min-width: 0;
}

.id-main {
  font-size: 12.5px;
}

.id-sub {
  font-size: 11.5px;
  color: var(--ink-500);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 分列模式：自然-广告迷你堆积条 ---- */
.split-dist {
  display: flex;
  align-items: center;
  gap: 7px;
}

.sd-track {
  flex: 1;
  min-width: 40px;
  display: flex;
  height: 14px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--ink-100);
}

.sd-nf {
  background: #1ab364;
}

.sd-ad {
  background: #f0aa11;
}

.sd-pct {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-700);
  flex-shrink: 0;
  min-width: 30px;
  text-align: right;
}

/* ---- 流量结构表格 ---- */

.head-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* 图例只在表头出现一次 */
.legend {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--ink-500);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 堆积条：数字写在段内，高度够容纳文字 */
.stack {
  display: flex;
  height: 18px;
  width: 100%;
  border-radius: 3px;
  overflow: hidden;
  background: var(--ink-100);
}

.stack-seg {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  line-height: 1;
  color: #fff;
  /* 彩色底上的白字加一点阴影，浅色段（SBV 的黄）才读得清 */
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.45);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  white-space: nowrap;
  transition: width 0.2s;
}

/* 分列模式的单元格：条 + 数字 */
.cell-metric {
  display: flex;
  align-items: center;
  gap: 7px;
}

/*
  条高 18px 而不是原来的 6px —— 得分要写在条内，6px 装不下文字。
  「展示流量得分」关掉时条内没有文字，但高度保持一致，
  否则勾选框一点行高就跳一下。
*/
.cell-bar {
  flex: 1;
  min-width: 34px;
  height: 18px;
  background: var(--ink-100);
  border-radius: 3px;
  overflow: hidden;
}

.cell-fill {
  height: 100%;
  border-radius: 3px;
  display: flex;
  align-items: center;
  padding-left: 4px;
  transition: width 0.2s;
}

/* 总流量占比列没有专属渠道色，用品牌绿→黄的渐变与原站观感一致 */
.cell-fill-total {
  background: linear-gradient(90deg, #1ab364, #b8c718);
}

/*
  得分写在条内。条很窄时（占比接近 0）文字会被 overflow 裁掉 ——
  这是有意的：宁可看不见也不要溢出到相邻列上，精确值看右侧百分比或悬停。
*/
.cell-score {
  font-size: 10.5px;
  line-height: 1;
  color: #fff;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cell-num {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-700);
  flex-shrink: 0;
  min-width: 34px;
  text-align: right;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
}

/* ---- 流量变化归因表 ---- */

.small {
  font-size: 11.5px;
}

.kw-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.35;
}

.kw-cell .kw {
  font-weight: 500;
}

/* 涨跌用颜色区分。绿涨红跌，与页面其他处的流量色一致（#1AB364 / #D95140） */
.up {
  color: #1ab364;
}

.down {
  color: #d95140;
}
</style>
