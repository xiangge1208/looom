<script setup lang="ts">
/**
 * 维护页
 *
 * 对应原站行为：后端返回 500 / 502 / 503 时跳转此页。
 * goal.md 的页面清单没列，但错误处理需要，故补上。
 */
</script>

<template>
  <div class="err-page">
    <div class="err-icon">⚙</div>
    <h1 class="err-title">系统维护中</h1>
    <p class="err-desc">服务暂时不可用，请稍后重试。</p>
    <el-button type="primary" @click="$router.replace({ name: 'dashboard' })">
      重新加载
    </el-button>
  </div>
</template>

<style scoped>
.err-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
}

.err-icon {
  font-size: 48px;
  color: var(--warn);
  line-height: 1;
}

.err-title {
  margin: 8px 0 0;
  font-size: 18px;
  font-weight: 600;
}

.err-desc {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ink-500);
}
</style>
