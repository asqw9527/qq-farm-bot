<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'

const toast = useToastStore()
const userStore = useUserStore()
const isAdmin = computed(() => userStore.isAdmin)

const loading = ref(false)
const users = ref<any[]>([])
const unboundAccounts = ref<any[]>([])
const cards = ref<any[]>([])

const me = ref<any>(null)

// 新建用户
const showCreate = ref(false)
const newUsername = ref('')
const newPassword = ref('')
const newCardCode = ref('')
const newAccountLimit = ref<number | null>(null)
const newDays = ref<number | null>(null)
const newPermanent = ref(false)

// 生成卡密
const cardCount = ref(10)
const cardType = ref<'time' | 'quota'>('time')
const cardDays = ref(30)
const cardValue = ref(1)
const cardDesc = ref('')
const generatedCodes = ref<string[]>([])

// 续费
const renewCode = ref('')

function fmtTime(ms?: number): string {
  if (!ms) return '永久/不限'
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString()
}

async function load() {
  loading.value = true
  try {
    const meRes = await api.get('/api/users/me')
    me.value = meRes.data?.user || null
    if (isAdmin.value) {
      const [usersRes, cardsRes] = await Promise.all([
        api.get('/api/admin/users-overview'),
        api.get('/api/admin/cards'),
      ])
      users.value = usersRes.data?.users || []
      unboundAccounts.value = usersRes.data?.unboundAccounts || []
      cards.value = cardsRes.data?.cards || []
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '加载用户信息失败'))
  }
  finally {
    loading.value = false
  }
}

onMounted(load)

async function createUser() {
  if (!newUsername.value || !newPassword.value) {
    toast.warning('请填写用户名和密码')
    return
  }
  try {
    const res = await api.post('/api/users', {
      username: newUsername.value,
      password: newPassword.value,
      cardCode: newCardCode.value,
    })
    if (!res.data?.ok) {
      toast.error(res.data?.error || '创建失败')
      return
    }
    // 可选：创建后立即设置上限/时长
    const name = newUsername.value
    if (newAccountLimit.value !== null || newDays.value !== null || newPermanent.value) {
      await api.post('/api/admin/users', {
        username: name,
        accountLimit: newAccountLimit.value,
        days: newPermanent.value ? 0 : newDays.value,
        permanent: newPermanent.value,
      })
    }
    toast.success('用户创建成功')
    showCreate.value = false
    newUsername.value = ''
    newPassword.value = ''
    newCardCode.value = ''
    newAccountLimit.value = null
    newDays.value = null
    newPermanent.value = false
    await load()
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '创建失败'))
  }
}

async function deleteUser(username: string) {
  if (!window.confirm(`确定删除用户「${username}」吗？`)) return
  try {
    const res = await api.post('/api/users/delete', { username })
    if (!res.data?.ok) {
      toast.error(res.data?.error || '删除失败')
      return
    }
    toast.success('已删除')
    await load()
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '删除失败'))
  }
}

async function saveUserLimits(u: any) {
  try {
    const payload: any = { username: u.username, accountLimit: u.accountLimit, permanent: u._permanent === true }
    if (u._days !== undefined && u._days !== '') payload.days = Number(u._days)
    else if (u._permanent) payload.days = 0
    const res = await api.post('/api/admin/users', payload)
    if (!res.data?.ok) {
      toast.error(res.data?.error || '保存失败')
      return
    }
    toast.success('已保存')
    await load()
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
}

async function generateCards() {
  try {
    const res = await api.post('/api/admin/cards', {
      action: 'generate',
      count: Number(cardCount.value) || 10,
      cardType: cardType.value,
      days: cardType.value === 'time' ? (Number(cardDays.value) || 30) : undefined,
      value: cardType.value === 'quota' ? (Number(cardValue.value) || 1) : undefined,
      description: cardDesc.value,
    })
    if (!res.data?.ok) {
      toast.error(res.data?.error || '生成失败')
      return
    }
    generatedCodes.value = res.data.codes || []
    toast.success(`已生成 ${generatedCodes.value.length} 张卡密`)
    await load()
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '生成失败'))
  }
}

async function toggleCard(card: any) {
  try {
    await api.post('/api/admin/cards', { action: 'toggle', codes: [card.code], enabled: !card.enabled })
    await load()
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '操作失败'))
  }
}

async function deleteCard(card: any) {
  try {
    await api.post('/api/admin/cards', { action: 'delete', codes: [card.code] })
    await load()
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '删除失败'))
  }
}

async function renew() {
  if (!renewCode.value) {
    toast.warning('请输入卡密')
    return
  }
  try {
    const res = await userStore.renew(renewCode.value)
    if (!res.ok) {
      toast.error(res.error || '续费失败')
      return
    }
    toast.success(res.message || '续费成功')
    renewCode.value = ''
    await load()
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '续费失败'))
  }
}

function copyText(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast.success('已复制')).catch(() => {})
}
</script>

<template>
  <div class="user-management p-4">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold">用户与卡密管理</h2>
        <p class="mt-1 text-sm opacity-60">管理登录账号、账号上限、卡密与账号归属</p>
      </div>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="load">刷新</BaseButton>
    </div>

    <!-- 当前用户（普通用户） -->
    <section v-if="!isAdmin" class="farm-card rounded-lg p-4 mb-4">
      <h3 class="text-base font-bold mb-3">我的账号</h3>
      <div class="info-grid">
        <div><span class="label">用户名</span><span class="value">{{ me?.username || userStore.username }}</span></div>
        <div><span class="label">角色</span><span class="value">{{ me?.role || userStore.role }}</span></div>
        <div><span class="label">账号上限</span><span class="value">{{ me?.accountLimit === -1 ? '无限' : (me?.accountLimit ?? '-') }}</span></div>
        <div><span class="label">到期时间</span><span class="value">{{ fmtTime(me?.expiresAt) }}</span></div>
        <div><span class="label">卡密</span><span class="value">{{ me?.cardCode || '-' }}</span></div>
      </div>
      <div class="mt-4 flex items-end gap-3 flex-wrap">
        <div class="min-w-60 flex-1">
          <BaseInput v-model="renewCode" label="续费卡密" placeholder="输入时间卡密或额度卡密" />
        </div>
        <BaseButton variant="primary" @click="renew">续费</BaseButton>
      </div>
    </section>

    <!-- 管理员视图 -->
    <template v-if="isAdmin">
      <!-- 用户列表 -->
      <section class="farm-card rounded-lg p-4 mb-4">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-base font-bold">用户列表（{{ users.length }}）</h3>
          <BaseButton variant="primary" size="sm" @click="showCreate = !showCreate">
            {{ showCreate ? '取消' : '新建用户' }}
          </BaseButton>
        </div>

        <div v-if="showCreate" class="create-panel p-3 mb-4 rounded-lg">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <BaseInput v-model="newUsername" label="用户名" placeholder="3-32位字母数字下划线" />
            <BaseInput v-model="newPassword" label="密码" type="password" placeholder="至少6位" />
            <BaseInput v-model="newCardCode" label="时间卡密" placeholder="注册所需卡密" />
            <BaseInput v-model.number="newAccountLimit" label="账号上限（可选）" type="number" placeholder="留空用默认2" />
            <BaseInput v-model.number="newDays" label="有效天数（可选）" type="number" placeholder="留空用卡密时长" />
            <label class="flex items-center gap-2 pt-6">
              <input v-model="newPermanent" type="checkbox" />
              <span class="text-sm">永久有效</span>
            </label>
          </div>
          <div class="mt-3 flex justify-end">
            <BaseButton variant="primary" size="sm" @click="createUser">确认创建</BaseButton>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="user-table w-full text-sm">
            <thead>
              <tr>
                <th class="text-left">用户名</th>
                <th>角色</th>
                <th>上限</th>
                <th>延长天数</th>
                <th>到期时间</th>
                <th>账号数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.username">
                <td class="text-left font-medium">{{ u.username }}</td>
                <td class="text-center">{{ u.role }}</td>
                <td class="text-center">
                  <input v-model.number="u.accountLimit" type="number" class="limit-input" :disabled="u.role === 'admin'" />
                </td>
                <td class="text-center">
                  <input v-if="u.role !== 'admin'" v-model="u._days" type="number" class="limit-input" placeholder="不改" />
                  <span v-else>-</span>
                </td>
                <td class="text-center">{{ fmtTime(u.expiresAt) }}</td>
                <td class="text-center">{{ u.accounts?.length || 0 }}</td>
                <td class="text-center">
                  <template v-if="u.role !== 'admin'">
                    <BaseButton variant="primary" size="sm" @click="saveUserLimits(u)">保存</BaseButton>
                    <BaseButton variant="danger" size="sm" @click="deleteUser(u.username)">删除</BaseButton>
                  </template>
                  <span v-else class="opacity-50">内置</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-xs opacity-50">账号上限设为 -1 表示无限；"延长天数"留空表示不修改到期时间。修改后点对应行"保存"。</p>
      </section>

      <!-- 卡密管理 -->
      <section class="farm-card rounded-lg p-4 mb-4">
        <h3 class="text-base font-bold mb-3">卡密管理</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-6 items-end">
          <div>
            <label class="text-xs opacity-60">类型</label>
            <select v-model="cardType" class="select-input">
              <option value="time">时间卡</option>
              <option value="quota">额度卡</option>
            </select>
          </div>
          <BaseInput v-model.number="cardCount" label="数量" type="number" placeholder="10" />
          <BaseInput v-if="cardType === 'time'" v-model.number="cardDays" label="天数" type="number" placeholder="30" />
          <BaseInput v-else v-model.number="cardValue" label="增加上限" type="number" placeholder="1" />
          <BaseInput v-model="cardDesc" label="备注" placeholder="可选" />
          <BaseButton variant="primary" @click="generateCards">生成卡密</BaseButton>
        </div>

        <div v-if="generatedCodes.length" class="generated-box p-3 mt-3 rounded-lg">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-bold">已生成 {{ generatedCodes.length }} 张</span>
            <BaseButton variant="secondary" size="sm" @click="copyText(generatedCodes.join('\n'))">全部复制</BaseButton>
          </div>
          <div class="codes-wrap">
            <span v-for="code in generatedCodes" :key="code" class="code-chip" @click="copyText(code)">{{ code }}</span>
          </div>
        </div>

        <div class="overflow-x-auto mt-4" style="max-height: 320px">
          <table class="user-table w-full text-sm">
            <thead>
              <tr>
                <th class="text-left">卡密</th>
                <th>类型</th>
                <th>天数/额度</th>
                <th>状态</th>
                <th>使用人</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in cards" :key="c.code">
                <td class="text-left font-mono text-xs">{{ c.code }}</td>
                <td class="text-center">{{ c.type === 'quota' ? '额度' : '时间' }}</td>
                <td class="text-center">{{ c.type === 'quota' ? `+${c.value}` : (c.isPermanent ? '永久' : `${c.days}天`) }}</td>
                <td class="text-center">
                  <span :class="c.usedBy ? 'tag-used' : (c.enabled ? 'tag-ok' : 'tag-off')">
                    {{ c.usedBy ? '已用' : (c.enabled ? '未用' : '禁用') }}
                  </span>
                </td>
                <td class="text-center">{{ c.usedBy || '-' }}</td>
                <td class="text-center">
                  <BaseButton variant="text" size="sm" @click="toggleCard(c)">{{ c.enabled ? '禁用' : '启用' }}</BaseButton>
                  <BaseButton variant="text" size="sm" @click="deleteCard(c)">删除</BaseButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 未绑定账号 -->
      <section v-if="unboundAccounts.length" class="farm-card rounded-lg p-4">
        <h3 class="text-base font-bold mb-3">未绑定账号（{{ unboundAccounts.length }}）</h3>
        <p class="text-sm opacity-60">旧数据未归属任何用户，管理员可见。普通用户添加账号后将自动绑定。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.user-management { max-width: 1100px; margin: 0 auto; }
.info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.info-grid > div { display: flex; flex-direction: column; gap: 4px; }
.info-grid .label { font-size: 12px; opacity: 0.6; }
.info-grid .value { font-weight: 600; }
.create-panel, .generated-box { background: var(--ui-primary-soft); }
.user-table th, .user-table td { padding: 8px 10px; border-bottom: 1px solid var(--ui-border, rgba(128,128,128,0.2)); }
.user-table th { font-weight: 600; opacity: 0.7; }
.limit-input, .select-input { width: 80px; padding: 4px 8px; border: 1px solid var(--ui-border, rgba(128,128,128,0.3)); border-radius: 6px; background: transparent; color: inherit; }
.select-input { width: 100%; }
.codes-wrap { display: flex; flex-wrap: wrap; gap: 6px; max-height: 160px; overflow: auto; }
.code-chip { padding: 3px 8px; border-radius: 5px; background: var(--ui-surface-strong, #fff); font-family: monospace; font-size: 12px; cursor: pointer; }
.tag-ok { color: #16a34a; }
.tag-off { color: #9ca3af; }
.tag-used { color: #f59e0b; }
.min-w-60 { min-width: 240px; }
</style>
