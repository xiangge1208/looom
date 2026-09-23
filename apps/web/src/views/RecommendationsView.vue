<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { businessApi, type RecColumnData } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'
import QuerySkeleton from '@/components/QuerySkeleton.vue'
import Sparkline from '@/components/Sparkline.vue'

/**
 * 查推荐专栏
 *
 * 对应原站 /recommend。版面与列定义依据 docs/SPEC_REC_COLUMN_UI.md
 * （该文档是对原站的实测复刻规格，含 CSSOM 取值）。
 *
 * ## 当前是 UI 骨架，部分列的数据还在补
 *
 * 数据可支撑度见 docs/AUDIT_REC_COLUMN_DATA.md，实测结论：
 *   流量占比      仅 seed ASIN 有，真实 ASIN 待采集补齐
 *   广告活动/词数  有，但词覆盖只有原站约 1/12（实测 3 vs 35）
 *   按天趋势      需扩 ETL，暂无
 *
 * 所以每一列都要能区分三种状态：有值 / 真的是 0 / 我们没这个数据。
 * 后端用 null 表示第三种，并通过 coverage 告知哪些口径整体缺失 ——
 * 前端**不许**把 null 渲染成 0 或 0%，那会把「未采集」显示成「没有流量」。
 *
 * ⚠️ 推荐专栏是**动态实体**不是固定枚举：原站前端只硬编码 8 个短码，
 * 实测已出现 100+ 个标题且还在增加（同义文案 A/B 测试），
 * 所以未知短码要降级展示英文原文，不能过滤掉。
 */
const route = useRoute()
const router = useRouter()

const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const data = ref<RecColumnData | null>(null)

async function search(v: string) {
  asin.value = v
  loading.value = true
  try {
    data.value = await businessApi.recommendations(v)
    router.replace({ query: { ...route.query, asin: v } })
  } catch {
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (asin.value) search(asin.value)
})

const columns = computed(() => data.value?.columns ?? [])
const coverage = computed(
  () => data.value?.coverage ?? { hasRatio: false, hasCounts: false, hasTrends: false },
)

const SHORT_CODE_LABEL: Record<string, string> = {
  Media: '社媒',
  '4Star': '四星',
  fView: '常看',
  KOL: '达人',
  rBuy: '复购',
  Trend: '热门',
  New: '新品',
  tDeal: '特惠',
  other: '其它',
}

/**
 * 流量占比的展示文本。
 *
 * ⚠️ null 必须显示「—」而不是 0%。
 * 直接 `(null * 100).toFixed(1)` 会渲染成 "0.0%"，用户读成
 * 「这个专栏没带来流量」，而真相是「这个口径我们还没采集」——
 * 两者含义相反，是这个页面最容易犯的错。
 *
 * 小数位取 1 位：原站显示 70% / 7.2% / 0.32%，即有效数字 2 位左右，
 * 原先写的 3 位小数（0.320%）精度远超数据本身的意义。
 */
function fmtRatio(ratio: number | null | undefined) {
  if (ratio === null || ratio === undefined) return '—'
  const p = Number(ratio) * 100
  // 小于 1% 时保留 2 位，否则 0.32% 会被四舍五入成 0.3%
  return `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`
}

/** 计数的展示文本。同上，null → 「—」，0 才是真的 0 */
function fmtCount(n: number | null | undefined) {
  if (n === null || n === undefined) return '—'
  return Number(n).toLocaleString()
}

/**
 * 占比条宽：按**组内最大值**归一。
 *
 * 不按 100% 归一 —— 尾部专栏常在 1% 以下（实测 0.32%），
 * 按 100% 画会短到看不见。最强的那个占满格，其余按比例收缩。
 */
function ratioBarWidth(ratio: number | null | undefined): string {
  const max = Math.max(...columns.value.map((c) => c.ratio ?? 0), 0)
  if (max <= 0 || ratio === null || ratio === undefined) return '0%'
  return `${Math.max(ratio > 0 ? 3 : 0, (ratio / max) * 100)}%`
}

/** 专栏配色。SPEC §1.2 的图表色盘，按序轮换 */
const PALETTE = [
  '#009F52', '#3A58FF', '#F2732F', '#7CC00A', '#22C3A6',
  '#FFB302', '#D95140', '#8A6D1F', '#2F6FED', '#EEDB47',
]
function colorOf(i: number) {
  return PALETTE[i % PALETTE.length]
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">查推荐专栏</h1>
    <p class="page-desc">查看该 ASIN 出现在哪些亚马逊推荐位、各带来多少流量</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <QuerySkeleton v-if="loading && !data" />

    <template v-if="data">
      <!--
        科普提示条（SPEC [D1]）。原站也有这块，讲清「推荐专栏是什么、能看出什么」。
        原站右侧还有「安装插件同步广告活动名称」按钮 —— 我们没有插件，不放。
      -->
      <div class="tips">
        <div class="tips-body">
          <p>① 亚马逊目前有十余个常见推荐专栏，几乎都是 SP 广告产品带来的曝光。</p>
          <p>② 本页回答四件事：哪些专栏获得了曝光、各占多少流量、由哪些广告活动获得、在哪些词上获得。</p>
          <p>
            ③ 「推荐专栏都是自动广告投出来的」是<strong>错误说法</strong>，
            手动广告同样能获得推荐专栏曝光。
          </p>
        </div>
      </div>

      <!-- 三个计数卡（SPEC [D3]） -->
      <div class="stat-row">
        <div class="stat">
          <span class="s-label">获得的推荐专栏</span>
          <span class="s-val">{{ fmtCount(data.overview.recCount) }}<i>个</i></span>
        </div>
        <div class="stat">
          <span class="s-label">获得推荐专栏的广告活动数量</span>
          <span class="s-val" :class="{ dim: data.overview.campaignCount === null }">
            {{ fmtCount(data.overview.campaignCount) }}<i v-if="data.overview.campaignCount !== null">个</i>
          </span>
        </div>
        <div class="stat">
          <span class="s-label">获得推荐专栏的广告词数量</span>
          <span class="s-val" :class="{ dim: data.overview.keywordCount === null }">
            {{ fmtCount(data.overview.keywordCount) }}<i v-if="data.overview.keywordCount !== null">个</i>
          </span>
        </div>
      </div>

      <!-- 主表（SPEC [D4]） -->
      <div class="card" v-loading="loading">
        <div class="card-head">
          <h2 class="sec-title">
            该产品在关键词搜索页获得了 {{ columns.length }} 个推荐专栏
            <span v-if="data.statDate" class="muted sm">（数据截至 {{ data.statDate }}）</span>
          </h2>
        </div>

        <el-empty v-if="!columns.length" description="该 ASIN 暂无推荐专栏曝光" :image-size="70" />

        <el-table v-else :data="columns" stripe style="width: 100%">
          <el-table-column type="index" label="#" width="56" align="center" />

          <el-table-column label="推荐专栏名称" min-width="230">
            <template #default="{ row }">
              <div class="name-cell">
                <span class="n-line">
                  <!--
                    短码标签：把 100+ 个动态标题归到几个可辨认的类别。
                    未知短码回落成 other→「其它」，不隐藏该行 ——
                    专栏是动态实体，过滤未知标题会让数据凭空少掉。
                  -->
                  <el-tag size="small" effect="plain">
                    {{ SHORT_CODE_LABEL[row.shortCode] ?? row.shortCode }}
                  </el-tag>
                  <span class="n-main">{{ row.name }}</span>
                </span>
                <!-- 显示名与英文原文不同时把原文也列出，便于核对是哪个专栏 -->
                <span v-if="row.name !== row.recTitle" class="n-raw">{{ row.recTitle }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="流量占比" min-width="150">
            <template #default="{ row, $index }">
              <div class="metric-cell">
                <div class="m-bar">
                  <div
                    class="m-fill"
                    :style="{ width: ratioBarWidth(row.ratio), background: colorOf($index) }"
                  />
                </div>
                <span class="m-num" :class="{ dim: row.ratio === null }">
                  {{ fmtRatio(row.ratio) }}
                </span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="广告活动数量" width="126" align="right">
            <template #default="{ row }">
              <span :class="{ dim: row.campaignCount === null }">
                {{ fmtCount(row.campaignCount) }}
              </span>
            </template>
          </el-table-column>

          <el-table-column label="广告词数量" width="116" align="right">
            <template #default="{ row }">
              <span :class="{ dim: row.keywordCount === null }">
                {{ fmtCount(row.keywordCount) }}
              </span>
            </template>
          </el-table-column>

          <!--
            广告活动类型占比(手动-自动)。
            原站这列也算不出来，显示「需自动同步后台广告活动才能计算」+ 一键同步按钮 ——
            那是个**插件门控**功能，不是数据缺失（第一版审计误判过这点）。
            我们没有插件，所以照原站保留此列并写明原因，而不是删列或填 0：
            删列会让对照原站的人以为漏实现，填 0 则是错的。
          -->
          <el-table-column label="广告活动类型占比(手动-自动)" min-width="230" align="center">
            <template #default>
              <span class="dim sm">需同步后台广告活动才能计算，暂不支持</span>
            </template>
          </el-table-column>

          <!--
            按天趋势两列。
            数值取 last*（最近有效值）而不是趋势数组末位 —— 实测有的行
            ct 末位是 null 而 lastCampaignCnt=1，取末位会把有数据显示成「—」。
          -->
          <el-table-column label="获得该推荐专栏的&#10;广告活动数量及趋势" min-width="190" align="center">
            <template #default="{ row }">
              <div class="trend-cell">
                <Sparkline
                  v-if="row.campaignTrends"
                  :values="row.campaignTrends"
                  :width="104"
                  :height="30"
                />
                <span v-else class="dim sm">无趋势数据</span>
                <span class="trend-num">{{ fmtCount(row.lastCampaignCount) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="获得该推荐专栏的&#10;广告词数量及趋势" min-width="190" align="center">
            <template #default="{ row }">
              <div class="trend-cell">
                <Sparkline
                  v-if="row.keywordTrends"
                  :values="row.keywordTrends"
                  :width="104"
                  :height="30"
                />
                <span v-else class="dim sm">无趋势数据</span>
                <span class="trend-num">{{ fmtCount(row.lastKeywordCount) }}</span>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <!--
          数据完备度必须写明。这个页面的多数列当前是空的，
          不说清楚用户会以为「这个 ASIN 真的没有推荐专栏流量」。
        -->
        <div class="notes">
          <p v-if="!coverage.hasRatio" class="note warn">
            <strong>流量占比暂无数据</strong> ——
            该口径正在采集补齐，当前仅少量 ASIN 有值。显示「—」表示未采集，<strong>不代表没有流量</strong>。
          </p>
          <p v-if="coverage.hasCounts" class="note">
            广告活动数与广告词数来自关联数据，实测词覆盖约为原站的 1/12，
            数值会偏小；采集补齐后会一并修正。
          </p>
          <p v-if="!coverage.hasCounts" class="note warn">
            <strong>广告活动数与广告词数暂无数据</strong> —— 显示「—」表示未采集。
          </p>
          <p class="note">
            推荐专栏是<strong>动态实体</strong>：原站没有固定枚举，标题由上游下发，
            同一含义可能有多种文案（亚马逊在做 A/B 测试）。未知标题会原样展示英文原文。
          </p>
        </div>
      </div>
    </template>

    <el-empty v-else-if="!loading" description="输入 ASIN 开始查询" :image-size="90" />
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 16px;
}

.card-head {
  margin-bottom: 12px;
}

.sec-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

/* ---- 科普提示条（SPEC [D1]：暖底 #FFF5EE）---- */
.tips {
  background: #fff5ee;
  border: 1px solid var(--line, #f1f2f5);
  border-radius: 4px;
  padding: 10px 14px;
  margin-bottom: 14px;
}

.tips-body p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--ink-700);
}

/* ---- 三个计数卡（SPEC [D3]）---- */
.stat-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 14px;
}

@media (max-width: 900px) {
  .stat-row {
    grid-template-columns: 1fr;
  }
}

.stat {
  background: var(--bg-card, #fff);
  border: 1px solid var(--line, #f1f2f5);
  border-radius: 6px;
  padding: 14px 18px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.s-label {
  font-size: 12.5px;
  color: var(--ink-700);
}

.s-val {
  font-size: 22px;
  font-weight: 600;
  color: var(--brand-500, #009f52);
  font-variant-numeric: tabular-nums;
}

.s-val i {
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  margin-left: 2px;
  color: var(--ink-500);
}

/* ---- 表格单元格 ---- */
.name-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.4;
}

.n-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.n-main {
  font-size: 13px;
}

/* 英文原文弱化：它只用于核对，不该和显示名抢注意力 */
.n-raw {
  font-size: 11.5px;
  color: var(--ink-500);
}

.metric-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.m-bar {
  flex: 1;
  min-width: 34px;
  height: 8px;
  background: var(--ink-100, #f0f0f0);
  border-radius: 4px;
  overflow: hidden;
}

.m-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.2s;
}

.m-num {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 46px;
  text-align: right;
}

/*
  「数据未采集」的统一弱化样式。
  与真实的 0 必须看起来不同 —— 同样的字重会让「—」被当成一个数值读。
*/
.dim {
  color: var(--ink-400, #9aa0a6);
}

.sm {
  font-size: 11.5px;
}

/* ---- 趋势列：迷你折线 + 行尾当前数 ---- */
.trend-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

/*
  行尾数字右对齐且定宽，多行之间才对得齐 ——
  它是这一列的「当前值」，要和折线末端分开读，不能跟着折线浮动。
*/
.trend-num {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  min-width: 28px;
  text-align: right;
}

/* ---- 数据完备度说明 ---- */
.notes {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line, #f1f2f5);
}

.note {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-500);
}

.note:last-child {
  margin-bottom: 0;
}

/* 缺数据的警示用暖色，与普通说明区分开 */
.note.warn {
  color: #b4560f;
}
</style>
