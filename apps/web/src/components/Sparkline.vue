<script setup lang="ts">
import { computed } from 'vue'

/**
 * 行内迷你趋势图（面积图 + 峰值标注）
 *
 * 对应原站「月销量趋势」列：每个变体一条带峰值标注的小面积图。
 *
 * ## 为什么用手写 SVG 而不是 BaseChart（ECharts）
 *
 * 这个组件会在表格里按行重复渲染，变体多时可能有几十个实例。
 * 每个 ECharts 实例都要建 canvas + 注册事件 + 走一遍布局计算，
 * 几十个叠加会让表格滚动明显掉帧；而 sparkline 只需要一条折线，
 * 用不到 ECharts 的坐标轴/图例/交互体系。
 *
 * SVG 方案单行只有两个 path 节点，渲染成本可以忽略，
 * 也天然跟随字号缩放。代价是没有 hover tooltip —— 精确值本来
 * 就在同行的「近一月销量」列里，这里只负责传达趋势形状。
 */
const props = withDefaults(
  defineProps<{
    /** 逐月数值。null 表示该月无数据（会断线，不补零） */
    values: (number | null)[]
    /** 峰值处要标注的文案，通常是销量分档如 "200+" */
    peakLabel?: string | null
    width?: number
    height?: number
    color?: string
  }>(),
  { width: 140, height: 40, color: '#1AB364', peakLabel: null },
)

/** 左右各留 2px，避免描边被裁掉；顶部留出标注空间 */
const PAD_X = 2
const PAD_TOP = 12
const PAD_BOTTOM = 2

const points = computed(() => {
  const vals = props.values ?? []
  if (!vals.length) return []

  // 只对有值的点做缩放；全空则不画
  const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v))
  if (!nums.length) return []

  const max = Math.max(...nums)
  const min = Math.min(...nums)
  // 全平时给个虚拟跨度，否则除零会让所有点落在同一行
  const span = max - min || max || 1

  const innerW = props.width - PAD_X * 2
  const innerH = props.height - PAD_TOP - PAD_BOTTOM
  const stepX = vals.length > 1 ? innerW / (vals.length - 1) : 0

  return vals.map((v, i) => ({
    x: PAD_X + stepX * i,
    // 数值越大越靠上，所以用 innerH 减去归一化后的高度
    y:
      v === null || !Number.isFinite(v)
        ? null
        : PAD_TOP + innerH - ((v - min) / span) * innerH,
    value: v,
  }))
})

/**
 * 折线路径。遇到 null 就断开（用 M 重新起笔），不补零 ——
 * 补零会凭空画出一个「销量跌到 0」的假谷底。
 */
const linePath = computed(() => {
  let d = ''
  let penDown = false
  for (const p of points.value) {
    if (p.y === null) {
      penDown = false
      continue
    }
    d += `${penDown ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `
    penDown = true
  }
  return d.trim()
})

/**
 * 面积填充路径。按连续段分别闭合，避免跨越断点时
 * 把缺数据的区间也填上颜色。
 */
const areaPath = computed(() => {
  const baseY = props.height - PAD_BOTTOM
  let d = ''
  let seg: { x: number; y: number }[] = []

  const flush = () => {
    if (seg.length < 2) {
      seg = []
      return
    }
    d += `M${seg[0].x.toFixed(1)} ${baseY} `
    for (const p of seg) d += `L${p.x.toFixed(1)} ${p.y.toFixed(1)} `
    d += `L${seg[seg.length - 1].x.toFixed(1)} ${baseY} Z `
    seg = []
  }

  for (const p of points.value) {
    if (p.y === null) flush()
    else seg.push({ x: p.x, y: p.y })
  }
  flush()
  return d.trim()
})

/** 峰值点，用于放标注和高亮圆点 */
const peak = computed(() => {
  const valid = points.value.filter(
    (p): p is { x: number; y: number; value: number } => p.y !== null,
  )
  if (!valid.length) return null
  return valid.reduce((best, p) => (p.value > best.value ? p : best), valid[0])
})

/** 最后一个有值的点，原站在末端有个红色圆点标「当前」 */
const last = computed(() => {
  const valid = points.value.filter(
    (p): p is { x: number; y: number; value: number } => p.y !== null,
  )
  return valid.length ? valid[valid.length - 1] : null
})

/** 标注文字要避免超出左右边界 */
const peakLabelX = computed(() => {
  if (!peak.value) return 0
  const half = 18
  return Math.min(Math.max(peak.value.x, half), props.width - half)
})

const hasData = computed(() => points.value.some((p) => p.y !== null))
</script>

<template>
  <svg
    v-if="hasData"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    class="spark"
    role="img"
    :aria-label="peakLabel ? `销量趋势，峰值 ${peakLabel}` : '销量趋势'"
  >
    <path :d="areaPath" :fill="color" fill-opacity="0.16" stroke="none" />
    <path
      :d="linePath"
      fill="none"
      :stroke="color"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <!-- 末端点：标示序列的当前位置 -->
    <circle v-if="last" :cx="last.x" :cy="last.y" r="2.2" fill="#E5484D" />
    <!-- 峰值标注：原站在波峰上方标销量分档 -->
    <text
      v-if="peakLabel && peak"
      :x="peakLabelX"
      :y="Math.max(peak.y - 4, 9)"
      class="spark-label"
      text-anchor="middle"
    >
      {{ peakLabel }}
    </text>
  </svg>
  <span v-else class="muted spark-empty">—</span>
</template>

<style scoped>
.spark {
  display: block;
  overflow: visible;
}

.spark-label {
  font-size: 10.5px;
  font-weight: 600;
  fill: #e5484d;
  font-variant-numeric: tabular-nums;
}

.spark-empty {
  font-size: 12px;
}
</style>
