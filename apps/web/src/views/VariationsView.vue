<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { businessApi } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import QuerySkeleton from '@/components/QuerySkeleton.vue'
import BaseChart from '@/components/BaseChart.vue'

/**
 * 查多变体自然位
 *
 * 看一个变体组里的多个子体，在同一批关键词下各自占据什么自然位。
 * 这个页面的价值就在于「一个词下有多个变体同时占位」——
 * 所以关键词表格里每个词会展开出多个变体。
 *
 * 粒度是日（实测该接口无 timePiece 参数，直接返回逐日数组）。
 */
const route = useRoute()
const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const data = ref<any>(null)

async function search(v: string) {
  asin.value = v
  loading.value = true
  try {
    data.value = await businessApi.variations(v)
  } catch {
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (asin.value) search(asin.value)
})

/** 日趋势：多变体额外获得的自然流量是核心指标 */
const trendOption = computed(() => {
  const d = data.value
  if (!d?.dates?.length) return null
  return {
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 52, right: 16, top: 16, bottom: 44 },
    xAxis: {
      type: 'category',
      data: d.dates,
      axisLabel: { fontSize: 11, rotate: d.dates.length > 20 ? 40 : 0 },
    },
    yAxis: [
      {
        type: 'value',
        name: '得分',
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 11 },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      {
        type: 'value',
        name: '变体数',
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '多变体额外得分',
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.12 },
        data: d.trend.extraScore,
        itemStyle: { color: '#4f46e5' },
        symbolSize: 3,
      },
      {
        name: '占位变体数',
        type: 'line',
        yAxisIndex: 1,
        step: 'middle',
        // 变体数是离散的，用阶梯线更贴合语义
        data: d.trend.asinCount,
        itemStyle: { color: '#d97706' },
        symbolSize: 3,
      },
    ],
  }
})

/** 按「同时占位数」排序，多变体占位的词更值得关注 */
const sortedKeywords = computed(() => {
  const list = data.value?.keywords ?? []
  return [...list].sort((a: any, b: any) => b.variants.length - a.variants.length)
})

const ROLE_TYPE: Record<string, string> = {
  main: 'success',
  sibling: 'info',
  parent: '',
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">查多变体自然位</h1>
    <p class="page-desc">查看变体组内各子体在同一批关键词下的自然位分布与多变体额外流量</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <!-- 加载骨架：请求飞行期间避免页面空白 -->
    <QuerySkeleton v-if="loading && !data" />

    <template v-if="data">
      <div class="card">
        <h2 class="sec-title">多变体自然位趋势</h2>
        <BaseChart :option="trendOption" :loading="loading" height="320px" />
        <p class="hint muted">
          该页面为<strong>日粒度</strong>（与查销量、流量结构的月粒度不同，故不合并展示）。
        </p>
      </div>

      <div class="card">
        <h2 class="sec-title">
          关键词自然位分布
          <span class="muted">（共 {{ sortedKeywords.length }} 个词）</span>
        </h2>
        <el-empty v-if="!sortedKeywords.length" description="暂无数据" :image-size="70" />
        <el-table v-else :data="sortedKeywords" stripe>
          <el-table-column label="关键词" min-width="190" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="kw-cell">
                <span>{{ row.keyword }}</span>
                <span v-if="row.translateKeyword" class="kw-cn muted">
                  {{ row.translateKeyword }}
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="同时占位变体数" width="140" align="center">
            <template #default="{ row }">
              <el-tag
                :type="row.variants.length > 1 ? 'success' : 'info'"
                size="small"
                effect="plain"
              >
                {{ row.variants.length }} 个
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="各变体自然位" min-width="320">
            <template #default="{ row }">
              <div class="variant-chips">
                <div
                  v-for="v in row.variants"
                  :key="v.asin + v.rankPosition"
                  class="v-chip"
                >
                  <span class="mono">{{ v.asin.slice(-4) }}</span>
                  <span class="v-rank">#{{ v.rankPosition }}</span>
                  <el-tag :type="ROLE_TYPE[v.role] || 'info'" size="small" effect="plain">
                    {{ v.roleName }}
                  </el-tag>
                </div>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <p class="hint muted">
          「主曝光变体」是该词下排名最靠前、承接主要曝光的子体，其余为同组变体搭流量。
        </p>
      </div>
    </template>

    <el-empty v-else-if="!loading" description="输入父体 ASIN 开始查询" :image-size="90" />
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 16px;
}

.sec-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.kw-cell {
  display: flex;
  flex-direction: column;
}

.kw-cn {
  font-size: 11.5px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.variant-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
}

.v-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 11.5px;
  background: #fff;
}

.v-rank {
  font-weight: 600;
  color: var(--brand-600);
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
</style>
