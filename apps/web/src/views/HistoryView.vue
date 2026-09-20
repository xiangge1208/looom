<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { usersApi, type QueryLogItem } from '@/api/user'

/**
 * 我的查询历史（goal.md P3）
 *
 * 后端接口在 P2 就做好了（/users/me/query-logs，设置页也在用），
 * 这里补独立页面：支持按类型筛选、游标翻页、点击跳回对应查询页。
 *
 * 埋点已在 P3 接入：sales / traffic / keywords / diagnosis / suppliers
 * 五个入口页的主查询会记录，次级接口（trend / variants / groups）不记 ——
 * 否则打开一个页面会产生 2-3 条重复历史，列表没法看。
 */
const router = useRouter()

const rows = ref<QueryLogItem[]>([])
const loading = ref(false)
const cursor = ref<string | null>(null)
const hasMore = ref(false)
const queryType = ref('')

const TYPE_OPTIONS = [
  { label: '全部', value: '' },
  { label: 'ASIN 查询', value: 'asin' },
  { label: '关键词查询', value: 'keyword' },
  { label: '供应商查询', value: 'supplier' },
]

async function load(reset = true) {
  loading.value = true
  try {
    const res = await usersApi.queryLogs({
      cursor: reset ? undefined : (cursor.value ?? undefined),
      limit: 20,
      queryType: queryType.value || undefined,
    })
    rows.value = reset ? res.items : [...rows.value, ...res.items]
    cursor.value = res.nextCursor
    hasMore.value = res.hasMore
  } catch {
    // 拦截器已提示
  } finally {
    loading.value = false
  }
}

/**
 * 点历史记录跳回对应页面。目标路径优先用记录里的 pageRoute，没有再按类型推。
 *
 * ⚠️ 只有 asin 类型才带 query 参数。
 * 之前无论什么类型都把 queryValue 塞进 `asin`：
 *   - keyword 记录的值是关键词文本，会被后端 ASIN 正则挡下（400）；
 *   - supplier 页面根本不读 query，参数是噪音。
 */
function jump(row: QueryLogItem) {
  const fallback =
    row.queryType === 'asin' ? '/sales' : row.queryType === 'keyword' ? '/keywords' : '/suppliers'
  const target = row.pageRoute || fallback

  if (row.queryType === 'asin') {
    void router.push({ path: target, query: { asin: row.queryValue, country: row.country } })
    return
  }
  void router.push({ path: target })
}

onMounted(() => void load(true))
</script>

<template>
  <div class="page">
    <h1 class="page-title">我的查询历史</h1>
    <p class="page-desc">查看历史查询记录，点击可重新查询</p>

    <div class="card">
      <div class="bar">
        <el-radio-group v-model="queryType" size="small" @change="load(true)">
          <el-radio-button v-for="o in TYPE_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <el-table :data="rows" v-loading="loading" stripe empty-text="暂无查询记录">
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="info">{{ row.queryType }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="查询内容" min-width="170">
          <template #default="{ row }">
            <span class="mono">{{ row.queryValue }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="country" label="站点" width="76" />
        <el-table-column label="消耗积分" width="96" align="right">
          <template #default="{ row }">{{ row.creditsCost || '免费' }}</template>
        </el-table-column>
        <el-table-column label="结果数" width="88" align="right">
          <template #default="{ row }">{{ row.resultCount ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="88" align="right">
          <template #default="{ row }">
            {{ row.durationMs === null ? '—' : `${row.durationMs}ms` }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.success ? 'success' : 'danger'" size="small" effect="plain">
              {{ row.success ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="时间" width="168" />
        <el-table-column label="" width="72">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="jump(row)">重查</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="hasMore" class="more">
        <el-button :loading="loading" @click="load(false)">加载更多</el-button>
      </div>

      <el-alert
        v-if="!loading && !rows.length"
        type="info"
        :closable="false"
        class="mt"
        title="暂无记录"
        description="去查销量、流量结构、流量词、综合诊断或供应商页面做一次查询，记录会出现在这里。"
      />
    </div>
  </div>
</template>

<style scoped>
.bar {
  margin-bottom: 12px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.more {
  margin-top: 14px;
  text-align: center;
}

.mt {
  margin-top: 14px;
}
</style>
