<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { businessApi, type TrafficStructure } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import QuerySkeleton from '@/components/QuerySkeleton.vue'
import BaseChart from '@/components/BaseChart.vue'
import AiAnalysisCard from '@/components/AiAnalysisCard.vue'

/**
 * 查流量结构
 *
 * 对应原站 /search。
 * 三块分布图 + 分变体表格，展示模式支持「堆积图 / 分列对比」切换。
 */
const route = useRoute()
const router = useRouter()

const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const data = ref<TrafficStructure | null>(null)
const variantRows = ref<any[]>([])
const viewMode = ref<'stack' | 'split'>('stack')

async function search(v: string) {
  asin.value = v
  loading.value = true
  try {
    const [st, vt] = await Promise.all([
      businessApi.trafficStructure(v),
      businessApi.trafficVariants(v, 'US', 'variant'),
    ])
    data.value = st
    variantRows.value = vt.rows ?? []
    router.replace({ query: { ...route.query, asin: v } })
  } catch {
    data.value = null
    variantRows.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (asin.value) search(asin.value)
})

/** 自然 vs 广告 饼图 */
const overviewOption = computed(() => {
  const d = data.value
  if (!d?.overview.natural || !d?.overview.ad) return null
  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => `${p.name}<br/>得分 ${p.value.toLocaleString()}（${p.percent}%）`,
    },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: ['46%', '68%'],
        center: ['50%', '44%'],
        // 饼图不用 ECharts 内置标签，改用图例 + 下方明细，避免小占比标签重叠
        label: { show: false },
        data: [
          { name: '自然流量', value: d.overview.natural.score ?? 0, itemStyle: { color: '#1AB364' } },
          { name: '广告流量', value: d.overview.ad.score ?? 0, itemStyle: { color: '#F0AA11' } },
        ],
      },
    ],
  }
})

/** 广告细分横向条形图 */
const adOption = computed(() => {
  const d = data.value
  if (!d?.adBreakdown?.length) return null
  const items = [...d.adBreakdown].reverse()
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 100, right: 60, top: 10, bottom: 20 },
    xAxis: { type: 'value', axisLabel: { fontSize: 11 }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
    yAxis: {
      type: 'category',
      data: items.map((x) => x.name),
      axisLabel: { fontSize: 11 },
    },
    series: [
      {
        type: 'bar',
        data: items.map((x) => ({
          value: x.score ?? 0,
          itemStyle: { color: x.color || '#F2732F', borderRadius: [0, 3, 3, 0] },
        })),
        barWidth: '52%',
        label: {
          show: true,
          position: 'right',
          fontSize: 11,
          formatter: (p: any) => `${((items[p.dataIndex].ratio ?? 0) * 100).toFixed(1)}%`,
        },
      },
    ],
  }
})

/** 分变体表格的渠道列，按表格里实际出现的渠道动态生成 */
const CHANNEL_META: Record<string, { name: string; color: string }> = {
  nf: { name: '自然', color: '#1AB364' },
  sp: { name: 'SP常规', color: '#F2732F' },
  spRec: { name: 'SP推荐', color: '#FF8F18' },
  sb: { name: 'SB常规', color: '#FFB302' },
  sbv: { name: 'SBV', color: '#EEDB47' },
}

const channelKeys = Object.keys(CHANNEL_META)

/**
 * 推荐专栏条宽：按**组内最大值**归一。
 *
 * 原先写的是 `ratio * 100 * 6`（乘 6 放大），结果 46.9% 就画成满条，
 * 视觉和旁边的数字对不上 —— 这是在骗人。按最大值归一同样能拉开差距，
 * 但最长的那条对应的确实是最大值，读者的直觉不会被误导。
 */
function recBarWidth(ratio: number | null): string {
  const all = (data.value?.recommendColumns ?? []).map((c: any) => c.ratio ?? 0)
  const max = Math.max(...all, 0)
  if (max <= 0) return '0%'
  return `${Math.max(ratio ? 3 : 0, ((ratio ?? 0) / max) * 100)}%`
}

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
 * 各渠道占比普遍是个位数百分比（SBV 常在 1% 以下），按 100% 画所有条
 * 都会短到看不出差别，条就失去意义了。按列内最大值归一后，
 * 最强的那个变体占满格，其余按比例收缩 —— 一眼能看出谁在这个渠道更强。
 */
function barWidth(row: any, key: string): string {
  const max = Math.max(
    ...variantRows.value.map((r: any) => r.channels?.[key]?.ratio ?? 0),
    0,
  )
  if (max <= 0) return '0%'
  const r = row.channels?.[key]?.ratio ?? 0
  // 有值就至少给 4% 宽度，否则 0.2% 这种会渲染成一条看不见的线
  return `${Math.max(r > 0 ? 4 : 0, (r / max) * 100)}%`
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">查流量结构</h1>
    <p class="page-desc">拆解 Listing 的自然流量与各类广告流量的构成比例</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <!-- 加载骨架：请求飞行期间避免页面空白 -->
    <QuerySkeleton v-if="loading && !data" />

    <template v-if="data">
      <!-- 区块 1：自然 vs 广告 -->
      <div class="grid-2">
        <div class="card">
          <h2 class="sec-title">Listing 自然-广告流量分布</h2>
          <BaseChart :option="overviewOption" :loading="loading" height="240px" />
          <div class="legend-rows">
            <div class="legend-row">
              <span class="dot" style="background: #1AB364" />
              <span class="lr-name">自然流量</span>
              <span class="lr-val">{{ (data.overview.natural?.score ?? 0).toLocaleString() }}</span>
              <span class="lr-pct">
                {{ ((data.overview.natural?.ratio ?? 0) * 100).toFixed(1) }}%
              </span>
            </div>
            <div class="legend-row">
              <span class="dot" style="background: #F0AA11" />
              <span class="lr-name">广告流量</span>
              <span class="lr-val">{{ (data.overview.ad?.score ?? 0).toLocaleString() }}</span>
              <span class="lr-pct">
                {{ ((data.overview.ad?.ratio ?? 0) * 100).toFixed(1) }}%
              </span>
            </div>
          </div>
        </div>

        <!-- 区块 2：广告细分 -->
        <div class="card">
          <div class="card-head">
            <h2 class="sec-title">广告流量分布</h2>
            <el-button link type="primary" size="small" @click="router.push({ name: 'ads', query: { asin } })">
              查广告架构 →
            </el-button>
          </div>
          <BaseChart :option="adOption" :loading="loading" height="240px" />
        </div>
      </div>

      <!-- 区块 3：推荐专栏 -->
      <div class="card">
        <h2 class="sec-title">推荐专栏流量分布</h2>
        <el-empty
          v-if="!data.recommendColumns.length"
          description="该 Listing 暂无推荐专栏流量"
          :image-size="70"
        />
        <!--
          原先的两个问题：
          1. 条宽乘了 6 倍放大（46.9% 画成满条），视觉与数字对不上；
             改成按**组内最大值**归一 —— 同样能拉开差距，但不欺骗
          2. 百分比 3 位小数（46.900%），精度远超实际意义，改 1 位
        -->
        <div v-else class="rec-grid">
          <div v-for="c in data.recommendColumns" :key="c.recTitle" class="rec-item">
            <div class="rec-head">
              <span class="rec-name" :title="c.recTitle">{{ c.name }}</span>
              <span class="rec-pct">{{ ((c.ratio ?? 0) * 100).toFixed(1) }}%</span>
            </div>
            <div class="rec-bar">
              <div class="rec-fill" :style="{ width: recBarWidth(c.ratio) }" />
            </div>
            <div class="rec-meta muted">{{ c.campaignCount }} 个广告活动</div>
          </div>
        </div>
        <p class="hint muted">
          推荐专栏是动态实体：原站没有固定枚举，专栏标题由后端下发，新标题会自动入库。
        </p>
      </div>

      <!-- 区块 4：分变体表格 -->
      <div class="card">
        <div class="card-head">
          <h2 class="sec-title">分变体流量结构</h2>
          <div class="head-right">
            <!-- 图例放表头一次，不在每行重复（原先每行 5 项、占两行高） -->
            <div v-if="viewMode === 'stack'" class="legend">
              <span v-for="k in channelKeys" :key="k" class="legend-item">
                <i class="dot sm" :style="{ background: CHANNEL_META[k].color }" />
                {{ CHANNEL_META[k].name }}
              </span>
            </div>
            <el-radio-group v-model="viewMode" size="small">
              <el-radio-button value="stack">堆积图</el-radio-button>
              <el-radio-button value="split">分列对比</el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <el-table :data="variantRows" stripe style="width: 100%">
          <el-table-column type="index" label="#" width="52" />
          <el-table-column prop="asin" label="变体 ASIN" width="130">
            <template #default="{ row }">
              <span class="mono">{{ row.asin }}</span>
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
            分列模式：每渠道一列，格内是「条 + 数字」而不是裸百分比。
            裸数字要靠读者逐行比大小；带条能一眼看出哪个变体在哪个渠道更强
            （原站也是条+数字，见 SIF_UI_AUDIT §8c.2）。
            条宽按**列内最大值**归一，不是按 100% —— 渠道占比普遍是个位数
            百分比，按 100% 画的话所有条都短得看不出差别。
          -->
          <template v-else>
            <el-table-column
              v-for="k in channelKeys"
              :key="k"
              :label="CHANNEL_META[k].name"
              min-width="108"
            >
              <template #default="{ row }">
                <div class="cell-metric">
                  <div class="cell-bar">
                    <div
                      class="cell-fill"
                      :style="{
                        width: barWidth(row, k),
                        background: CHANNEL_META[k].color,
                      }"
                    />
                  </div>
                  <span class="cell-num">
                    {{ ((row.channels?.[k]?.ratio ?? 0) * 100).toFixed(1) }}%
                  </span>
                </div>
              </template>
            </el-table-column>
          </template>

          <el-table-column label="总流量得分" width="112" align="right">
            <template #default="{ row }">
              <span class="mono">{{ (row.total ?? 0).toLocaleString() }}</span>
            </template>
          </el-table-column>
        </el-table>

        <!--
          必须说明条宽口径。分列模式下条按**列内最大值**归一，
          所以 SBV 列里 0.8% 也会画成满条 —— 不说清会被误读成「占 80%」。
        -->
        <p class="hint muted">
          <template v-if="viewMode === 'split'">
            条长按<strong>该列最大值</strong>归一（便于同列横向比较），
            不代表占满 100%，实际占比看数字。
          </template>
          <template v-else>
            条内百分比为该变体各流量渠道的构成比；窄段的数值悬停可见。
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
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}

@media (max-width: 1000px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
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

.legend-rows {
  margin-top: 10px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  padding: 3px 0;
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

.lr-name {
  flex: 1;
  color: var(--ink-700);
}

.lr-val {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ink-500);
}

.lr-pct {
  width: 54px;
  text-align: right;
  font-weight: 500;
}

.rec-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

/* 名称与百分比同一行：数字紧邻条，不用视线在两行之间跳 */
.rec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
}

.rec-name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rec-pct {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-900);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.rec-bar {
  height: 6px;
  background: var(--ink-100);
  border-radius: 3px;
  overflow: hidden;
}

.rec-fill {
  height: 100%;
  background: var(--brand-500);
  border-radius: 3px;
}

.rec-meta {
  margin-top: 5px;
  font-size: 11.5px;
}

/* ---- 分变体流量结构 ---- */

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

.cell-bar {
  flex: 1;
  min-width: 26px;
  height: 6px;
  background: var(--ink-100);
  border-radius: 3px;
  overflow: hidden;
}

.cell-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.2s;
}

.cell-num {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-700);
  flex-shrink: 0;
  min-width: 40px;
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
</style>
