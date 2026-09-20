<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * ASIN 查询栏
 *
 * 所有业务页面共用。支持：
 *   - 从 URL query 带入初始值（页面间跳转时直接出结果）
 *   - 回车提交
 *   - 校验 10 位格式，不合规就地提示，不发起请求
 */
const props = defineProps<{
  /** 初始 ASIN，通常来自路由 query */
  initial?: string
  loading?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{ (e: 'search', asin: string): void }>()

const asin = ref(props.initial ?? '')

// 路由 query 变化时同步（比如从其他页面带 ASIN 跳进来）
watch(
  () => props.initial,
  (v) => {
    if (v && v !== asin.value) asin.value = v
  },
)

const ASIN_RE = /^[A-Z0-9]{10}$/
const error = ref('')

function submit() {
  const v = asin.value.trim().toUpperCase()
  asin.value = v

  if (!v) {
    error.value = '请输入 ASIN'
    return
  }
  // 与后端 DTO 的校验规则一致，避免前后端提示不一样
  if (!ASIN_RE.test(v)) {
    error.value = 'ASIN 应为 10 位大写字母或数字'
    return
  }
  error.value = ''
  emit('search', v)
}
</script>

<template>
  <div class="search-bar">
    <el-input
      v-model="asin"
      :placeholder="placeholder ?? '粘贴 ASIN，例如 B0SEEDSS01'"
      size="large"
      clearable
      :disabled="loading"
      @keyup.enter="submit"
      @input="error = ''"
    >
      <template #prepend>ASIN</template>
      <template #append>
        <el-button type="primary" :loading="loading" @click="submit">查询</el-button>
      </template>
    </el-input>
    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
.search-bar {
  margin-bottom: 16px;
}

.err {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger);
}
</style>
