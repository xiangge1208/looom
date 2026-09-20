<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { businessApi } from '@/api/business'

/**
 * 竞品对比
 *
 * 把多个 ASIN 的已有指标并排展示。
 *
 * ⚠️ 侦察结论：这个页面**不需要独立业务表** ——
 * 响应字段都能从其他域的表拼出来，没有对比得分之类的独有指标。
 *
 * 「组内最佳」标记（如最便宜、评分最高）是相对当前对比组算出来的，
 * 换一组对比对象就变，所以不落库，每次请求现算。
 *
 * 上限 10 个：实测原站也是 10（传 11 个起报参数错误）。
 */
const MAX_COMPARE = 10

const route = useRoute()
const router = useRouter()

const input = ref('')
const asins = ref<string[]>([])
const loading = ref(false)
const items = ref<any[]>([])

const ASIN_RE = /^[A-Z0-9]{10}$/

function add() {
  const list = input.value
    .split(/[\s,，]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

  if (!list.length) return

  const bad = list.filter((a) => !ASIN_RE.test(a))
  if (bad.length) {
    ElMessage.warning(`以下不是合法 ASIN（需 10 位）：${bad.join(', ')}`)
    return
  }

  const merged = [...new Set([...asins.value, ...list])]
  if (merged.length > MAX_COMPARE) {
    ElMessage.warning(`最多同时对比 ${MAX_COMPARE} 个 ASIN`)
    asins.value = merged.slice(0, MAX_COMPARE)
  } else {
    asins.value = merged
  }
  input.value = ''
  if (asins.value.length) load()
}

function remove(a: string) {
  asins.value = asins.value.filter((x) => x !== a)
  if (asins.value.length) load()
  else items.value = []
}

async function load() {
  loading.value = true
  // 写进 URL，刷新后仍能复现同一组对比
  router.replace({ query: { ...route.query, asins: asins.value.join(',') } })
  try {
    const res = await businessApi.competitors(asins.value)
    items.value = res.items ?? []
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

/** 从 URL query 恢复对比列表，保证刷新和分享链接都能复现 */
onMounted(() => {
  const q = (route.query.asins as string) ?? ''
  const list = q
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((a) => ASIN_RE.test(a))
  if (list.length) {
    asins.value = list.slice(0, MAX_COMPARE)
    load()
  }
})

const trafficKeys = [
  { key: 'total', name: '总流量', color: '#4f46e5' },
  { key: 'nf', name: '自然', color: '#1AB364' },
  { key: 'ad', name: '广告', color: '#F0AA11' },
]
</script>

<template>
  <div class="page">
    <h1 class="page-title">竞品对比</h1>
    <p class="page-desc">把多个 ASIN 的销量、价格、评分、流量结构并排比较（最多 {{ MAX_COMPARE }} 个）</p>

    <div class="card">
      <el-input
        v-model="input"
        size="large"
        clearable
        placeholder="输入 ASIN，多个用逗号或空格分隔，回车添加"
        @keyup.enter="add"
      >
        <template #prepend>ASIN</template>
        <template #append>
          <el-button type="primary" @click="add">添加</el-button>
        </template>
      </el-input>

      <div v-if="asins.length" class="chips">
        <el-tag
          v-for="a in asins"
          :key="a"
          closable
          size="large"
          effect="plain"
          @close="remove(a)"
        >
          <span class="mono">{{ a }}</span>
        </el-tag>
        <span class="muted count">{{ asins.length }} / {{ MAX_COMPARE }}</span>
      </div>
    </div>

    <div v-if="items.length" class="card" v-loading="loading">
      <h2 class="sec-title">对比结果</h2>
      <el-table :data="items" stripe>
        <el-table-column label="" width="64">
          <template #default="{ row }">
            <img v-if="row.img" :src="row.img" class="cell-img" alt="" />
          </template>
        </el-table-column>
        <el-table-column label="ASIN" width="128">
          <template #default="{ row }">
            <div class="asin-cell">
              <span class="mono">{{ row.asin }}</span>
              <el-tag v-if="row.isBestSeller" size="small" type="danger" effect="plain">
                BS
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
        <el-table-column prop="brand" label="品牌" width="112" show-overflow-tooltip />

        <el-table-column label="价格" width="106" sortable :sort-method="(a: any, b: any) => (a.price ?? 0) - (b.price ?? 0)">
          <template #default="{ row }">
            <span v-if="row.price !== null" :class="{ best: row.best.price }">
              ${{ row.price }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="评分" width="122" sortable :sort-method="(a: any, b: any) => (a.score ?? 0) - (b.score ?? 0)">
          <template #default="{ row }">
            <template v-if="row.score !== null">
              <span :class="{ best: row.best.score }">{{ row.score }}</span>
              <span class="muted">({{ (row.ratingNum ?? 0).toLocaleString() }})</span>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="近一月销量" width="122">
          <template #default="{ row }">
            <el-tag v-if="row.boughtLabel" :type="row.best.bought ? 'success' : 'info'" size="small" effect="plain">
              {{ row.boughtLabel }}
            </el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="流量结构" min-width="240">
          <template #default="{ row }">
            <div class="traffic-bars">
              <div v-for="t in trafficKeys" :key="t.key" class="tb-row">
                <span class="tb-name">{{ t.name }}</span>
                <div class="tb-bar">
                  <div
                    class="tb-fill"
                    :style="{
                      width: `${Math.min(100, (row.traffic?.[t.key]?.ratio ?? 0) * 100)}%`,
                      background: t.color,
                    }"
                  />
                </div>
                <span class="tb-val">
                  {{ ((row.traffic?.[t.key]?.ratio ?? 0) * 100).toFixed(1) }}%
                </span>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <p class="hint muted">
        高亮项表示在<strong>当前对比组内</strong>最优（价格最低 / 评分最高 / 销量分档最高）。
        这些标记随对比对象变化，不代表商品本身的绝对水平。
      </p>
    </div>

    <el-empty
      v-else-if="!loading && !asins.length"
      description="输入 2 个以上 ASIN 开始对比"
      :image-size="90"
    />
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 16px;
}

.chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.count {
  font-size: 12px;
  margin-left: 4px;
}

.sec-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.cell-img {
  width: 40px;
  height: 40px;
  object-fit: contain;
}

.asin-cell {
  display: flex;
  align-items: center;
  gap: 5px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.best {
  font-weight: 700;
  color: var(--ok);
}

.traffic-bars {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 3px 0;
}

.tb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
}

.tb-name {
  width: 44px;
  color: var(--ink-500);
}

.tb-bar {
  flex: 1;
  height: 5px;
  background: var(--ink-100);
  border-radius: 3px;
  overflow: hidden;
}

.tb-fill {
  height: 100%;
  border-radius: 3px;
}

.tb-val {
  width: 44px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.hint {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
</style>
