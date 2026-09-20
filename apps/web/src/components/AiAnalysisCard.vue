<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import { analyzeStream } from '@/api/ai'
import { useCreditsStore } from '@/stores/credits'

/**
 * AI 分析卡片（统一组件）
 *
 * goal.md 要求四个状态：
 *   未触发 → 显示「AI 分析」按钮
 *   进行中 → 流式打字效果 + 取消按钮
 *   已完成 → Markdown 渲染的结论 + 重新分析按钮
 *   失败   → 错误提示 + 重试
 *
 * 各页面只需传 insertPoint 和 input，不要自己写 SSE 逻辑。
 */
const props = defineProps<{
  /** AI 插入点标识，需与后端 prompts 注册表一致 */
  insertPoint: string
  /** 送给模型的业务数据 */
  input: Record<string, any>
  title?: string
  /** 输入未就绪时禁用按钮（比如还没输 ASIN） */
  disabled?: boolean
}>()

type State = 'idle' | 'running' | 'done' | 'error'

const state = ref<State>('idle')
const content = ref('')
const errorMsg = ref('')
const fromCache = ref(false)
let cancelFn: (() => void) | null = null

const credits = useCreditsStore()

/**
 * 按钮上的积分提示。
 *
 * 计价表没加载好时返回空串而不是「免费」——
 * 把「不知道价格」显示成「免费」会误导用户。
 * 所有 AI 插入点共用 ai_analysis 这一档计价。
 */
const costHint = computed(() => {
  const c = credits.costOf('ai_analysis')
  if (c === null) return ''
  return c === 0 ? '（免费）' : `（${c} 积分）`
})

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const rendered = computed(() => md.render(content.value || ''))

function start() {
  state.value = 'running'
  content.value = ''
  errorMsg.value = ''
  fromCache.value = false

  cancelFn = analyzeStream(props.insertPoint, props.input, {
    onDelta: (chunk) => {
      content.value += chunk
    },
    onBalance: (balance) => {

      // 余额由 SSE 直接带回，不用再发一次查询

      credits.setBalance(balance)

    },

    onCached: (full) => {
      content.value = full
    fromCache.value = true
    },
    onDone: () => {
      // 取消后也会走到 done，避免把已取消的状态改成完成
      if (state.value === 'running') state.value = 'done'
      cancelFn = null
    },
    onError: (msg) => {
      errorMsg.value = msg
      state.value = 'error'
      cancelFn = null
    },
  })
}

function cancel() {
  cancelFn?.()
  cancelFn = null
  state.value = content.value ? 'done' : 'idle'
}

// 组件卸载时中断请求，避免后端继续烧 token
onUnmounted(() => cancelFn?.())
</script>

<template>
  <section class="ai-card">
    <header class="ai-head">
      <div class="ai-title">
        <span class="ai-badge">AI</span>
   <span>{{ title ?? '智能分析' }}</span>
        <el-tag v-if="fromCache" size="small" type="info" effect="plain">缓存结果</el-tag>
      </div>

      <div class="ai-actions">
        <el-button
          v-if="state === 'idle'"
          type="primary"
          size="small"
          :disabled="disabled"
          @click="start"
        >
          开始分析{{ costHint }}
        </el-button>

        <el-button v-else-if="state === 'running'" size="small" @click="cancel">
          取消
        </el-button>

        <!--
          done / error 态同样要受 disabled 约束：
          否则用户跑完一次后清空输入（比如供应商页取消勾选），
          再点「重新分析」会以空数据发起请求并真实扣费。
        -->
        <el-button
          v-else-if="state === 'done'"
          size="small"
          :disabled="disabled"
          @click="start"
        >
          重新分析{{ costHint }}
        </el-button>

        <el-button v-else type="primary" size="small" :disabled="disabled" @click="start">
          重试
        </el-button>
      </div>
    </header>

    <!-- 未触发 -->
    <div v-if="state === 'idle'" class="ai-empty">
      <p v-if="disabled" class="muted">请先输入查询条件，再进行 AI 分析。</p>
      <p v-else class="muted">点击「开始分析」，AI 会基于当前页面数据给出解读与建议。</p>
    </div>

    <!-- 进行中 / 已完成 -->
    <div
      v-else-if="state === 'running' || state === 'done'"
      class="markdown-body"
      :class="{ 'typing-cursor': state === 'running' }"
      v-html="rendered"
    />

    <!-- 失败 -->
    <el-alert v-else type="error" :closable="false" show-icon>
      <template #title>分析失败</template>
      {{ errorMsg }}
    </el-alert>
  </section>
</template>

<style scoped>
.ai-card {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 16px;
}

.ai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.ai-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.ai-badge {
  display: inline-grid;
  place-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  background: linear-gradient(135deg, var(--brand-500), #7c3aed);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.ai-empty {
  padding: 8px 0 4px;
  font-size: 13px;
}

.ai-empty p {
  margin: 0;
}
</style>
