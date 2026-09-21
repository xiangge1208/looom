<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  calcAcos,
  isAcosLoss,
  wordPickApi,
  type AcosItem,
  type ConversionItem,
} from '@/api/business'
import KeywordSearchBar from '@/components/KeywordSearchBar.vue'

/**
 * 关键词转化率（M13 /conversion-rate）
 *
 * ABA 转化漏斗：搜索量 → 点击量 → 购买量，外加价格带与 ACOS/CPA 三档。
 *
 * ## ⚠️ ACOS 是前端按用户填的毛利率实时算的，不是后端给的
 *
 * 审计实测原站这页的「ACOS[自定义毛利率]」列就是这么做的，
 * 那个输入框是必填项。后端返回的 acos* 只是源侧默认毛利率下的参考值。
 * 所以本页：
 *   - 用户填「售价」和「毛利率」→ 前端用 CPA 算 ACOS
 *   - ACOS 超过毛利率就标红（超了就亏本，这是选词最关键的判断）
 *   - 不填则显示后端的参考值，并标注「按默认毛利率估算」
 *
 * ## 两组三档方向相反
 *
 *   ACOS  递减：start 是悲观档（值最大）
 *   CPA   递增
 * 所以渲染时不能共用一套「区间条」组件。
 */
const route = useRoute()
const keyword = ref((route.query.keyword as string) ?? '')
const loading = ref(false)
const items = ref<ConversionItem[]>([])
const statWeek = ref<string | null>(null)
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)

/** ACOS/CPA 数据单独一个接口，按词查时才加载 */
const acosLoading = ref(false)
const acosItems = ref<AcosItem[]>([])
const acosWeek = ref<string | null>(null)

// ---- 用户输入的经济参数 ----
/** 售价。用于把 CPA 换算成 ACOS */
const price = ref<number | null>(null)
/** 毛利率（百分比输入，如 30 表示 30%）。ACOS 超过它就亏本 */
const grossMarginPct = ref<number | null>(null)

const grossMargin = computed(() =>
  grossMarginPct.value === null ? null : grossMarginPct.value / 100,
)
/** 两个参数都填了才能自己算 ACOS，否则退回后端参考值 */
const canCalcAcos = computed(() => price.value !== null && price.value > 0)

const sortBy = ref('searchVolume')

async function search(kw: string) {
  keyword.value = kw
  loading.value = true
  try {
    const res = await wordPickApi.conversion({
      keyword: kw || undefined,
      sortBy: sortBy.value,
      limit: 20,
    })
    items.value = res.items ?? []
    statWeek.value = res.statWeek
    nextCursor.value = res.nextCursor
    hasMore.value = res.hasMore
  } catch {
    items.value = []
    nextCursor.value = null
    hasMore.value = false
  } finally {
    loading.value = false
  }
  // 查单个词时同时拉 ACOS/CPA —— 榜单模式下不拉（每词 6 行会撑爆表格）
  if (kw) loadAcos(kw)
  else acosItems.value = []
}

async function loadAcos(kw: string) {
  acosLoading.value = true
  try {
    const res = await wordPickApi.acos({ keyword: kw, limit: 20 })
    acosItems.value = res.items ?? []
    acosWeek.value = res.statWeek
  } catch {
    acosItems.value = []
  } finally {
    acosLoading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value) return
  loading.value = true
  try {
    const res = await wordPickApi.conversion({
      keyword: keyword.value || undefined,
      sortBy: sortBy.value,
      cursor: nextCursor.value,
      limit: 20,
    })
    items.value = items.value.concat(res.items ?? [])
    nextCursor.value = res.nextCursor
    hasMore.value = res.hasMore
  } finally {
    loading.value = false
  }
}

function onSortChange(v: string) {
  sortBy.value = v
  search(keyword.value)
}

onMounted(() => search(keyword.value))

// ---- 格式化 ----
const num = (v: number | null) => (v === null ? '—' : v.toLocaleString())
const pct = (v: number | null, digits = 2) =>
  v === null ? '—' : `${(v * 100).toFixed(digits)}%`
const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(2)}`)

/** 某档 CPA 对应的 ACOS：能自己算就算，否则用后端参考值 */
function acosFor(row: AcosItem, tier: 'start' | 'median' | 'end'): number | null {
  if (canCalcAcos.value) {
    const cpa = row[`cpa${tier[0].toUpperCase()}${tier.slice(1)}` as keyof AcosItem] as number | null
    return calcAcos(cpa, price.value)
  }
  return row[`acos${tier[0].toUpperCase()}${tier.slice(1)}` as keyof AcosItem] as number | null
}

const MATCH_LABEL: Record<string, string> = {
  broad: '广泛',
  phrase: '词组',
  exact: '精准',
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">关键词转化率</h1>
    <p class="page-desc">
      ABA 转化漏斗：搜索量 → 点击量 → 购买量。数据口径为
      <strong>关键词下所有产品的平均点击转化率</strong>（来源亚马逊商机探测器），
      不可与单个产品的转化率直接对比。
    </p>

    <KeywordSearchBar
      :initial="keyword"
      :loading="loading"
      placeholder="输入关键词查转化率；留空看搜索量榜单"
      @search="search"
    />

    <div v-if="items.length || loading" class="card" v-loading="loading">
      <div class="sec-head">
        <h2 class="sec-title">
          转化漏斗
          <span class="muted">
            {{ keyword ? `「${keyword}」` : '（搜索量榜单）' }}
            <template v-if="statWeek">· ABA 周 {{ statWeek }}</template>
          </span>
        </h2>
        <el-radio-group :model-value="sortBy" size="small" @change="onSortChange">
          <el-radio-button value="searchVolume">按搜索量</el-radio-button>
          <el-radio-button value="clickPurchaseRatio">按点击转化率</el-radio-button>
          <el-radio-button value="avgKwPrice">按均价</el-radio-button>
        </el-radio-group>
      </div>

      <el-empty v-if="!items.length && !loading" description="暂无数据" :image-size="70" />

      <el-table v-else :data="items" size="small" stripe>
        <el-table-column prop="keyword" label="关键词" min-width="180" fixed />
        <el-table-column label="搜索量" width="100" align="right">
          <template #default="{ row }">{{ num(row.searchVolume) }}</template>
        </el-table-column>
        <el-table-column label="点击量" width="100" align="right">
          <template #default="{ row }">{{ num(row.clickVolume) }}</template>
        </el-table-column>
        <el-table-column label="购买量" width="90" align="right">
          <template #default="{ row }">{{ num(row.purchaseVolume) }}</template>
        </el-table-column>
        <el-table-column label="点击转化率" width="140" align="right">
          <template #default="{ row }">
            <!-- 两个转化率分母不同：点击购买率的分母是点击数，搜索购买率的分母是搜索数 -->
            <span>{{ pct(row.clickPurchaseRatio, 1) }}</span>
            <span class="muted sm"> / {{ pct(row.searchPurchaseRatio, 1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="产品均价" width="170" align="right">
          <template #default="{ row }">
            <span class="tier">{{ money(row.minKwPrice) }}</span>
            <span class="tier mid">{{ money(row.avgKwPrice) }}</span>
            <span class="tier">{{ money(row.maxKwPrice) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="ABA Top3 集中度" width="150" align="right">
          <template #default="{ row }">
            <span>点击 {{ pct(row.clickShared, 1) }}</span>
            <span class="muted sm"> / 转化 {{ pct(row.conversionShared, 1) }}</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="hasMore" class="more">
        <el-button size="small" :loading="loading" @click="loadMore">加载更多</el-button>
      </div>
    </div>

    <!-- ---- ACOS / CPA：只在查单个词时出现 ---- -->
    <div v-if="keyword && (acosItems.length || acosLoading)" class="card" v-loading="acosLoading">
      <div class="sec-head">
        <h2 class="sec-title">
          ACOS / CPA 预估
          <span class="muted">
            「{{ keyword }}」
            <template v-if="acosWeek">· ABA 周 {{ acosWeek }}</template>
          </span>
        </h2>
        <div class="econ-input">
          <el-input-number
            v-model="price"
            :min="0"
            :precision="2"
            :step="1"
            size="small"
            placeholder="售价"
            controls-position="right"
          />
          <span class="muted sm">售价 $</span>
          <el-input-number
            v-model="grossMarginPct"
            :min="0"
            :max="100"
            :precision="0"
            :step="5"
            size="small"
            placeholder="毛利率"
            controls-position="right"
          />
          <span class="muted sm">毛利率 %</span>
        </div>
      </div>

      <el-alert
        v-if="!canCalcAcos"
        type="info"
        :closable="false"
        show-icon
        class="hint"
      >
        ACOS 当前为<strong>源侧默认毛利率下的参考值</strong>。填入售价后将按
        「CPA ÷ 售价」实时计算；再填毛利率可标出亏本档位。
      </el-alert>
      <el-alert v-else type="success" :closable="false" show-icon class="hint">
        ACOS 已按售价 ${{ price }} 实时计算。
        <template v-if="grossMargin !== null">
          超过毛利率 {{ grossMarginPct }}% 的档位标红 —— 那些档位投出去就亏本。
        </template>
        <template v-else>填入毛利率可标出亏本档位。</template>
      </el-alert>

      <el-empty
        v-if="!acosItems.length && !acosLoading"
        description="该词暂无 ACOS/CPA 预估数据"
        :image-size="70"
      />

      <el-table v-else :data="acosItems" size="small" stripe>
        <el-table-column label="匹配方式" width="100">
          <template #default="{ row }">{{ MATCH_LABEL[row.matchType] ?? row.matchType }}</template>
        </el-table-column>
        <el-table-column prop="bidStrategyLabel" label="投放策略" width="120" />
        <el-table-column label="CPA（每单广告成本）" width="200" align="right">
          <template #default="{ row }">
            <!-- CPA 递增：低 → 中 → 高 -->
            <span class="tier">{{ money(row.cpaStart) }}</span>
            <span class="tier mid">{{ money(row.cpaMedian) }}</span>
            <span class="tier">{{ money(row.cpaEnd) }}</span>
          </template>
        </el-table-column>
        <el-table-column min-width="220" align="right">
          <template #header>
            ACOS
            <span class="muted sm">{{ canCalcAcos ? '（按售价实时算）' : '（默认毛利率参考值）' }}</span>
          </template>
          <template #default="{ row }">
            <!-- ⚠️ ACOS 递减，与 CPA 方向相反。这里按 悲观/中位/乐观 顺序展示 -->
            <span
              v-for="t in (['start', 'median', 'end'] as const)"
              :key="t"
              class="tier"
              :class="{
                mid: t === 'median',
                loss: isAcosLoss(acosFor(row, t), grossMargin),
              }"
            >
              <!--
                保留 1 位小数：整数精度会造成误导 —— 30.5% 显示成「30%」
                却因超过 30% 毛利率而标红，用户看不出为什么。
              -->
              {{ pct(acosFor(row, t), 1) }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <p class="muted sm foot">
        ⚠️ ACOS 三档是<strong>悲观 / 中位 / 乐观</strong>（递减），CPA 三档是<strong>递增</strong>的，
        两者方向相反 —— 不要当成同一种区间读。
      </p>
    </div>
  </div>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.econ-input {
  display: flex;
  align-items: center;
  gap: 6px;
}

.econ-input :deep(.el-input-number) {
  width: 110px;
}

.hint {
  margin-bottom: 12px;
}

/* 三档数值：等宽排布，中位档加重 */
.tier {
  display: inline-block;
  min-width: 56px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.tier.mid {
  font-weight: 600;
}

/* ACOS 超过毛利率 = 亏本，标红 */
.tier.loss {
  color: var(--danger);
  font-weight: 600;
}

.muted {
  color: var(--text-muted, #909399);
  font-weight: 400;
}

.sm {
  font-size: 12px;
}

.more {
  margin-top: 12px;
  text-align: center;
}

.foot {
  margin: 10px 0 0;
}
</style>
