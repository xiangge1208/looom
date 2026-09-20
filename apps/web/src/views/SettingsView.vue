<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  creditsApi,
  usersApi,
  type ApiKeyItem,
  type CreditTx,
  type UserProfile,
} from '@/api/user'
import { setDefaultCountry } from '@/api/business'
import { useCreditsStore } from '@/stores/credits'

/**
 * 账户设置
 *
 * goal.md 第 16 页要求三块：账户设置、积分管理、API Key 管理。
 * 这里用 Tab 分开，避免一页太长。
 *
 * 充值入口**故意不做**：goal.md 明确「不要引入需要我付费的第三方服务」，
 * 接支付网关超出范围。测试额度由 seed 灌，页面上说明清楚即可。
 */
const credits = useCreditsStore()

const tab = ref('profile')

// ---- 资料 ----
const profile = ref<UserProfile | null>(null)
const savingProfile = ref(false)
const form = ref({ nickname: '', avatarUrl: '', defaultCountry: 'US' })

const COUNTRIES = [
  'US', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP',
  'CA', 'MX', 'AU', 'AE', 'SA', 'BR',
]

async function loadProfile() {
  profile.value = await usersApi.profile()
  form.value = {
    nickname: profile.value.nickname,
    avatarUrl: profile.value.avatarUrl ?? '',
    defaultCountry: profile.value.defaultCountry,
  }
}

async function saveProfile() {
  savingProfile.value = true
  try {
    profile.value = await usersApi.updateProfile({
      nickname: form.value.nickname,
      avatarUrl: form.value.avatarUrl,
      defaultCountry: form.value.defaultCountry,
    })
    // 立刻生效，不用刷新页面：api 层的默认 country 同步更新
    setDefaultCountry(profile.value.defaultCountry)
    ElMessage.success('资料已保存')
  } finally {
    savingProfile.value = false
  }
}

// ---- 改密码 ----
const pwForm = ref({ oldPassword: '', newPassword: '', confirm: '' })
const changingPw = ref(false)

const pwError = computed(() => {
  if (!pwForm.value.newPassword) return ''
  if (pwForm.value.newPassword.length < 8) return '新密码至少 8 位'
  if (pwForm.value.confirm && pwForm.value.newPassword !== pwForm.value.confirm) {
    return '两次输入的新密码不一致'
  }
  return ''
})

const canChangePw = computed(
  () =>
    !!pwForm.value.oldPassword &&
    pwForm.value.newPassword.length >= 8 &&
    pwForm.value.newPassword === pwForm.value.confirm,
)

async function changePassword() {
  changingPw.value = true
  try {
    const res = await usersApi.changePassword({
      oldPassword: pwForm.value.oldPassword,
      newPassword: pwForm.value.newPassword,
    })
    ElMessage.success(res.message)
    pwForm.value = { oldPassword: '', newPassword: '', confirm: '' }
  } finally {
    changingPw.value = false
  }
}

// ---- 积分 ----
const txs = ref<CreditTx[]>([])
const txCursor = ref<string | null>(null)
const txHasMore = ref(false)
const loadingTx = ref(false)

async function loadTxs(reset = false) {
  loadingTx.value = true
  try {
    const res = await creditsApi.transactions({
      cursor: reset ? undefined : (txCursor.value ?? undefined),
      limit: 20,
    })
    txs.value = reset ? res.items : [...txs.value, ...res.items]
    txCursor.value = res.nextCursor
    txHasMore.value = res.hasMore
  } finally {
    loadingTx.value = false
  }
}

const TX_LABEL: Record<string, { text: string; type: string }> = {
  recharge: { text: '充值', type: 'success' },
  consume: { text: '消耗', type: 'warning' },
  refund: { text: '退还', type: 'info' },
  gift: { text: '赠送', type: 'success' },
  expire: { text: '过期', type: 'danger' },
}

/**
 * 并发超扣的回滚补偿，展示上要与正常退款区分开 ——
 * 否则用户看到一条「退还」会以为自己的分析失败了。
 */
function txLabel(t: CreditTx) {
  if (t.bizType === 'concurrent_rollback') {
    return { text: '并发回滚', type: 'info' }
  }
  return TX_LABEL[t.type] ?? { text: t.type, type: 'info' }
}

// ---- API Key ----
const keys = ref<ApiKeyItem[]>([])
const loadingKeys = ref(false)
const creatingKey = ref(false)
const newKeyName = ref('')
const newKeyExpires = ref<number | undefined>(undefined)

async function loadKeys() {
  loadingKeys.value = true
  try {
    keys.value = (await usersApi.apiKeys()).items
  } finally {
    loadingKeys.value = false
  }
}

async function createKey() {
  if (!newKeyName.value.trim()) {
    ElMessage.warning('请输入 Key 名称')
    return
  }
  creatingKey.value = true
  try {
    const created = await usersApi.createApiKey({
      name: newKeyName.value.trim(),
      expiresInDays: newKeyExpires.value,
    })
    newKeyName.value = ''
    newKeyExpires.value = undefined
    await loadKeys()

    // 明文只返回一次，必须让用户当场复制
    await ElMessageBox.alert(
      `<p style="margin:0 0 8px">请立即复制保存，关闭后无法再次查看：</p>` +
        `<code style="display:block;padding:10px;background:#f5f7fa;border-radius:6px;` +
        `word-break:break-all;font-size:12.5px">${created.key}</code>`,
      'API Key 已创建',
      { dangerouslyUseHTMLString: true, confirmButtonText: '我已保存' },
    )
  } finally {
    creatingKey.value = false
  }
}

async function revokeKey(k: ApiKeyItem) {
  await ElMessageBox.confirm(
    `吊销后使用该 Key 的调用将立即失败，且无法恢复。确定吊销「${k.name}」？`,
    '确认吊销',
    { type: 'warning', confirmButtonText: '吊销', cancelButtonText: '取消' },
  )
  const res = await usersApi.revokeApiKey(k.id)
  ElMessage.success(res.message)
  await loadKeys()
}

const KEY_STATUS: Record<string, { text: string; type: string }> = {
  active: { text: '有效', type: 'success' },
  expired: { text: '已过期', type: 'warning' },
  revoked: { text: '已吊销', type: 'danger' },
}

onMounted(async () => {
  await Promise.all([
    loadProfile(),
    credits.refresh(),
    credits.loadPricing(),
    loadTxs(true),
    loadKeys(),
  ])
})
</script>

<template>
  <div class="page">
    <h1 class="page-title">账户设置</h1>
    <p class="page-desc">管理个人资料、登录密码、积分与 API Key</p>

    <el-tabs v-model="tab" class="card">
      <!-- ---- 个人资料 ---- -->
      <el-tab-pane label="个人资料" name="profile">
        <div v-if="profile" class="pane">
   <div class="meta-row">
            <span class="meta-label">邮箱</span>
     <span class="mono">{{ profile.email }}</span>
     <el-tag size="small" effect="plain" type="info">登录凭据，不可修改</el-tag>
          </div>
   <div class="meta-row">
     <span class="meta-label">注册时间</span>
     <span>{{ profile.createdAt }}</span>
   </div>
          <div class="meta-row">
     <span class="meta-label">最后登录</span>
     <span>{{ profile.lastLoginAt ?? '—' }}</span>
          </div>

   <el-divider />

   <el-form label-width="96px" class="form">
            <el-form-item label="昵称">
<el-input v-model="form.nickname" maxlength="32" show-word-limit />
     </el-form-item>
     <el-form-item label="头像地址">
       <el-input v-model="form.avatarUrl" placeholder="http(s) 链接，留空用默认占位图" />
     </el-form-item>
     <el-form-item label="默认站点">
<el-select v-model="form.defaultCountry" style="width: 140px">
  <el-option v-for="c in COUNTRIES" :key="c" :label="c" :value="c" />
</el-select>
<span class="hint">查询页未指定站点时用这个</span>
     </el-form-item>
            <el-form-item>
       <el-button type="primary" :loading="savingProfile" @click="saveProfile">
         保存资料
       </el-button>
     </el-form-item>
   </el-form>
 </div>
      </el-tab-pane>

      <!-- ---- 修改密码 ---- -->
      <el-tab-pane label="修改密码" name="password">
 <div class="pane">
          <el-form label-width="96px" class="form">
     <el-form-item label="当前密码">
       <el-input v-model="pwForm.oldPassword" type="password" show-password />
     </el-form-item>
     <el-form-item label="新密码">
       <el-input v-model="pwForm.newPassword" type="password" show-password />
     </el-form-item>
     <el-form-item label="确认新密码">
<el-input
         v-model="pwForm.confirm"
  type="password"
  show-password
         @keyup.enter="canChangePw && changePassword()"
       />
     </el-form-item>
     <el-form-item v-if="pwError">
       <span class="err">{{ pwError }}</span>
     </el-form-item>
     <el-form-item>
<el-button
  type="primary"
         :disabled="!canChangePw"
  :loading="changingPw"
  @click="changePassword"
       >
         修改密码
       </el-button>
     </el-form-item>
   </el-form>
   <el-alert
     type="info"
     :closable="false"
     title="修改密码后，其他设备上的登录会话会被吊销，需要重新登录。"
   />
        </div>
      </el-tab-pane>

      <!-- ---- 积分管理 ---- -->
      <el-tab-pane label="积分管理" name="credits">
        <div class="pane">
   <div class="credit-cards">
     <div class="credit-card primary">
       <div class="cc-label">当前余额</div>
       <div class="cc-value">{{ credits.account?.balance ?? '—' }}</div>
     </div>
     <div class="credit-card">
       <div class="cc-label">累计获得</div>
       <div class="cc-value">{{ credits.account?.totalRecharged ?? '—' }}</div>
            </div>
     <div class="credit-card">
       <div class="cc-label">累计消耗</div>
<div class="cc-value">{{ credits.account?.totalConsumed ?? '—' }}</div>
     </div>
   </div>

          <h3 class="sec-title">功能计价</h3>
   <div class="pricing">
     <div v-for="(cost, biz) in credits.pricing" :key="biz" class="price-item">
       <span>{{ biz }}</span>
       <strong>{{ cost === 0 ? '免费' : `${cost} 积分` }}</strong>
     </div>
   </div>

   <el-alert
     type="info"
     :closable="false"
            class="mt"
     title="本项目不接入支付。测试额度由 seed 数据预置，用完可联系管理员或重新灌 seed。"
          />

   <h3 class="sec-title">积分流水</h3>
          <el-table :data="txs" stripe v-loading="loadingTx" empty-text="暂无流水">
     <el-table-column label="类型" width="104">
       <template #default="{ row }">
         <el-tag :type="txLabel(row).type as any" size="small" effect="plain">
    {{ txLabel(row).text }}
  </el-tag>
       </template>
     </el-table-column>
     <el-table-column label="变动" width="96">
       <template #default="{ row }">
         <span :class="row.amount >= 0 ? 'plus' : 'minus'">
           {{ row.amount >= 0 ? '+' : '' }}{{ row.amount }}
  </span>
       </template>
     </el-table-column>
     <el-table-column prop="remark" label="说明" min-width="180" show-overflow-tooltip />
     <el-table-column prop="createdAt" label="时间" width="168" />
   </el-table>
   <div v-if="txHasMore" class="more">
     <el-button :loading="loadingTx" @click="loadTxs()">加载更多</el-button>
          </div>
 </div>
      </el-tab-pane>

      <!-- ---- API Key ---- -->
      <el-tab-pane label="API Key" name="keys">
        <div class="pane">
          <div class="key-create">
     <el-input
       v-model="newKeyName"
       placeholder="Key 名称，如「本地脚本」"
       maxlength="32"
       style="max-width: 240px"
     />
     <el-select
       v-model="newKeyExpires"
       placeholder="有效期"
       clearable
       style="width: 148px"
     >
       <el-option label="30 天" :value="30" />
       <el-option label="90 天" :value="90" />
<el-option label="365 天" :value="365" />
       <el-option label="永不过期" :value="undefined" />
     </el-select>
     <el-button type="primary" :loading="creatingKey" @click="createKey">
       创建 Key
     </el-button>
   </div>

   <el-alert
     type="warning"
            :closable="false"
     class="mt"
     title="明文 Key 只在创建成功时显示一次，请立即保存。系统只存哈希，无法帮你找回。"
   />

   <el-table :data="keys" stripe v-loading="loadingKeys" empty-text="还没有 API Key" class="mt">
     <el-table-column prop="name" label="名称" min-width="130" show-overflow-tooltip />
     <el-table-column label="前缀" width="150">
       <template #default="{ row }">
  <span class="mono">{{ row.keyPrefix }}…</span>
       </template>
            </el-table-column>
     <el-table-column label="状态" width="96">
       <template #default="{ row }">
         <el-tag
           :type="(KEY_STATUS[row.status]?.type ?? 'info') as any"
           size="small"
    effect="plain"
         >
    {{ KEY_STATUS[row.status]?.text ?? row.status }}
         </el-tag>
       </template>
     </el-table-column>
     <el-table-column label="过期时间" width="168">
       <template #default="{ row }">
         {{ row.expiresAt ?? '永不过期' }}
       </template>
     </el-table-column>
     <el-table-column label="最后使用" width="168">
       <template #default="{ row }">{{ row.lastUsedAt ?? '未使用' }}</template>
     </el-table-column>
     <el-table-column label="" width="84">
       <template #default="{ row }">
         <el-button
    v-if="row.status === 'active'"
    link
           type="danger"
           size="small"
           @click="revokeKey(row)"
         >
           吊销
         </el-button>
       </template>
     </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.pane {
  padding: 4px 0 8px;
}

.form {
  max-width: 480px;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
  font-size: 13.5px;
}

.meta-label {
  width: 72px;
  color: var(--ink-500);
  flex-shrink: 0;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--ink-500);
}

.err {
  font-size: 12.5px;
  color: var(--danger, #f56c6c);
}

.credit-cards {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.credit-card {
  flex: 1;
  min-width: 132px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}

.credit-card.primary {
  background: var(--brand-50);
  border-color: var(--brand-100, var(--line));
}

.cc-label {
  font-size: 12px;
  color: var(--ink-500);
  margin-bottom: 6px;
}

.cc-value {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.sec-title {
  margin: 22px 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.pricing {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.price-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 12.5px;
}

.mt {
  margin-top: 14px;
}

.key-create {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.plus {
  color: var(--ok, #1ab364);
  font-weight: 600;
}

.minus {
  color: var(--ink-700);
  font-weight: 600;
}

.more {
  margin-top: 14px;
  text-align: center;
}
</style>
