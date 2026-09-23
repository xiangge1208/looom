<script setup lang="ts">
import { computed } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

/**
 * 按需注册 ECharts 组件，避免全量打包（全量约 1MB）。
 *
 * ⚠️ **忘记注册不会报错，图表会静默不画**。加新图表类型或新组件
 * （markLine / dataZoom / scatter …）时必须在这里补一行，否则调试会很久
 * 才发现是注册问题而不是数据问题。
 *
 * Scatter    —— 运营事件散点（因果图上标 Coupon / 改标题 / 秒杀）
 * DataZoom   —— 83 天因果图的区间缩放（点位太密时需要拖拽）
 * MarkLine   —— 事件竖线（TimelineView 在用）
 * MarkPoint  —— 极值标注
 */
use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
])

/**
 * 图表容器
 *
 * 统一处理：
 *   - 高度（ECharts 必须有确定高度才渲染）
 *   - 加载态
 *   - 空数据（避免显示一片空白，用户不知道是没数据还是坏了）
 */
const props = defineProps<{
  option: any
  height?: string
  loading?: boolean
  /** 数据为空时的提示文案 */
  emptyText?: string
}>()

const isEmpty = computed(() => {
  const opt = props.option
  if (!opt) return true
  const series = opt.series
  if (!series) return true
  const arr = Array.isArray(series) ? series : [series]
  return arr.length === 0 || arr.every((s: any) => !s.data || s.data.length === 0)
})

const style = computed(() => ({ height: props.height ?? '320px' }))
</script>

<template>
  <div class="chart-wrap" :style="style" v-loading="loading">
    <div v-if="isEmpty && !loading" class="chart-empty">
      <span class="muted">{{ emptyText ?? '暂无数据' }}</span>
    </div>
    <VChart v-else :option="option" autoresize class="chart" />
  </div>
</template>

<style scoped>
.chart-wrap {
  position: relative;
  width: 100%;
}

.chart {
  width: 100%;
  height: 100%;
}

.chart-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  background: var(--ink-50);
  border-radius: var(--radius);
}
</style>
