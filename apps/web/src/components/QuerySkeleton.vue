<script setup lang="ts">
/**
 * 查询页的加载骨架
 *
 * 为什么需要：P4 排查发现 sales / traffic / variations / timeline 四页
 * 在请求飞行期间**完全不渲染内容** —— 只有标题和搜索框，
 * 连 spinner 都没有（只有搜索按钮自己在转）。慢网络下看起来像「点了没反应」。
 *
 * 这里按「概要卡 + 图表卡 + 表格卡」的常见结构给一份通用骨架。
 * 各页面的真实布局不完全一样，但骨架的作用是占位和传达「正在加载」，
 * 不需要像素级还原真实布局 —— 过度还原反而会在布局调整后变成维护负担。
 *
 * ⚠️ chart / table 两个 prop 必须用 withDefaults 显式给 true。
 *
 * Vue 对声明为 `boolean` 的 prop 做了「Boolean casting」：
 * 父组件不传时值是 **false** 而不是 undefined。
 * 所以最初写的 `v-if="chart !== false"` 恒为 false，
 * 实测四个页面的骨架只渲染出概要卡，图表和表格块全都不见 ——
 * 源码看起来完全正常，只有在浏览器里数 DOM 才发现。
 */
withDefaults(
  defineProps<{
  /** 是否含图表占位 */
    chart?: boolean
    /** 是否含表格占位 */
    table?: boolean
  }>(),
  { chart: true, table: true },
)
</script>

<template>
  <div class="skeleton-wrap" role="status" aria-busy="true" aria-live="polite">
    <span class="sr-only">正在加载数据</span>

    <!-- 概要卡 -->
    <div class="card sk-summary">
      <div class="sk-row">
        <div class="sk-thumb" />
        <div class="sk-lines">
  <div class="sk-line w70" />
  <div class="sk-line w40" />
          <div class="sk-line w55" />
      </div>
      </div>
  </div>

    <!-- 图表卡 -->
       <div v-if="chart" class="card">
  <div class="sk-line w30 mb" />
      <div class="sk-chart" />
    </div>

    <!-- 表格卡 -->
    <div v-if="table" class="card">
      <div class="sk-line w25 mb" />
      <div v-for="i in 5" :key="i" class="sk-tr">
        <div class="sk-line w20" />
        <div class="sk-line w45" />
 <div class="sk-line w15" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.skeleton-wrap {
  /* 骨架整体略微降低对比，避免被误认为真实内容 */
  opacity: 0.85;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.card + .card {
  margin-top: 14px;
}

.sk-row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.sk-thumb {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  flex-shrink: 0;
  background: var(--ink-100, #f0f2f5);
  animation: sk-pulse 1.4s ease-in-out infinite;
}

.sk-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sk-line {
  height: 12px;
  border-radius: 4px;
  background: var(--ink-100, #f0f2f5);
  animation: sk-pulse 1.4s ease-in-out infinite;
}

.sk-chart {
  height: 200px;
  border-radius: 6px;
  background: var(--ink-100, #f0f2f5);
  animation: sk-pulse 1.4s ease-in-out infinite;
}

.sk-tr {
  display: flex;
  gap: 14px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}

.sk-tr:last-child {
  border-bottom: none;
}

.mb {
  margin-bottom: 14px;
}

.w15 { width: 15%; }
.w20 { width: 20%; }
.w25 { width: 25%; }
.w30 { width: 30%; }
.w40 { width: 40%; }
.w45 { width: 45%; }
.w55 { width: 55%; }
.w70 { width: 70%; }

@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* 尊重系统的「减少动态效果」设置 */
@media (prefers-reduced-motion: reduce) {
  .sk-thumb,
  .sk-line,
  .sk-chart {
    animation: none;
  }
}
</style>
