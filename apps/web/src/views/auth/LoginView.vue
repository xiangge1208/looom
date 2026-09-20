<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const formRef = ref<FormInstance>()
const form = reactive({ email: '', password: '' })

// 前端校验规则与后端 DTO 保持一致（goal.md 要求前后端双重校验）
const rules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度需为 6~20 位', trigger: 'blur' },
  ],
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return

  try {
    await auth.login(form.email, form.password)
    ElMessage.success('登录成功')
    // 登录后跳回原本要访问的页面
    const redirect = route.query.redirect as string | undefined
    router.push(redirect || { name: 'dashboard' })
  } catch {
    // 错误提示由 http 拦截器统一弹出，这里不重复
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="brand">
 <span class="brand-mark">L</span>
        <span class="brand-name">Looom</span>
      </div>
      <h1 class="auth-title">登录</h1>
      <p class="auth-desc">亚马逊 Listing 与广告流量分析工具</p>

      <el-form
        ref="formRef"
        :model="form"
 :rules="rules"
        label-position="top"
        size="large"
        @submit.prevent="submit"
      >
 <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" placeholder="you@example.com" autocomplete="username" />
        </el-form-item>

        <el-form-item label="密码" prop="password">
   <el-input
     v-model="form.password"
     type="password"
     placeholder="请输入密码"
     show-password
     autocomplete="current-password"
     @keyup.enter="submit"
   />
 </el-form-item>

 <el-button type="primary" size="large" class="submit" :loading="auth.loading" @click="submit">
   登录
        </el-button>
      </el-form>

      <p class="foot">
 还没有账号？
        <RouterLink :to="{ name: 'register' }">立即注册</RouterLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
  /* 克制的渐变背景，不抄原站配色 */
  background: linear-gradient(160deg, #f8fafc 0%, #eef2ff 100%);
}

.auth-card {
  width: 100%;
  max-width: 380px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 32px 28px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 22px;
}

.brand-mark {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--brand-500);
  color: #fff;
  font-weight: 700;
  display: grid;
  place-items: center;
}

.brand-name {
  font-weight: 600;
}

.auth-title {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.auth-desc {
  margin: 0 0 22px;
  font-size: 13px;
  color: var(--ink-500);
}

.submit {
  width: 100%;
  margin-top: 4px;
}

.foot {
  margin: 18px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--ink-500);
}
</style>
