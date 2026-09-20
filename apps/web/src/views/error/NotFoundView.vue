<script setup lang="ts">
// 404 页。原站有 /404 路由，我们也补上
</script>

<template>
  <div class="err-page">
    <div class="err-code">404</div>
    <h1 class="err-title">页面不存在</h1>
    <p class="err-desc">你访问的地址可能已失效或输入有误。</p>
    <RouterLink :to="{ name: 'dashboard' }">
      <el-button type="primary">返回概览</el-button>
    </RouterLink>
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

.err-code {
  font-size: 64px;
  font-weight: 700;
  color: var(--brand-500);
  letter-spacing: -0.04em;
  line-height: 1;
}

.err-title {
  margin: 4px 0 0;
  font-size: 18px;
  font-weight: 600;
}

.err-desc {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ink-500);
}
</style>
