<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AiAnalysisCard from '@/components/AiAnalysisCard.vue'
import { suppliersApi, type SupplierItem } from '@/api/business'

/**
 * 供应商搜索
 *
 * ⚠️ goal.md 的硬约束，这里必须说清楚：
 * **本期只做入口和占位 UI，不实现任何采集、爬虫、1688 对接逻辑。**
 * 列表数据全部来自 seed 的自造假货源，价格/起订量都不是真实行情。
 * 真实数据后续由用户自行购买后导入。
 *
 * 页面上用一条醒目的提示条说明这一点 —— 否则看起来像「已经能查真实货源了」，
 * 会误导使用者。
 *
 * 权限：接口要求 supplier:read。seed 里普通用户和管理员都有，
 * 但如果被移除会返回 403，这里捕获后提示，而不是显示空列表。
 */
const keyword = ref('')
const location = ref('')
const minPrice = ref<number | undefined>(undefined)
const maxPrice = ref<number | undefined>(undefined)

const rows = ref<SupplierItem[]>([])
const locations = ref<{ location: string; count: number }[]>([])
const loading = ref(false)
const cursor = ref<string | null>(null)
const hasMore = ref(false)
const searched = ref(false)
/** 403 时单独提示，与「查到 0 条」区分开 */
const forbidden = ref(false)

/** 勾选用于 AI 评估的货源。AI 插入点 4 一次评估多条 */
const selected = ref<SupplierItem[]>([])

async function search(reset = true) {
  loading.value = true
  forbidden.value = false
  try {
    const res = await suppliersApi.search({
      keyword: keyword.value.trim() || undefined,
      location: location.value || undefined,
      minPrice: minPrice.value,
      maxPrice: maxPrice.value,
      cursor: reset ? undefined : (cursor.value ?? undefined),
      limit: 20,
    })
    rows.value = reset ? res.items : [...rows.value, ...res.items]
    cursor.value = res.nextCursor
    hasMore.value = res.hasMore
    searched.value = true
  } catch (err: any) {
    // 403 是权限不足，不是「查到 0 条」，要用不同的空态区分。
    // http 拦截器已经弹过 toast 了，这里只切换页面状态，不重复提示。
    if (err?.response?.status === 403) {
      forbidden.value = true
      rows.value = []
    }
    // 其他错误拦截器已提示，这里不再弹第二个
  } finally {
    loading.value = false
  }
}

function reset() {
  keyword.value = ''
  location.value = ''
  minPrice.value = undefined
  maxPrice.value = undefined
  selected.value = []
  void search(true)
}

function onSelectionChange(sel: SupplierItem[]) {
  // 只取前 10 条送给模型：再多会挤爆 prompt，也超出人一次能看的量
  selected.value = sel.slice(0, 10)
}

onMounted(async () => {
  try {
    locations.value = (await suppliersApi.locations()).items
  } catch {
    // 地区列表拿不到就不显示下拉，不影响关键词搜索
  }
  void search(true)
})
</script>

<template>
  <div class="page">
    <h1 class="page-title">供应商搜索</h1>
    <p class="page-desc">按关键词、地区、价格区间筛选货源，并用 AI 做初步评估</p>

    <!-- 这条提示必须留着：否则会被误认为已接入真实货源 -->
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      class="notice"
      title="本页为占位实现，数据均为示例"
    >
      <template #default>
        当前列表来自项目内置的示例数据，<strong>不是真实 1688 货源</strong>，
        价格与起订量仅用于演示界面。本项目不包含任何数据采集或第三方对接逻辑，
        真实货源需自行获取后导入。
      </template>
    </el-alert>

    <div class="card filters">
      <div class="filter-row">
        <div class="f-item">
          <span class="f-label">关键词</span>
          <el-input
            v-model="keyword"
            placeholder="供应商名或货源标题"
            clearable
            style="width: 200px"
            @keyup.enter="search(true)"
          />
        </div>
        <div class="f-item">
          <span class="f-label">地区</span>
          <el-select v-model="location" placeholder="全部" clearable style="width: 128px">
            <el-option
              v-for="l in locations"
              :key="l.location"
              :label="`${l.location} (${l.count})`"
              :value="l.location"
            />
          </el-select>
        </div>
        <div class="f-item">
          <span class="f-label">价格</span>
          <el-input-number
            v-model="minPrice"
            :min="0"
            :controls="false"
            placeholder="最低"
            style="width: 88px"
          />
          <span class="sep">—</span>
          <el-input-number
            v-model="maxPrice"
            :min="0"
            :controls="false"
            placeholder="最高"
            style="width: 88px"
          />
        </div>
        <el-button type="primary" :loading="loading" @click="search(true)">搜索</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
    </div>

    <el-alert
      v-if="forbidden"
      type="error"
      :closable="false"
      show-icon
      class="notice"
      title="没有访问权限"
      description="当前账号缺少 supplier:read 权限，请联系管理员开通。"
    />

    <div v-else class="card">
      <div class="list-head">
        <h2 class="sec-title">货源列表</h2>
        <span v-if="selected.length" class="sel-hint">
          已选 {{ selected.length }} 条用于 AI 评估
        </span>
      </div>

      <el-table
        :data="rows"
        v-loading="loading"
        stripe
        empty-text="没有符合条件的货源"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="44" />
        <el-table-column label="货源" min-width="240">
          <template #default="{ row }">
            <div class="offer">
              <img v-if="row.img" :src="row.img" class="offer-img" alt="" loading="lazy" />
              <div class="offer-info">
                <div class="offer-title">{{ row.title ?? '—' }}</div>
                <div class="offer-sub">{{ row.supplierName ?? '—' }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="价格" width="100" align="right">
          <template #default="{ row }">
            <span class="price">{{ row.price === null ? '—' : `¥${row.price}` }}</span>
          </template>
        </el-table-column>
        <el-table-column label="起订量" width="92" align="right">
          <template #default="{ row }">{{ row.minOrder ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="地区" width="88">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">{{ row.location ?? '—' }}</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="hasMore" class="more">
        <el-button :loading="loading" @click="search(false)">加载更多</el-button>
      </div>
    </div>

    <!-- AI 插入点 4 -->
    <AiAnalysisCard
      v-if="rows.length"
      insert-point="supplier-evaluate"
      title="AI 货源初步评估"
      :disabled="!selected.length"
      :input="{
        suppliers: selected.map((s) => ({
          supplierName: s.supplierName,
          title: s.title,
          price: s.price,
          minOrder: s.minOrder,
          location: s.location,
        })),
      }"
    />
  </div>
</template>

<style scoped>
.notice {
  margin-bottom: 14px;
}

.filters {
  margin-bottom: 14px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.f-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.f-label {
  font-size: 12.5px;
  color: var(--ink-500);
  white-space: nowrap;
}

.sep {
  color: var(--ink-500);
}

.list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}

.sec-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.sel-hint {
  font-size: 12px;
  color: var(--brand-500);
}

.offer {
  display: flex;
  align-items: center;
  gap: 10px;
}

.offer-img {
  width: 38px;
  height: 38px;
  border-radius: 5px;
  object-fit: cover;
  background: var(--bg-soft, #f5f7fa);
  flex-shrink: 0;
}

.offer-title {
  font-size: 13px;
  line-height: 1.35;
}

.offer-sub {
  font-size: 11.5px;
  color: var(--ink-500);
  margin-top: 2px;
}

.price {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.more {
  margin-top: 14px;
  text-align: center;
}
</style>
