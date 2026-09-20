<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { businessApi } from '@/api/business'
import AsinSearchBar from '@/components/AsinSearchBar.vue'

/**
 * 查推荐专栏
 *
 * 查看某 ASIN 出现在亚马逊详情页哪些推荐位、带来了多少流量。
 *
 * ⚠️ 侦察要点：推荐专栏是**动态实体**，不是固定枚举。
 * 原站前端只硬编码了 8 个短码，但实测能抽出十多个标题且还在增加
 * （同义文案 A/B 测试），所以这里对未知短码要能优雅降级展示原文。
 */
const route = useRoute()
const asin = ref((route.query.asin as string) ?? '')
const loading = ref(false)
const columns = ref<any[]>([])

async function search(v: string) {
  asin.value = v
  loading.value = true
  try {
    const res = await businessApi.recommendations(v)
    columns.value = res.columns ?? []
  } catch {
    columns.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (asin.value) search(asin.value)
})

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
</script>

<template>
  <div class="page">
    <h1 class="page-title">查推荐专栏</h1>
    <p class="page-desc">查看该 ASIN 出现在哪些亚马逊推荐位、各带来多少流量</p>

    <AsinSearchBar :initial="asin" :loading="loading" @search="search" />

    <div v-if="columns.length || loading" class="card" v-loading="loading">
      <h2 class="sec-title">
        推荐位分布
        <span class="muted">（共 {{ columns.length }} 个专栏）</span>
      </h2>

      <el-empty v-if="!columns.length && !loading" description="暂无推荐专栏流量" :image-size="70" />

      <div v-else class="col-grid">
        <div v-for="c in columns" :key="c.recTitle" class="col-item">
          <div class="col-head">
            <el-tag size="small" effect="plain">
              {{ SHORT_CODE_LABEL[c.shortCode] ?? c.shortCode }}
            </el-tag>
            <span class="col-name" :title="c.recTitle">{{ c.name }}</span>
          </div>

          <!-- 原文与显示名不同时，把原文也列出来，便于核对是哪个专栏 -->
          <div v-if="c.name !== c.recTitle" class="col-raw muted">{{ c.recTitle }}</div>

          <div class="col-metrics">
            <div class="metric">
              <span class="m-val">{{ (c.totalRatio * 100).toFixed(3) }}%</span>
              <span class="m-label">流量占比</span>
            </div>
            <div class="metric">
              <span class="m-val">{{ c.points.length }}</span>
              <span class="m-label">数据点</span>
            </div>
          </div>

          <div class="col-points">
            <div v-for="p in c.points" :key="p.date" class="point">
              <span class="p-date">{{ p.date }}</span>
              <div class="p-bar">
                <div
                  class="p-fill"
                  :style="{ width: `${Math.min(100, p.ratio * 100 * 8)}%` }"
                />
              </div>
              <span class="p-ratio">{{ (p.ratio * 100).toFixed(3) }}%</span>
            </div>
          </div>
        </div>
      </div>

      <p class="hint muted">
        推荐专栏是<strong>动态实体</strong>：原站没有固定枚举，标题由后端下发，
        且同一含义可能有多种文案（亚马逊在做 A/B 测试）。本页对未知标题会原样展示英文原文。
      </p>
    </div>

    <el-empty v-else-if="!loading" description="输入 ASIN 开始查询" :image-size="90" />
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 16px;
}

.sec-title {
  margin: 0 0 14px;
  font-size: 14px;
  font-weight: 600;
}

.col-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.col-item {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 13px 14px;
}

.col-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.col-name {
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-raw {
  font-size: 11.5px;
  margin-bottom: 4px;
}

.col-metrics {
  display: flex;
  gap: 20px;
  margin: 10px 0 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

.metric {
  display: flex;
  flex-direction: column;
}

.m-val {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.m-label {
  font-size: 11px;
  color: var(--ink-500);
}

.col-points {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.point {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.p-date {
  width: 78px;
  color: var(--ink-500);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.p-bar {
  flex: 1;
  height: 5px;
  background: var(--ink-100);
  border-radius: 3px;
  overflow: hidden;
}

.p-fill {
  height: 100%;
  background: var(--brand-500);
  border-radius: 3px;
}

.p-ratio {
  width: 56px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.hint {
  margin: 16px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
</style>
