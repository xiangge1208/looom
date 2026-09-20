<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AiAnalysisCard from '@/components/AiAnalysisCard.vue'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import { diagnosisApi, type DiagnosisSummary } from '@/api/business'

/**
 * AI 综合诊断（goal.md 第 14 页 + AI 插入点 6）
 *
 * 先把四个域的现状汇总展示，再交给 AI 做根因分析。
 *
 * 关键点：**缺失的域要显式标出来**，不能悄悄显示为 0 或空白。
 * seed 数据分布不均（关键词只在部分子体上、广告只在少数 ASIN 上），
 * 用户很容易查到一个只有部分数据的 ASIN。把「无数据」和「数值为 0」
 * 混在一起显示会让人误判，AI 也会跟着编。
 */
const route = useRoute()
const router = useRouter()

const asin = ref((route.query.asin as string) ?? '')
const country = ref((route.query.country as string) ?? 'US')
const data = ref<DiagnosisSummary | null>(null)
const loading = ref(false)

async function load() {
  if (!asin.value.trim()) return
  loading.value = true
  try {
    data.value = await diagnosisApi.summarize(asin.value.trim(), country.value)
  } catch {
    // 拦截器已提示
    data.value = null
  } finally {
    loading.value = false
  }
}

function onSearch(v: string) {
  asin.value = v
  // 同步到 URL，方便分享和刷新后保持
  void router.replace({ query: { ...route.query, asin: v, country: country.value } })
  void load()
}

/** 百分比展示。ratio 是 0-1 小数，乘 100 的责任在前端 */
function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toFixed(1)}%`
}

const domains = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { key: '销量', ok: d.sales.available, detail: d.sales.available ? `${d.sales.variantCount ?? 0} 个变体` : '无数据' },
    {
      key: '流量结构',
      ok: d.traffic.available,
      detail: d.traffic.available
        ? `自然 ${pct(d.traffic.naturalRatio)} / 广告 ${pct(d.traffic.adRatio)}`
        : '无数据',
    },
    {
      key: '关键词',
      ok: d.keywords.available,
      detail: d.keywords.available ? `Top ${d.keywords.topKeywords?.length ?? 0} 词` : '无数据',
    },
    {
      key: '广告',
      ok: d.ads.available,
      detail: d.ads.available ? `${d.ads.campaignCount ?? 0} 个活动` : '无数据',
    },
  ]
})

watch(() => route.query.asin, (v) => {
  if (typeof v === 'string' && v && v !== asin.value) {
    asin.value = v
    void load()
  }
})

onMounted(() => {
  if (asin.value) void load()
})
</script>

<template>
  <div class="page">
    <h1 class="page-title">AI 综合诊断</h1>
    <p class="page-desc">汇总销量、流量、关键词、广告四个维度，给出根因分析与行动计划</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="onSearch" />

    <template v-if="loading">
      <el-skeleton :rows="5" animated class="card" />
    </template>

    <template v-else-if="data">
      <!-- 数据完整性总览。缺哪块必须让人一眼看到 -->
      <div class="card">
        <h2 class="sec-title">数据完整性</h2>
        <div class="domains">
          <div
            v-for="d in domains"
            :key="d.key"
            class="domain"
            :class="{ missing: !d.ok }"
          >
            <div class="d-head">
              <span class="d-dot">{{ d.ok ? '●' : '○' }}</span>
              <span class="d-name">{{ d.key }}</span>
            </div>
            <div class="d-detail">{{ d.detail }}</div>
          </div>
        </div>

        <el-alert
          v-if="data.missingDomains.length"
          type="warning"
          :closable="false"
          show-icon
          class="mt"
          :title="`以下维度无数据：${data.missingDomains.join('、')}`"
          description="AI 分析会明确标注这些维度受限，不会基于缺失数据下结论。换一个数据更完整的 ASIN 可获得更全面的诊断。"
        />
      </div>

      <template v-if="data.hasAnyData">
        <!-- 各域摘要 -->
        <div class="card" v-if="data.traffic.available">
          <h2 class="sec-title">流量构成</h2>
          <div class="bars">
            <div class="bar-row">
              <span class="bar-label">自然流量</span>
              <div class="bar-track">
                <div class="bar-fill nf" :style="{ width: pct(data.traffic.naturalRatio) }" />
              </div>
              <span class="bar-val">{{ pct(data.traffic.naturalRatio) }}</span>
            </div>
            <div class="bar-row">
              <span class="bar-label">广告流量</span>
              <div class="bar-track">
                <div class="bar-fill ad" :style="{ width: pct(data.traffic.adRatio) }" />
              </div>
              <span class="bar-val">{{ pct(data.traffic.adRatio) }}</span>
            </div>
          </div>
        </div>

        <div class="card" v-if="data.keywords.available && data.keywords.topKeywords?.length">
          <h2 class="sec-title">核心流量词</h2>
          <el-table :data="data.keywords.topKeywords" stripe size="small">
            <el-table-column prop="keyword" label="关键词" min-width="180" show-overflow-tooltip />
            <el-table-column label="自然位" width="88" align="right">
              <template #default="{ row }">{{ row.rank ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="搜索量" width="100" align="right">
              <template #default="{ row }">{{ row.searches ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="流量占比" width="100" align="right">
              <template #default="{ row }">{{ pct(row.scoreRatio) }}</template>
            </el-table-column>
          </el-table>
        </div>

        <div class="card" v-if="data.ads.available && data.ads.campaigns?.length">
          <h2 class="sec-title">广告结构</h2>
          <el-table :data="data.ads.campaigns" stripe size="small">
            <el-table-column prop="fakeCampaignId" label="活动" width="90" />
            <el-table-column prop="adTypeName" label="类型" width="130" />
            <el-table-column prop="strategy" label="投放策略" min-width="150" show-overflow-tooltip />
            <el-table-column label="投放小组" width="96" align="right">
              <template #default="{ row }">{{ row.involvedAdNum ?? '—' }}</template>
            </el-table-column>
          </el-table>
        </div>

        <!-- AI 插入点 6 -->
        <AiAnalysisCard
          insert-point="diagnosis"
          title="AI 综合根因诊断"
          :input="{
            asin: data.asin,
            country: data.country,
            missingDomains: data.missingDomains,
            summary: {
              sales: data.sales,
              traffic: data.traffic,
              keywords: data.keywords,
              ads: data.ads,
              recommendations: data.recommendations,
            },
          }"
        />
      </template>

      <el-empty
        v-else
        description="该 ASIN 四个维度均无数据，无法诊断。请换一个 ASIN。"
        :image-size="90"
      />
    </template>

    <el-empty v-else description="输入 ASIN 开始综合诊断" :image-size="90" />
  </div>
</template>

<style scoped>
.sec-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}

.domains {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.domain {
  flex: 1;
  min-width: 132px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.domain.missing {
  background: var(--bg-soft, #fafbfc);
  border-style: dashed;
}

.d-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.d-dot {
  font-size: 9px;
  color: var(--ok, #1ab364);
}

.domain.missing .d-dot {
  color: var(--ink-400, #c0c4cc);
}

.d-name {
  font-size: 13px;
  font-weight: 600;
}

.d-detail {
  margin-top: 5px;
  font-size: 12px;
  color: var(--ink-500);
}

.domain.missing .d-detail {
  font-style: italic;
}

.mt {
  margin-top: 14px;
}

.bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bar-label {
  width: 68px;
  font-size: 12.5px;
  color: var(--ink-700);
  flex-shrink: 0;
}

.bar-track {
  flex: 1;
  height: 16px;
  background: var(--bg-soft, #f5f7fa);
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}

.bar-fill.nf {
  background: var(--brand-500);
}

.bar-fill.ad {
  background: var(--warn, #e6a23c);
}

.bar-val {
  width: 52px;
  text-align: right;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
</style>
