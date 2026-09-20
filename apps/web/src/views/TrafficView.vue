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

function stackStyle(row: any): Record<string, string> {
  const segs = channelKeys
    .map((k) => ({ k, r: row.channels?.[k]?.ratio ?? 0 }))
    .filter((s) => s.r > 0)
  const total = segs.reduce((a, c) => a + c.r, 0) || 1
  return {
    display: 'flex',
    height: '12px',
    borderRadius: '3px',
    overflow: 'hidden',
    background: '#f3f4f6',
    width: '100%',
  }
}

function segWidth(row: any, key: string): string {
  const segs = channelKeys.map((k) => row.channels?.[k]?.ratio ?? 0)
  const total = segs.reduce((a, c) => a + c, 0) || 1
  return `${((row.channels?.[key]?.ratio ?? 0) / total) * 100}%`
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
        <div v-else class="rec-grid">
          <div v-for="c in data.recommendColumns" :key="c.recTitle" class="rec-item">
            <div class="rec-name" :title="c.recTitle">{{ c.name }}</div>
            <div class="rec-bar">
              <div
                class="rec-fill"
                :style="{ width: `${Math.min(100, (c.ratio ?? 0) * 100 * 6)}%` }"
              />
            </div>
            <div class="rec-meta muted">
              占比 {{ ((c.ratio ?? 0) * 100).toFixed(3) }}% · 活动 {{ c.campaignCount }}
            </div>
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
          <el-radio-group v-model="viewMode" size="small">
            <el-radio-button value="stack">堆积图</el-radio-button>
            <el-radio-button value="split">分列对比</el-radio-button>
          </el-radio-group>
        </div>

        <el-table :data="variantRows" stripe style="width: 100%">
          <el-table-column type="index" label="#" width="52" />
          <el-table-column prop="asin" label="变体 ASIN" width="130">
            <template #default="{ row }">
              <span class="mono">{{ row.asin }}</span>
            </template>
          </el-table-column>

          <!-- 堆积图模式：一根彩色条 -->
          <el-table-column v-if="viewMode === 'stack'" label="自然-广告流量分布" min-width="240">
            <template #default="{ row }">
              <div :style="stackStyle(row)">
                <div
                  v-for="k in channelKeys"
                  :key="k"
                  :style="{ width: segWidth(row, k), background: CHANNEL_META[k].color }"
                  :title="`${CHANNEL_META[k].name} ${((row.channels?.[k]?.ratio ?? 0) * 100).toFixed(1)}%`"
                />
              </div>
              <div class="stack-labels">
                <span v-for="k in channelKeys" :key="k" class="stack-label">
                  <span class="dot sm" :style="{ background: CHANNEL_META[k].color }" />
                  {{ CHANNEL_META[k].name }}
                  {{ ((row.channels?.[k]?.ratio ?? 0) * 100).toFixed(1) }}%
                </span>
              </div>
            </template>
          </el-table-column>

          <!-- 分列模式：每渠道一列 -->
          <template v-else>
            <el-table-column
              v-for="k in channelKeys"
              :key="k"
              :label="CHANNEL_META[k].name"
              width="104"
            >
              <template #default="{ row }">
                {{ ((row.channels?.[k]?.ratio ?? 0) * 100).toFixed(1) }}%
              </template>
            </el-table-column>
          </template>

          <el-table-column label="总流量得分" width="112">
            <template #default="{ row }">
              <span class="mono">{{ (row.total ?? 0).toLocaleString() }}</span>
            </template>
          </el-table-column>
        </el-table>
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

.rec-name {
  font-size: 13px;
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

.stack-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--ink-500);
}

.stack-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
