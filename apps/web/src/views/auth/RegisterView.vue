<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const formRef = ref<FormInstance>()
const form = reactive({ email: '', password: '', confirm: '', nickname: '' })

/**
 * 校验规则与后端 RegisterDto 完全一致。
 * 密码正则沿用原站规则：6~20 位、必须同时含字母和数字、只允许字母数字。
 */
const rules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
  ],
  nickname: [
    { required: true, message: '请输入昵称', trigger: 'blur' },
    { min: 1, max: 32, message: '昵称长度需为 1~32 位', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    {
      pattern: /^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{6,20}$/,
      message: '6~20 位，需同时包含字母和数字',
      trigger: 'blur',
    },
  ],
  confirm: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_r, value, cb) => {
 if (value !== form.password) cb(new Error('两次输入的密码不一致'))
   else cb()
      },
      trigger: 'blur',
    },
  ],
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return

  try {
    await auth.register(form.email, form.password, form.nickname)
    ElMessage.success('注册成功')
    router.push({ name: 'dashboard' })
  } catch {
    // 错误提示由 http 拦截器统一处理
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
      <h1 class="auth-title">注册</h1>
      <p class="auth-desc">创建账号，开始分析亚马逊流量数据</p>

      <el-form
        ref="formRef"
 :model="form"
        :rules="rules"
        label-position="top"
        size="large"
        @submit.prevent="submit"
      >
 <el-form-item label="邮箱" prop="email">
   <el-input v-model="form.email" placeholder="you@example.com" />
        </el-form-item>

        <el-form-item label="昵称" prop="nickname">
   <el-input v-model="form.nickname" placeholder="怎么称呼你" />
        </el-form-item>

        <el-form-item label="密码" prop="password">
   <el-input
     v-model="form.password"
     type="password"
     placeholder="6~20 位，含字母和数字"
     show-password
   />
 </el-form-item>

 <el-form-item label="确认密码" prop="confirm">
   <el-input
     v-model="form.confirm"
     type="password"
     placeholder="再次输入密码"
     show-password
     @keyup.enter="submit"
   />
 </el-form-item>

 <el-button type="primary" size="large" class="submit" :loading="auth.loading" @click="submit">
   注册
 </el-button>
      </el-form>

      <p class="foot">
 已有账号？
 <RouterLink :to="{ name: 'login' }">去登录</RouterLink>
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
