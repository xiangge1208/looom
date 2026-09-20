<script setup lang="ts">
import { computed } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

// 按需注册 ECharts 组件，避免全量打包（全量约 1MB）
use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
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
