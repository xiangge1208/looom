<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { businessApi } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import AiAnalysisCard from '@/components/AiAnalysisCard.vue'

/**
 * 广告透视（查广告架构 / 查投放小组 / 查广告词）
 *
 * 三个功能合成一个页面用 Tab 切换 —— 因为它们层层下钻：
 *   活动 → 投放小组 → 买家搜索词
 * 而且原站实测「三页之间不能真正下钻」（跳转只传 asin），
 * 所以合并成一处能连续查看反而更顺。
 *
 * ⚠️ 术语澄清（来自侦察结论）：
 *   - 「投放小组」是 Product Ad，不是 Amazon 的 AdGroup
 *   - 「广告词」是买家搜索词，不是卖家设置的投放词
 */
const route = useRoute()
const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const tab = ref('campaigns')

const campaigns = ref<any[]>([])
const selectedCampaign = ref<any>(null)
const productAds = ref<any[]>([])
const adsLoading = ref(false)

const searchTerms = ref<any[]>([])
const termsCursor = ref<string | null>(null)
const termsHasMore = ref(false)
const termsLoading = ref(false)

async function search(v: string) {
  asin.value = v
  loading.value = true
  selectedCampaign.value = null
  productAds.value = []
  searchTerms.value = []
  termsCursor.value = null
  try {
    const res = await businessApi.adCampaigns(v)
    campaigns.value = res.campaigns ?? []
  } catch {
    campaigns.value = []
  } finally {
    loading.value = false
  }
}

/** 点活动 → 看它的投放小组（本页内展开，不跳页） */
async function openCampaign(row: any) {
  selectedCampaign.value = row
  tab.value = 'groups'
  adsLoading.value = true
  try {
    const res = await businessApi.adProductAds(row.encryptCampaignId)
    productAds.value = res.productAds ?? []
  } catch {
    productAds.value = []
  } finally {
    adsLoading.value = false
  }
}

async function loadTerms() {
  termsLoading.value = true
  try {
    const res = await businessApi.adSearchTerms({
      asin: asin.value,
      cursor: termsCursor.value ?? undefined,
      limit: 20,
    })
    searchTerms.value = termsCursor.value
      ? [...searchTerms.value, ...res.items]
      : res.items
    termsCursor.value = res.nextCursor
    termsHasMore.value = res.hasMore
  } finally {
    termsLoading.value = false
  }
}

/** 切到广告词 Tab 时首次加载 */
function onTabChange(name: string) {
  if (name === 'terms' && !searchTerms.value.length) loadTerms()
}

onMounted(() => {
  if (asin.value) search(asin.value)
})

const AD_TYPE_COLORS: Record<number, string> = {
  1: '',
  2: 'success',
  3: 'warning',
  4: 'danger',
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">广告透视</h1>
    <p class="page-desc">还原竞品的广告架构：跑了哪些活动、投在哪些投放小组、买家用什么词搜到它</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <div v-if="campaigns.length || loading" class="card">
      <el-tabs v-model="tab" @tab-change="onTabChange">
        <!-- 查广告架构 -->
        <el-tab-pane label="查广告架构" name="campaigns">
          <el-table :data="campaigns" stripe v-loading="loading">
            <el-table-column label="活动短码" width="96">
              <template #default="{ row }">
                <span class="mono">{{ row.fakeCampaignId }}</span>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="112">
              <template #default="{ row }">
                <el-tag :type="AD_TYPE_COLORS[row.adType] || ''" size="small" effect="plain">
                  {{ row.adTypeName }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="strategy" label="投放策略" min-width="160" />
            <el-table-column label="涉及 ASIN" width="104">
              <template #default="{ row }">{{ row.asinNum }}</template>
            </el-table-column>
            <el-table-column label="投放小组" width="104">
              <template #default="{ row }">
                <span class="strong">{{ row.involvedAdNum }}</span>
                <span class="muted"> / {{ row.adNum }}</span>
              </template>
            </el-table-column>
            <el-table-column label="流量得分" width="112" sortable :sort-method="(a: any, b: any) => a.totalScore - b.totalScore">
              <template #default="{ row }">
                <span class="mono">{{ (row.totalScore ?? 0).toLocaleString() }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="campaignCreatedAt" label="创建日期" width="118" />
            <el-table-column label="操作" width="104" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openCampaign(row)">
                  看投放小组
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 查投放小组 -->
        <el-tab-pane label="查投放小组" name="groups">
          <div v-if="selectedCampaign" class="ctx-bar">
            <span class="muted">当前活动：</span>
            <span class="mono">{{ selectedCampaign.fakeCampaignId }}</span>
            <el-tag size="small" effect="plain">{{ selectedCampaign.adTypeName }}</el-tag>
            <span class="muted">{{ selectedCampaign.strategy }}</span>
          </div>
          <el-empty
            v-if="!selectedCampaign"
            description="请先在「查广告架构」里选择一个活动"
            :image-size="70"
          />
          <template v-else>
            <el-table :data="productAds" stripe v-loading="adsLoading">
              <el-table-column label="投放小组短码" width="136">
                <template #default="{ row }">
                  <span class="mono">{{ row.fakeAdId }}</span>
                </template>
              </el-table-column>
              <el-table-column label="加密 ID" min-width="230">
                <template #default="{ row }">
                  <span class="mono ellipsis">{{ row.encryptAdId }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="adCreatedAt" label="创建日期" width="118" />
              <el-table-column prop="firstSeen" label="首次出现" width="118" />
              <el-table-column prop="lastSeen" label="最近出现" width="118" />
              <el-table-column label="活跃周期数" width="112">
                <template #default="{ row }">{{ row.activeWeeks }}</template>
              </el-table-column>
            </el-table>
            <p class="hint muted">
              投放小组与活动的关系带时间维度：同一活动在不同周期包含的投放小组会变化，
              所以「活跃周期数」反映投放是否持续。
            </p>
          </template>
        </el-tab-pane>

        <!-- 查广告词 -->
        <el-tab-pane label="查广告词" name="terms">
          <el-table :data="searchTerms" stripe v-loading="termsLoading">
            <el-table-column label="搜索词" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="kw-cell">
                  <span>{{ row.searchTerm }}</span>
                  <span v-if="row.translateKeyword" class="kw-cn muted">
                    {{ row.translateKeyword }}
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="流量位" width="112">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ row.trafficTypeName }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="排名" width="82">
              <template #default="{ row }">
                <span v-if="row.rankPosition !== null">{{ row.rankPosition }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="流量得分" width="106">
              <template #default="{ row }">
                <span class="mono">{{ row.score.toLocaleString() }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="statDate" label="日期" width="112" />
          </el-table>
          <div class="more-bar">
            <el-button v-if="termsHasMore" :loading="termsLoading" @click="loadTerms">
              加载更多
            </el-button>
            <span v-else-if="searchTerms.length" class="muted">
              已加载全部 {{ searchTerms.length }} 条
            </span>
          </div>
          <p class="hint muted">
            这里列出的是<strong>买家实际搜索的词</strong>，不是卖家后台设置的投放词。
          </p>
        </el-tab-pane>
            </el-tabs>
    </div>

    <!--
    AI 插入点 5：广告结构优化（goal.md「5. 查广告架构页 → 预算浪费识别 + 优化动作」）

      只在查到活动后才显示。送给模型的是活动列表本身 ——
      ⚠️ 没有花费/点击/转化数据（这是竞品广告结构透视，拿不到对方后台），
      prompt 里已明令禁止模型谈 ACOS/ROI/预算金额。
    -->
    <AiAnalysisCard
      v-if="campaigns.length"
      insert-point="ad-optimize"
      title="AI 广告结构优化"
      :input="{
        asin,
      country: 'US',
        campaigns: campaigns.map((c) => ({
   fakeCampaignId: c.fakeCampaignId,
          adTypeName: c.adTypeName,
          strategy: c.strategy,
          asinNum: c.asinNum,
    adNum: c.adNum,
          involvedAdNum: c.involvedAdNum,
      totalScore: c.totalScore,
 })),
   }"
    />

    <el-empty v-else-if="!loading" description="输入 ASIN 开始查询" :image-size="90" />
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 16px;
}

.ctx-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 12px;
  background: var(--brand-50);
  border-radius: var(--radius);
  margin-bottom: 12px;
  font-size: 12.5px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.ellipsis {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.strong {
  font-weight: 600;
}

.kw-cell {
  display: flex;
  flex-direction: column;
}

.kw-cn {
  font-size: 11.5px;
}

.more-bar {
  margin-top: 14px;
  text-align: center;
  font-size: 12.5px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
</style>
