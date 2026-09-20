<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { businessApi, type KeywordRow } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import AiAnalysisCard from '@/components/AiAnalysisCard.vue'

/**
 * 反查流量词
 *
 * 对应原站 /reverse。注意 goal.md 用的路由名 /keywords 在原站是「以词拓词」，
 * 属于我们未纳入的功能族，所以这里用语义明确的路径。
 *
 * 分页用游标（后端实现），不是页码 —— 所以这里是「加载更多」而非页码器。
 */
const route = useRoute()
const router = useRouter()

const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const loadingMore = ref(false)
const rows = ref<KeywordRow[]>([])
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)
const keywordFilter = ref('')
const sortBy = ref('score')
const timePieceValue = ref<string | null>(null)

/** 抽屉：某关键词的流量来源 */
const drawerVisible = ref(false)
const sourceData = ref<any>(null)
const sourceLoading = ref(false)

async function load(reset = true) {
  if (reset) {
    loading.value = true
    nextCursor.value = null
  } else {
    loadingMore.value = true
  }

  try {
    const res = await businessApi.keywords({
      asin: asin.value,
      cursor: reset ? undefined : (nextCursor.value ?? undefined),
      limit: 20,
      keyword: keywordFilter.value || undefined,
      sortBy: sortBy.value,
    })
    rows.value = reset ? res.items : [...rows.value, ...res.items]
    nextCursor.value = res.nextCursor
    hasMore.value = res.hasMore
    timePieceValue.value = res.timePieceValue
    if (reset) router.replace({ query: { ...route.query, asin: asin.value } })
  } catch {
    if (reset) rows.value = []
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function search(v: string) {
  asin.value = v
  load(true)
}

/** 表头排序：切换时重新从头查，游标作废 */
function onSortChange({ prop, order }: { prop: string; order: string | null }) {
  if (!order) return
  const map: Record<string, string> = { nfLastRank: 'rank', estSearchesNum: 'searches', listingScoreRatio: 'score' }
  sortBy.value = map[prop] ?? 'score'
  load(true)
}

async function openSource(row: KeywordRow) {
  drawerVisible.value = true
  sourceLoading.value = true
  sourceData.value = null
  try {
    sourceData.value = await businessApi.keywordSource(row.keywordId, 'US', asin.value)
  } finally {
    sourceLoading.value = false
  }
}

onMounted(() => {
  if (asin.value) load(true)
})

/** 渠道列。用长表 pivot 出来的数据，列不写死，按响应里出现的渠道生成 */
const channelKeys = computed(() => {
  const set = new Set<string>()
  rows.value.forEach((r) => Object.keys(r.channels ?? {}).forEach((k) => set.add(k)))
  return [...set]
})

const CHANNEL_NAMES: Record<string, string> = {
  total: '总计',
  nf: '自然',
  ad: '广告',
  allSp: 'SP合计',
  sp: 'SP常规',
  spRec: 'SP推荐',
  allSb: 'SB合计',
  sb: 'SB常规',
  sbv: 'SBV',
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">反查流量词</h1>
    <p class="page-desc">找出为某个 ASIN 带来流量的所有关键词及其贡献占比</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <div v-if="rows.length || loading" class="card">
      <div class="card-head">
        <h2 class="sec-title">
          流量词列表
          <span v-if="timePieceValue" class="muted">（{{ timePieceValue }}）</span>
        </h2>
        <div class="filters">
          <el-input
            v-model="keywordFilter"
            placeholder="按关键词筛选"
            size="small"
            clearable
            style="width: 190px"
            @keyup.enter="load(true)"
            @clear="load(true)"
          />
          <el-button size="small" @click="load(true)">筛选</el-button>
        </div>
      </div>

      <el-table
        :data="rows"
        stripe
        v-loading="loading"
        style="width: 100%"
        @sort-change="onSortChange"
      >
        <el-table-column type="index" label="#" width="52" />
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
        <el-table-column label="标签" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.isCore" size="small" type="warning" effect="plain">核心</el-tag>
            <el-tag v-if="row.isTarget" size="small" type="success" effect="plain">目标</el-tag>
            <span v-if="!row.isCore && !row.isTarget" class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="nfLastRank"
          label="自然位"
          width="96"
          sortable="custom"
        >
          <template #default="{ row }">
            <span v-if="row.nfLastRank !== null">{{ row.nfLastRank }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="广告位" width="90">
          <template #default="{ row }">
            <span v-if="row.spLastRank !== null">{{ row.spLastRank }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="estSearchesNum"
          label="搜索量"
          width="106"
          sortable="custom"
        >
          <template #default="{ row }">
            <span v-if="row.estSearchesNum !== null">
              {{ row.estSearchesNum.toLocaleString() }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="listingScoreRatio"
          label="流量占比"
          width="104"
          sortable="custom"
        >
          <template #default="{ row }">
            <span v-if="row.listingScoreRatio !== null">
              {{ (row.listingScoreRatio * 100).toFixed(3) }}%
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="曝光位" width="140">
          <template #default="{ row }">
            <el-tag
              v-for="p in row.exposurePositions"
              :key="p"
              size="small"
              effect="plain"
              class="pos-tag"
            >
              {{ CHANNEL_NAMES[p] ?? p }}
            </el-tag>
            <span v-if="!row.exposurePositions.length" class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="88" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openSource(row)">
              流量来源
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="more-bar">
        <el-button v-if="hasMore" :loading="loadingMore" @click="load(false)">
          加载更多
        </el-button>
        <span v-else class="muted">已加载全部 {{ rows.length }} 条</span>
      </div>
    </div>

    <el-empty v-else-if="!loading" description="输入 ASIN 开始查询" :image-size="90" />

    <!-- AI 插入点 2：关键词投放推荐 -->
    <AiAnalysisCard
      v-if="rows.length"
      insert-point="keyword-recommend"
      title="AI 关键词投放建议"
      :input="{
        asin,
        country: 'US',
        keywords: rows.slice(0, 30).map((r) => ({
          keyword: r.keyword,
          nfLastRank: r.nfLastRank,
          estSearchesNum: r.estSearchesNum,
          listingScoreRatio: r.listingScoreRatio,
        })),
      }"
    />

    <!-- 关键词流量来源抽屉。对应 goal.md 的 /keywords/source -->
    <el-drawer v-model="drawerVisible" title="关键词流量来源" size="46%">
      <div v-loading="sourceLoading">
        <template v-if="sourceData">
          <div class="src-head">
            <div class="src-kw">{{ sourceData.keyword.keyword }}</div>
            <div class="muted">
              {{ sourceData.keyword.translateKeyword ?? '' }}
              <span v-if="sourceData.keyword.estSearchesNum">
                · 搜索量 {{ sourceData.keyword.estSearchesNum.toLocaleString() }}
              </span>
            </div>
          </div>

          <h3 class="src-title">该词下的头部商品</h3>
          <el-empty
            v-if="!sourceData.topAsins.length"
            description="暂无数据"
            :image-size="60"
          />
          <el-table v-else :data="sourceData.topAsins" size="small" stripe>
            <el-table-column label="#" width="52">
              <template #default="{ row }">{{ row.rankPosition }}</template>
            </el-table-column>
            <el-table-column prop="asin" label="ASIN" width="128">
              <template #default="{ row }">
                <span class="mono">{{ row.asin }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="title" label="标题" show-overflow-tooltip />
            <el-table-column label="价格" width="82">
              <template #default="{ row }">
                <span v-if="row.price !== null">${{ row.price }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>

          <h3 v-if="sourceData.rankHistory.length" class="src-title">
            本 ASIN 在此词下的排名走势
          </h3>
          <div v-if="sourceData.rankHistory.length" class="rank-strip">
            <div
              v-for="h in sourceData.rankHistory"
              :key="h.date"
              class="rank-cell"
              :title="`${h.date} 排名 ${h.rank}`"
            >
              <span class="rank-val">{{ h.rank }}</span>
              <span class="rank-date">{{ h.date.slice(5) }}</span>
            </div>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.sec-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.filters {
  display: flex;
  gap: 8px;
}

.kw-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.kw-cn {
  font-size: 11.5px;
}

.pos-tag {
  margin-right: 3px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.more-bar {
  margin-top: 14px;
  text-align: center;
  font-size: 12.5px;
}

.src-head {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 14px;
}

.src-kw {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 3px;
}

.src-title {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.rank-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.rank-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  min-width: 44px;
}

.rank-val {
  font-size: 12.5px;
  font-weight: 500;
}

.rank-date {
  font-size: 10px;
  color: var(--ink-500);
}
</style>
