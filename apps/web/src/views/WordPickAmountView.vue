<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { wordPickApi, type AmountItem } from '@/api/business'
import KeywordSearchBar from '@/components/KeywordSearchBar.vue'

/**
 * 流量位竞品数量（M13 /amount）
 *
 * 该关键词下各流量位有多少个竞品 ASIN 在占位。
 *
 * ## ⚠️ 本页一行里有两种时间语义，不能对用户说成同一周
 *
 * 竞品数量那 8 列来自 web-compete-keyword，源响应**没有周维度**，
 * 是「最近一次抓取的竞品格局」。而搜索量/排名来自另一个源，是「该 ABA 周的」。
 * 表头上分组标注，避免误读。
 *
 * ## 竞品数量列只有少部分词有数据
 *
 * 落表 321/22,320 行（compete 源只覆盖 789 词，与本表词级交集 321）。
 * 所以：
 *   - `hasCompeteData=false` 的行那 8 列显示「—」，不是 0
 *   - 提供「只看有竞品数据」开关，但**默认关闭** ——
 *     默认开会让用户以为库里只有 321 个词
 */
const route = useRoute()
const router = useRouter()
const keyword = ref((route.query.keyword as string) ?? '')
const loading = ref(false)
const items = ref<AmountItem[]>([])
const statWeek = ref<string | null>(null)
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)

/** 默认 false —— 见文件头的说明 */
const onlyWithCompete = ref(false)
const sortBy = ref('estSearchesNum')

async function search(kw: string) {
  keyword.value = kw
  loading.value = true
  try {
    const res = await wordPickApi.amount({
      keyword: kw || undefined,
      onlyWithCompete: onlyWithCompete.value || undefined,
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
}

async function loadMore() {
  if (!nextCursor.value) return
  loading.value = true
  try {
    const res = await wordPickApi.amount({
      keyword: keyword.value || undefined,
      onlyWithCompete: onlyWithCompete.value || undefined,
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

function reload() {
  search(keyword.value)
}

/** 跳到竞争格局页看该词下具体是哪些 ASIN 在占位（跨页联动，对齐原站） */
function gotoCompete(kw: string) {
  router.push({ name: 'wordpick-compete', query: { keyword: kw } })
}

onMounted(() => search(keyword.value))

const num = (v: number | null) => (v === null ? '—' : v.toLocaleString())
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

/** 竞品数量列：无数据显示「—」，有数据显示数字（含 0） */
function competeNum(row: AmountItem, v: number | null) {
  if (!row.hasCompeteData) return '—'
  return v === null ? '—' : v.toLocaleString()
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">流量位竞品数量</h1>
    <p class="page-desc">
      该关键词下各流量位有多少竞品在占位。用于判断哪类流量位竞争较松、值得切入。
      搜索使用类似亚马逊的<strong>词组匹配模式</strong>。
    </p>

    <KeywordSearchBar
      :initial="keyword"
      :loading="loading"
      placeholder="输入关键词；留空看搜索量榜单"
      @search="search"
    />

    <div v-if="items.length || loading" class="card" v-loading="loading">
      <div class="sec-head">
        <h2 class="sec-title">
          竞品占位
          <span class="muted">
            {{ keyword ? `「${keyword}」` : '（榜单）' }}
            <template v-if="statWeek">· ABA 周 {{ statWeek }}</template>
          </span>
        </h2>
        <div class="tools">
          <el-checkbox v-model="onlyWithCompete" size="small" @change="reload">
            只看有竞品数据的词
          </el-checkbox>
          <el-radio-group v-model="sortBy" size="small" @change="reload">
            <el-radio-button value="estSearchesNum">按搜索量</el-radio-button>
            <el-radio-button value="nfAsinNum">按自然位竞品数</el-radio-button>
            <el-radio-button value="ppcAsinNum">按广告位竞品数</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <el-alert
        v-if="!onlyWithCompete"
        type="info"
        :closable="false"
        show-icon
        class="tip"
      >
        竞品数量列仅覆盖部分关键词，显示「—」表示该词暂无抓取数据（不是 0 个竞品）。
        勾选上方「只看有竞品数据的词」可过滤。
      </el-alert>

      <el-empty v-if="!items.length && !loading" description="暂无数据" :image-size="70" />

      <el-table v-else :data="items" size="small" stripe>
        <el-table-column prop="keyword" label="关键词" min-width="170" fixed />

        <!-- 这两列是「该 ABA 周的」，与右侧竞品数量列的时间语义不同 -->
        <el-table-column label="搜索趋势（该周）" align="center">
          <el-table-column label="搜索量" width="100" align="right">
            <template #default="{ row }">{{ num(row.estSearchesNum) }}</template>
          </el-table-column>
          <el-table-column label="ABA 排名" width="95" align="right">
            <template #default="{ row }">{{ num(row.searchesRank) }}</template>
          </el-table-column>
          <el-table-column label="在售产品数" width="110" align="right">
            <!-- ⚠️ 是在售商品数量，不是销量 -->
            <template #default="{ row }">{{ num(row.activeListingNum) }}</template>
          </el-table-column>
        </el-table-column>

        <!-- 这组列是「最近一次抓取的」，源响应无周维度 -->
        <el-table-column label="各流量位竞品数（最近一次抓取）" align="center">
          <el-table-column label="自然位" width="85" align="right">
            <template #default="{ row }">{{ competeNum(row, row.nfAsinNum) }}</template>
          </el-table-column>
          <el-table-column label="广告位合计" width="105" align="right">
            <template #default="{ row }">{{ competeNum(row, row.ppcAsinNum) }}</template>
          </el-table-column>
          <el-table-column label="SP 常规" width="90" align="right">
            <template #default="{ row }">{{ competeNum(row, row.spAsinNum) }}</template>
          </el-table-column>
          <el-table-column label="SP 推荐" width="90" align="right">
            <template #default="{ row }">
              {{ competeNum(row, row.spRecommendedAsinNum) }}
            </template>
          </el-table-column>
          <el-table-column label="SB 品牌" width="90" align="right">
            <template #default="{ row }">{{ competeNum(row, row.brandAsinNum) }}</template>
          </el-table-column>
          <el-table-column label="SBV 视频" width="95" align="right">
            <template #default="{ row }">{{ competeNum(row, row.videoAsinNum) }}</template>
          </el-table-column>
          <el-table-column label="AC 推荐" width="90" align="right">
            <template #default="{ row }">
              <!-- AC 是稀缺标，实测多为 0。有数据时显示 0 而非空白 -->
              {{ competeNum(row, row.acAsinNum) }}
            </template>
          </el-table-column>
        </el-table-column>

        <el-table-column label="ABA Top3 集中度" width="150" align="right">
          <template #default="{ row }">
            <template v-if="row.top3ClickShare !== null || row.top3ConversionShare !== null">
              点击 {{ pct(row.top3ClickShare) }}
              <span class="muted sm"> / 转化 {{ pct(row.top3ConversionShare) }}</span>
            </template>
            <span v-else>—</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="gotoCompete(row.keyword)">
              查竞争格局
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="hasMore" class="more">
        <el-button :loading="loading" @click="loadMore">加载更多</el-button>
      </div>
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
  gap: 14px;
  flex-wrap: wrap;
}

.tip {
  margin-bottom: 10px;
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
</style>
