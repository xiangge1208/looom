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

/**
 * 被隐藏的系列名。
 *
 * 用「隐藏集」而不是「选中集」：默认全部显示，用户点掉哪个就记哪个。
 * 切换维度时必须清空 —— 否则上一维度的名字留在隐藏集里，
 * 切回来会发现线莫名其妙不见了。
 *
 * ⚠️ 定义在 trendOption **之前**：虽然 computed 惰性求值、放后面也能跑，
 * 但那样 trendOption 的依赖在源码里是「向下引用」，读代码时容易误判。
 */
const hiddenSeries = ref<Set<string>>(new Set())

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

/** 系列定义：图表用 data/color，图例 chip 用 img/asin/attr。两者同一个数据源 */
interface SeriesDef {
  /** 系列唯一标识，同时作为 ECharts series.name 和显隐集合的 key */
  name: string
  /** 「不同变体」模式下是该变体的 ASIN；属性聚合模式下为 null（一组含多个 ASIN） */
  asin: string | null
  /** 属性值文案，如 "Stone Cloud"、"1 Pair" */
  attr: string
  /** 缩略图。属性聚合模式取组内**第一个**变体的图作代表 */
  img: string | null
  color: string
  data: (number | null)[]
}

/**
 * 全部系列定义（**未经过显隐与分页过滤**）。
 *
 * ⚠️ 必须与 trendOption 分开算，链条只能是单向的
 * seriesDefs → pagedDefs → visibleDefs → trendOption。
 * 曾经让 chip 列表直接读 trendOption.series，结果是循环依赖：
 * 点掉一个系列 → 它被过滤掉 → chip 列表里也没了 →
 * 用户再也点不回来（实测计数从 6/6 变成 4/5）。
 */
const seriesDefs = computed<SeriesDef[]>(() => {
  const t = trend.value
  const ov = overview.value
  if (!t || !ov) return []

  const PALETTE = ['#4f46e5', '#0d9488', '#d97706', '#dc2626', '#7c3aed', '#0284c7']
  const labels = t.dates

  if (chartDimension.value === 'variant') {
    return t.series.map((s, i) => {
      const v = ov.variants.find((x) => x.asin === s.asin)
      return {
        name: shortName(s.asin, ov),
        asin: s.asin,
        attr: attrOf(s.asin, ov),
        img: v?.img ?? null,
        // 颜色按**原始下标**分配，过滤后不重排 —— 隐藏再显示时颜色不跳变
        color: PALETTE[i % PALETTE.length],
        // 缺月不要补 0（会被误读成销量归零），留 null 让 ECharts 断线
        data: s.values,
      }
    })
  }

  /**
   * 按属性值聚合：属于同一属性值的变体，其数值**求和**。
   *
   * ⚠️ 是求和不是求平均。判据来自原站两组截图：
   *   截图 1（不同变体）B09319MZJN 单条峰值 ~60,000
   *   截图 2（不同 Style）它所属的「1 Pair」组峰值 ~100,000
   * 组值**大于**成员值，而平均值必定 ≤ 成员最大值，所以只能是求和。
   *
   * 另一个角度：销量是「该变体卖了多少件」，同色多尺码的总销量
   * 就是把各尺码的件数加起来。求平均会凭空缩小一个数量级，
   * 也会让「组 > 单变体」这个自然关系消失。
   *
   * ⚠️ counts 用于区分「组内全部变体都缺该月数据」与「求和为 0」：
   * 前者要留 null 让它断线，后者是真实的 0（当月确实没卖）。
   * 直接判 `sum === 0 → null` 会把真实的零销量画成断线。
   */
  const groupMap = new Map<
    string,
    { sums: number[]; counts: number[]; img: string | null }
  >()
  t.series.forEach((s) => {
    const variant = ov.variants.find((v) => v.asin === s.asin)
    const key = variant?.features?.[chartDimension.value]
    if (!key) return
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        sums: labels.map(() => 0),
        counts: labels.map(() => 0),
        // 组内第一个变体的图作代表：同 Color 的各尺码主图基本一致，
        // 展示其中一张足以让用户认出这是哪个颜色
        img: variant?.img ?? null,
      })
    }
    const g = groupMap.get(key)!
    if (!g.img) g.img = variant?.img ?? null
    s.values.forEach((v, i) => {
      if (v !== null) {
        g.sums[i] += v
        g.counts[i] += 1
      }
    })
  })

  return [...groupMap.entries()].map(([key, g], i) => ({
    name: key,
    // 属性聚合模式下一条线对应多个 ASIN，没有单一 ASIN 可标
    asin: null,
    attr: key,
    img: g.img,
    color: PALETTE[i % PALETTE.length],
    // 该月组内一个变体都没数据 → null（断线）；有数据则求和（含真实的 0）
    data: g.sums.map((v, idx) => (g.counts[idx] ? v : null)),
  }))
})

/**
 * 折线图配置。
 *
 * 只做一件事：把 visibleDefs 转成 ECharts series。
 * 聚合逻辑在 seriesDefs、筛选逻辑在 visibleDefs，这里不要重复。
 */
const trendOption = computed(() => {
  const t = trend.value
  if (!t) return null

  const series = visibleDefs.value.map((d) => ({
    name: d.name,
    type: 'line',
    smooth: true,
    data: d.data,
    connectNulls: false,
    symbolSize: 4,
    itemStyle: { color: d.color },
    lineStyle: { color: d.color },
  }))

  return {
    tooltip: { trigger: 'axis' },
    /**
     * ⚠️ 不启用 ECharts 自带图例。
     *
     * 它固定占图表内一行高度（bottom 定位），而横轴月份标签是 40° 旋转的
     * 长文本，两者在同一块区域会重叠（图例压在月份上）。
     * 改用图表上方的自定义选择器（见模板），既避开横轴，
     * 又能做「每页 5 个」的固定分页 —— 自带图例的 scroll 模式只能横向滚动。
     *
     * legend 关闭后必须给 grid.bottom 留够旋转标签的高度，否则标签被裁掉。
     */
    legend: { show: false },
    grid: { left: 56, right: 16, top: 16, bottom: 64 },
    xAxis: {
      type: 'category',
      data: t.dates,
      axisLabel: { fontSize: 11, rotate: t.dates.length > 20 ? 40 : 0 },
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

/** 变体的属性值文案，如 "Stone Cloud"。过长截断，避免 chip 撑爆一行 */
function attrOf(vAsin: string, ov: SalesOverview) {
  const v = ov.variants.find((x) => x.asin === vAsin)
  return v ? Object.values(v.features).join(' ').slice(0, 18) : ''
}

/**
 * 变体简称：**ASIN + 属性值**。
 *
 * ⚠️ 不能只用属性值。实测 B0SEEDSSP0 这类商品每个变体只有一个独特 Size，
 * 只拼属性值会让「不同变体」模式的图例变成 `240 GB / 480 GB / 960 GB` ——
 * 与「不同 Size」模式**逐字相同**，用户看不出切换生效了。
 * 原站图例是 `B09319MZJN(我) Stone Cloud` 这种「ASIN + 属性」格式。
 *
 * 这个字符串同时是显隐集合的 key，所以必须唯一 —— 带上 ASIN 正好保证唯一。
 */
function shortName(vAsin: string, ov: SalesOverview) {
  const attr = attrOf(vAsin, ov)
  return attr ? `${vAsin} ${attr}` : vAsin
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

// ---- 分页 ----
// 每页 5 条。原站也是 5 条一页：变体数常达上百（实测有 124 个变体的商品），
// 全画出来是一团糊线，既看不出趋势也分不清颜色。
const LEGEND_PAGE_SIZE = 5
const legendPage = ref(1)

const legendTotalPages = computed(() =>
  Math.max(1, Math.ceil(seriesDefs.value.length / LEGEND_PAGE_SIZE)),
)

/**
 * 当前页的系列定义。
 *
 * ⚠️ 分页是**图表级**的，不只是图例级。
 * 原先的实现把全部系列都塞给 ECharts、只让图例分页，于是 16 个变体
 * 同时画在图上（用户截图里那团糊线），翻页只换了下面 5 个 chip 的文字，
 * 图一点没变 —— 看起来像「翻页没生效」。原站是每页只画 5 条。
 */
const pagedDefs = computed(() => {
  const start = (legendPage.value - 1) * LEGEND_PAGE_SIZE
  return seriesDefs.value.slice(start, start + LEGEND_PAGE_SIZE)
})

/** 真正进图表的系列：当前页 ∩ 未被点掉 */
const visibleDefs = computed(() =>
  pagedDefs.value.filter((d) => !hiddenSeries.value.has(d.name)),
)

/** 点击切换某系列的显隐 */
function toggleSeries(name: string) {
  const next = new Set(hiddenSeries.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  hiddenSeries.value = next
}

/** 全选 / 全不选当前页 */
function toggleAllOnPage() {
  const next = new Set(hiddenSeries.value)
  const allHidden = pagedDefs.value.every((d) => next.has(d.name))
  for (const d of pagedDefs.value) {
    if (allHidden) next.delete(d.name)
    else next.add(d.name)
  }
  hiddenSeries.value = next
}

/** 切换维度时重置状态：清空隐藏集、回到第 1 页 */
function onDimensionChange() {
  hiddenSeries.value = new Set()
  legendPage.value = 1
}
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
          <!--
            @change 必须接 onDimensionChange：切维度后旧维度的系列名
            会留在隐藏集里，导致新维度的线「天生是隐藏的」。
          -->
          <el-radio-group
            v-model="chartDimension"
            size="small"
            @change="onDimensionChange"
          >
            <el-radio-button
              v-for="d in dimensionOptions"
              :key="d.value"
              :value="d.value"
            >
              {{ d.label }}
            </el-radio-button>
          </el-radio-group>
        </div>

        <!--
          自定义图例。
          ⚠️ 放在图表**上方**，不用 ECharts 自带的 legend ——
          自带 legend 固定占图表内一行高度（bottom 定位），
          会与 40° 旋转的月份标签压在同一个区域上。
          自带 legend 也放不了缩略图，而原站图例是「色条 + 图片 + ASIN + 属性」。
        -->
        <div v-if="seriesDefs.length" class="legend-bar">
          <button
            v-for="d in pagedDefs"
            :key="d.name"
            type="button"
            class="chip"
            :class="{ off: hiddenSeries.has(d.name) }"
            :title="d.name + (hiddenSeries.has(d.name) ? '（已隐藏，点击显示）' : '（点击隐藏）')"
            @click="toggleSeries(d.name)"
          >
            <!-- 色条与折线同色，把图例项和图上的线对应起来 -->
            <i class="chip-line" :style="{ background: d.color }" />
            <img v-if="d.img" :src="d.img" class="chip-img" alt="" />
            <!-- 没图时留同尺寸占位，否则有图/无图的 chip 高度不齐 -->
            <span v-else class="chip-img chip-img-ph" />
            <span class="chip-text">
              <span class="chip-asin mono">{{ d.asin ?? d.attr }}</span>
              <span v-if="d.asin && d.attr" class="chip-attr">{{ d.attr }}</span>
            </span>
          </button>
        </div>

        <BaseChart :option="trendOption" :loading="loading" height="340px" />

        <!--
          翻页放图表**下方居中**（对齐原站）。
          放上面时它和维度切换、图例挤在一起，看不出是在给图表翻页。
        -->
        <div v-if="seriesDefs.length" class="chart-pager">
          <el-button
            v-if="legendTotalPages > 1"
            size="small"
            :disabled="legendPage <= 1"
            @click="legendPage--"
          >
            上一页
          </el-button>
          <span v-if="legendTotalPages > 1" class="pager-at">
            {{ legendPage }} / {{ legendTotalPages }}
          </span>
          <el-button
            v-if="legendTotalPages > 1"
            size="small"
            :disabled="legendPage >= legendTotalPages"
            @click="legendPage++"
          >
            下一页
          </el-button>
          <span class="muted sm">
            本页 {{ visibleDefs.length }} / {{ pagedDefs.length }} 条，共
            {{ seriesDefs.length }} 个{{ chartDimension === 'variant' ? '变体' : '取值' }}
          </span>
          <el-button link size="small" @click="toggleAllOnPage">
            本页全选/全不选
          </el-button>
        </div>

        <p class="hint muted">
          纵轴为销量分档下界（原站销量以区间形式给出，如「200+」），缺数据的月份断线不补零。
          <template v-if="seriesDefs.length > LEGEND_PAGE_SIZE">
            每页画 {{ LEGEND_PAGE_SIZE }} 条，用图表下方的翻页查看其余；点击上方图例可单独隐藏。
          </template>
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

/* ---- 自定义图例（替代 ECharts 自带图例，见 trendOption 的说明）---- */
/* 居中：只有 5 项，靠左会在宽屏上留一大片空白 */
.legend-bar {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

/*
  chip 用 button 而不是 div：可键盘聚焦，语义也正确。
  下面把浏览器默认的按钮样式抹掉，只保留我们的外观。
*/
.chip {
  display: flex;
  align-items: center;
  gap: 7px;
  font: inherit;
  padding: 4px 10px 4px 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--fill-2, #f5f5f5);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: opacity 0.15s, border-color 0.15s;
}

.chip:hover {
  border-color: var(--primary);
}

/* 隐藏态：整块淡出。不用删除线 —— 两行文字加删除线糊成一团 */
.chip.off {
  opacity: 0.4;
}

/* 与折线同色的短横，代替 ECharts 图例的色块 */
.chip-line {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  flex-shrink: 0;
}

.chip-img {
  width: 26px;
  height: 26px;
  object-fit: contain;
  border-radius: 4px;
  background: #fff;
  flex-shrink: 0;
}

/* 无图占位：留同样的位子，保证有图/无图的 chip 等高 */
.chip-img-ph {
  background: var(--ink-100, #f0f0f0);
}

.chip-text {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  min-width: 0;
}

.chip-asin {
  font-size: 11.5px;
  white-space: nowrap;
}

.chip-attr {
  font-size: 11px;
  color: var(--ink-500);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
}

/* 翻页条：图表下方居中（对齐原站） */
.chart-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.pager-at {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-700);
}

.chart-pager :deep(.el-button--small) {
  margin-left: 0;
}


</style>