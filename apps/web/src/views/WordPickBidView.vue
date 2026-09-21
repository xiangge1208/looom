<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { wordPickApi, type BidItem } from '@/api/business'
import KeywordSearchBar from '@/components/KeywordSearchBar.vue'

/**
 * 查关键词竞价（M13 /cpc-browsetree）
 *
 * ## ⚠️ 本页数据是模拟的
 *
 * 真实源（原站 search/cpc/category）未接入，数据由 db/gen-seed-unbuilt.mjs 生成。
 * 响应带 isSeed=true 时页面**必须**显示醒目标记 —— 不能让用户把模拟竞价当真实建议。
 * 关键词挂的是真实词（本页按词查，挂假词会让用户查真词全空白），
 * 但类目和竞价数值是造的。
 *
 * ## 类目是核心维度，所以按类目分组渲染
 *
 * 官方口径：「建议竞价与产品无关，**与品类强相关**，与产品的权重没有关系」。
 * 同一个词在不同类目下竞价差异很大，平铺成一张表看不出结构，
 * 所以这里按类目分组、每组内是 3×2 的矩阵（匹配方式 × 投放策略）。
 *
 * ## 三档递增，与 ACOS 相反
 *
 * 竞价是「低/中/高档」区间（0.37 → 0.49 → 0.61），
 * 而 ACOS 是「悲观/中位/乐观」且递减。两者语义与方向都不同，
 * 不能共用渲染组件。
 *
 * ## 口径红线
 *
 * 卖的是「**建议竞价**」，不是 CPC、也不是卖家出价。文案不能混。
 */
const route = useRoute()
const keyword = ref((route.query.keyword as string) ?? '')
const loading = ref(false)
const items = ref<BidItem[]>([])
const statMonth = ref<string | null>(null)
const isSeed = ref(false)
const dataScope = ref('')
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)

const matchType = ref('')
const bidStrategy = ref('')

/**
 * 按类目分组。
 *
 * 每组内再按 matchType × bidStrategy 组成矩阵 ——
 * 这是原站的渲染结构（页面说明第 1 条决定的）。
 */
const grouped = computed(() => {
  const map = new Map<string, { name: string; href: string | null; saleNum: number | null; rows: BidItem[] }>()
  for (const it of items.value) {
    if (!map.has(it.categoryId)) {
      map.set(it.categoryId, {
        name: it.categoryName ?? it.categoryId,
        href: it.categoryHref,
        saleNum: it.categorySaleNum,
        rows: [],
      })
    }
    map.get(it.categoryId)!.rows.push(it)
  }
  // 类目内固定顺序：精准 > 词组 > 广泛（竞价由高到低），策略 auto 在前
  const MT_ORDER = { exact: 0, phrase: 1, broad: 2 } as Record<string, number>
  for (const g of map.values()) {
    g.rows.sort(
      (a, b) =>
        (MT_ORDER[a.matchType] ?? 9) - (MT_ORDER[b.matchType] ?? 9) ||
        a.bidStrategy.localeCompare(b.bidStrategy),
    )
  }
  return [...map.entries()].map(([id, g]) => ({ categoryId: id, ...g }))
})

async function search(kw: string) {
  keyword.value = kw
  loading.value = true
  try {
    // 单词查询时一次多取些 —— 每词 4~12 个类目 × 6 组合，20 条不够看出结构
    const res = await wordPickApi.bid({
      keyword: kw || undefined,
      matchType: matchType.value || undefined,
      bidStrategy: bidStrategy.value || undefined,
      limit: kw ? 100 : 20,
    })
    items.value = res.items ?? []
    statMonth.value = res.statMonth
    isSeed.value = res.isSeed
    dataScope.value = res.dataScope ?? ''
    nextCursor.value = res.nextCursor
    hasMore.value = res.hasMore
  } catch {
    items.value = []
    nextCursor.value = null
    hasMore.value = false
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value) return
  loading.value = true
  try {
    const res = await wordPickApi.bid({
      keyword: keyword.value || undefined,
      matchType: matchType.value || undefined,
      bidStrategy: bidStrategy.value || undefined,
      cursor: nextCursor.value,
      limit: 100,
    })
    items.value = items.value.concat(res.items ?? [])
    nextCursor.value = res.nextCursor
    hasMore.value = res.hasMore
  } finally {
    loading.value = false
  }
}

onMounted(() => search(keyword.value))

const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(2)}`)

const MATCH_LABEL: Record<string, string> = {
  broad: '广泛',
  phrase: '词组',
  exact: '精准',
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">查关键词竞价</h1>
    <p class="page-desc">
      建议竞价<strong>与产品无关、与品类强相关</strong>，也与产品权重无关；
      大小取决于该品类的产品数量与对每个产品的预期广告成本。
      注意这是<strong>建议竞价</strong>，不是点击 CPC，也不是卖家出价。
      以周 ABA 为数据源，每月更新一次。
    </p>

    <!-- 模拟数据必须醒目标记，不能让用户当真实建议用 -->
    <el-alert v-if="isSeed" type="warning" :closable="false" show-icon class="tip">
      <template #title>
        <strong>本页数据为模拟数据</strong>
      </template>
      真实竞价数据源尚未接入，当前展示的类目与竞价数值由生成器造出，仅用于界面演示，
      <strong>不可作为实际投放依据</strong>。关键词本身是真实的。
    </el-alert>

    <KeywordSearchBar
      :initial="keyword"
      :loading="loading"
      placeholder="输入关键词查各类目建议竞价"
      @search="search"
    />

    <div v-if="items.length || loading" class="card" v-loading="loading">
      <div class="sec-head">
        <h2 class="sec-title">
          各类目建议竞价
          <span class="muted">
            {{ keyword ? `「${keyword}」` : '（榜单）' }}
            <template v-if="statMonth">· {{ statMonth }}</template>
            <template v-if="keyword">· 共 {{ grouped.length }} 个类目</template>
          </span>
        </h2>
        <div class="tools">
          <el-select
            v-model="matchType"
            size="small"
            placeholder="全部匹配方式"
            clearable
            style="width: 130px"
            @change="search(keyword)"
          >
            <el-option label="精准" value="exact" />
            <el-option label="词组" value="phrase" />
            <el-option label="广泛" value="broad" />
          </el-select>
          <el-select
            v-model="bidStrategy"
            size="small"
            placeholder="全部策略"
            clearable
            style="width: 150px"
            @change="search(keyword)"
          >
            <el-option label="提升与降低" value="auto" />
            <el-option label="仅降低/固定" value="legacy" />
          </el-select>
        </div>
      </div>

      <el-empty v-if="!items.length && !loading" description="暂无数据" :image-size="70" />

      <!-- 按类目分组：竞价与品类强相关，平铺看不出结构 -->
      <template v-else-if="keyword">
        <div v-for="g in grouped" :key="g.categoryId" class="cat-block">
          <div class="cat-head">
            <a v-if="g.href" :href="g.href" target="_blank" rel="noopener" class="cat-name">
              {{ g.name }}
            </a>
            <span v-else class="cat-name">{{ g.name }}</span>
            <span class="muted sm">
              在售 {{ g.saleNum?.toLocaleString() ?? '—' }} 个产品
            </span>
          </div>
          <el-table :data="g.rows" size="small" stripe>
            <el-table-column label="匹配方式" width="100">
              <template #default="{ row }">
                {{ MATCH_LABEL[row.matchType] ?? row.matchType }}
              </template>
            </el-table-column>
            <el-table-column label="竞价策略" width="130">
              <template #default="{ row }">{{ row.bidStrategyLabel }}</template>
            </el-table-column>
            <el-table-column label="建议竞价区间（低 / 中 / 高）" align="center">
              <template #default="{ row }">
                <span class="bid-lo">{{ money(row.bidStart) }}</span>
                <span class="sep">·</span>
                <strong class="bid-mid">{{ money(row.bidMedian) }}</strong>
                <span class="sep">·</span>
                <span class="bid-hi">{{ money(row.bidEnd) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>

      <!-- 榜单模式（未指定词）：平铺表格 -->
      <el-table v-else :data="items" size="small" stripe>
        <el-table-column prop="keyword" label="关键词" min-width="160" fixed />
        <el-table-column prop="categoryName" label="类目" min-width="170" />
        <el-table-column label="匹配" width="80">
          <template #default="{ row }">{{ MATCH_LABEL[row.matchType] ?? row.matchType }}</template>
        </el-table-column>
        <el-table-column label="策略" width="120">
          <template #default="{ row }">{{ row.bidStrategyLabel }}</template>
        </el-table-column>
        <el-table-column label="低档" width="85" align="right">
          <template #default="{ row }">{{ money(row.bidStart) }}</template>
        </el-table-column>
        <el-table-column label="中档" width="85" align="right">
          <template #default="{ row }">
            <strong>{{ money(row.bidMedian) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="高档" width="85" align="right">
          <template #default="{ row }">{{ money(row.bidEnd) }}</template>
        </el-table-column>
      </el-table>

      <div v-if="hasMore" class="more">
        <el-button :loading="loading" @click="loadMore">加载更多</el-button>
      </div>

      <p v-if="dataScope" class="muted sm foot">{{ dataScope }}</p>
    </div>
  </div>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tip {
  margin-bottom: 14px;
}

.cat-block {
  margin-bottom: 18px;
}

.cat-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}

.cat-name {
  font-weight: 600;
  color: var(--text);
  text-decoration: none;
}

.cat-name[href]:hover {
  color: var(--primary);
  text-decoration: underline;
}

.muted {
  color: var(--text-muted);
  font-weight: 400;
}

.sm {
  font-size: 12px;
}

.sep {
  margin: 0 6px;
  color: var(--border);
}

.bid-lo {
  color: var(--text-muted);
}

.bid-hi {
  color: var(--text-muted);
}

.more {
  margin-top: 12px;
  text-align: center;
}

.foot {
  margin: 10px 0 0;
}
</style>
