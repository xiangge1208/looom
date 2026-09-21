<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * 关键词查询栏（M13 选词族四个页面共用）
 *
 * 与 AsinSearchBar 的区别不只是提示文案：
 *   - 关键词是**自由文本**，没有 ASIN 那样的 10 位格式可校验，
 *     只能校验长度上限（与后端 DTO 的 128 字符一致）
 *   - 需要**小写归一** —— ETL 侧统一 btrim(lower())，
 *     不归一的话用户输入大写会查不到
 *   - 允许**留空**（部分页面留空返回榜单），所以空值不报错而是照样提交，
 *     由各页面决定空查询的语义。`/compete` 是唯一必填的，
 *     它会在响应的 dataScope 里提示用户输入词
 */
const props = defineProps<{
  initial?: string
  loading?: boolean
  placeholder?: string
  /** 留空是否允许提交。false 时空值会就地报错（用于 /compete 这种必填页） */
  allowEmpty?: boolean
}>()

const emit = defineEmits<{ (e: 'search', keyword: string): void }>()

const keyword = ref(props.initial ?? '')

watch(
  () => props.initial,
  (v) => {
    if (v !== undefined && v !== keyword.value) keyword.value = v
  },
)

const MAX_LEN = 128
const error = ref('')

function submit() {
  // 归一规则必须与后端 DTO 的 @Transform 一致：trim + toLowerCase
  const v = keyword.value.trim().toLowerCase()
  keyword.value = v

  if (!v && props.allowEmpty === false) {
    error.value = '请输入关键词'
    return
  }
  if (v.length > MAX_LEN) {
    error.value = `关键词最长 ${MAX_LEN} 字符`
    return
  }
  error.value = ''
  emit('search', v)
}
</script>

<template>
  <div class="search-bar">
    <el-input
      v-model="keyword"
      :placeholder="placeholder ?? '输入关键词，例如 yoga mat'"
      size="large"
      clearable
      :disabled="loading"
      @keyup.enter="submit"
      @input="error = ''"
    >
      <template #prepend>关键词</template>
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
