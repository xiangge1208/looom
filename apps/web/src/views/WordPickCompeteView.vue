<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { wordPickApi, type CompeteItem } from '@/api/business'
import KeywordSearchBar from '@/components/KeywordSearchBar.vue'

/**
 * 流量位竞争格局（M13 /compete）
 *
 * 该关键词下有哪些 ASIN 在占位、各占哪类流量位多少份额。
 * 默认按自然流量份额降序（对齐原站口径）。
 *
 * ## 与「流量位竞品数量」页的区别
 *
 *   /amount   关键词级：各流量位**有多少个**竞品（数量）
 *   本页       ASIN 级：**具体是谁**在占位、各占多少份额
 * 两页以 ASIN 为纽带互相跳转。
 *
 * ## ⚠️ keyword 必填
 *
 * 表的粒度是 (关键词, ASIN)，不传词会跨词混排、份额之间没有可比性。
 * 后端对空 keyword 返回空列表 + dataScope 提示，不报错。
 *
 * ## 数据覆盖面窄，要如实告知
 *
 * 源只有 9 个词有数据。查不到时展示后端的 dataScope 文案，
 * 不要让用户以为是程序出错。
 *
 * ## 份额列为什么只有 6 个
 *
 * 源响应有 8 个 *ScoreRatio，但 er/tr 两个实测全为 0
 * （对应的 erAsinNum/trAsinNum 在 /amount 也是 0% 填充），
 * 后端已不返回，页面表头也不列 —— 与原站一致。
 */
const route = useRoute()
const router = useRouter()
const keyword = ref((route.query.keyword as string) ?? '')
const loading = ref(false)
const items = ref<CompeteItem[]>([])
const dataScope = ref('')
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)
const sortBy = ref('nfScoreRatio')

async function search(kw: string) {
  keyword.value = kw
  if (!kw) {
    items.value = []
    dataScope.value = '请输入关键词。本页按词查该词下的竞品占位情况。'
    return
  }
  loading.value = true
  try {
    const res = await wordPickApi.compete({ keyword: kw, sortBy: sortBy.value, limit: 20 })
    items.value = res.items ?? []
    dataScope.value = res.dataScope ?? ''
    nextCursor.value = res.nextCursor
    hasMore.value = res.hasMore
  } catch {
    items.value = []
    dataScope.value = '查询失败，请稍后重试。'
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
    const res = await wordPickApi.compete({
      keyword: keyword.value,
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

/**
 * 跨页跳转（对齐原站的「操作」列）。
 * 各页以 ASIN 为纽带互相跳转，这是原站的重要交互特征。
 */
function goto(name: string, asin: string) {
  router.push({ name, query: { asin } })
}

onMounted(() => search(keyword.value))

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`)
const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(2)}`)
</script>

<template>
  <div class="page">
    <h1 class="page-title">流量位竞争格局</h1>
    <p class="page-desc">
      该关键词下具体是哪些产品在占位、各占哪类流量位多少份额。
      流量指<strong>搜索页的有效曝光流量</strong>，不是订单量或销量，
      也不是亚马逊后台的曝光量。
    </p>

    <KeywordSearchBar
      :initial="keyword"
      :loading="loading"
      :allow-empty="false"
      placeholder="输入关键词，例如 classroom caddy"
      @search="search"
    />

    <!-- 没有数据时只显示口径提示，不显示空表格 -->
    <el-alert
      v-if="!items.length && dataScope && !loading"
      type="info"
      :closable="false"
      show-icon
      class="tip"
      :title="dataScope"
    />

    <div v-if="items.length || loading" class="card" v-loading="loading">
      <div class="sec-head">
        <h2 class="sec-title">
          竞品占位明细
          <span class="muted">「{{ keyword }}」· 共 {{ items.length }} 个产品</span>
        </h2>
        <el-radio-group v-model="sortBy" size="small" @change="search(keyword)">
          <el-radio-button value="nfScoreRatio">按自然份额</el-radio-button>
          <el-radio-button value="spScoreRatio">按 SP 份额</el-radio-button>
          <el-radio-button value="price">按价格</el-radio-button>
        </el-radio-group>
      </div>

      <el-table :data="items" size="small" stripe>
        <el-table-column label="#" width="50" align="center">
          <template #default="{ row }">{{ row.rankPosition ?? '—' }}</template>
        </el-table-column>

        <el-table-column label="产品" min-width="260" fixed>
          <template #default="{ row }">
            <div class="prod">
              <el-image
                v-if="row.img"
                :src="row.img"
                fit="contain"
                class="thumb"
                lazy
                :preview-src-list="[row.img]"
                preview-teleported
              />
              <div class="prod-info">
                <div class="prod-title" :title="row.title ?? ''">{{ row.title ?? '—' }}</div>
                <div class="prod-meta">
                  <code>{{ row.asin }}</code>
                  <el-tag v-if="row.ac === 'true'" size="small" type="warning" effect="plain">
                    AC
                  </el-tag>
                  <el-tag v-if="row.hasVariants" size="small" effect="plain">多变体</el-tag>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="价格" width="90" align="right">
          <template #default="{ row }">{{ money(row.price) }}</template>
        </el-table-column>
        <el-table-column label="评论" width="120" align="right">
          <template #default="{ row }">
            <span v-if="row.star !== null">{{ row.star }}★</span>
            <span class="muted sm"> {{ row.ratingNum?.toLocaleString() ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="近30天销量" width="105" align="right">
          <!-- ⚠️ 分档字符串如 "6,000+"，不是精确值 -->
          <template #default="{ row }">{{ row.boughtInPastMonth ?? '—' }}</template>
        </el-table-column>

        <el-table-column label="各流量位份额" align="center">
          <el-table-column label="自然" width="85" align="right">
            <template #default="{ row }">
              <strong>{{ pct(row.nfScoreRatio) }}</strong>
            </template>
          </el-table-column>
          <el-table-column label="SP 常规" width="85" align="right">
            <template #default="{ row }">{{ pct(row.spScoreRatio) }}</template>
          </el-table-column>
          <el-table-column label="SP 推荐" width="85" align="right">
            <template #default="{ row }">{{ pct(row.spRecScoreRatio) }}</template>
          </el-table-column>
          <el-table-column label="SB 品牌" width="85" align="right">
            <template #default="{ row }">{{ pct(row.brandAdScoreRatio) }}</template>
          </el-table-column>
          <el-table-column label="SBV 视频" width="90" align="right">
            <template #default="{ row }">{{ pct(row.videoAdScoreRatio) }}</template>
          </el-table-column>
          <el-table-column label="AC 推荐" width="85" align="right">
            <template #default="{ row }">{{ pct(row.acScoreRatio) }}</template>
          </el-table-column>
        </el-table-column>

        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="goto('keywords', row.asin)">
              反查流量词
            </el-button>
            <el-button link type="primary" size="small" @click="goto('traffic', row.asin)">
              流量结构
            </el-button>
          </template>
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

.tip {
  margin-bottom: 16px;
}

.prod {
  display: flex;
  gap: 10px;
  align-items: center;
}

.thumb {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 4px;
  background: var(--fill-2, #f5f5f5);
}

.prod-info {
  min-width: 0;
}

.prod-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.prod-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3, #999);
}

.muted {
  color: var(--text-3, #999);
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
