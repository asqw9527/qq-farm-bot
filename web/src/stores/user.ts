import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { sha256Hex } from '@/utils/crypto'

export type UserRole = 'admin' | 'user'

export interface AdminInfo {
  username: string
  role: UserRole
  avatar?: string
  mustChangePassword?: boolean
  accountLimit?: number
  expiresAt?: number
  isPermanent?: boolean
  cardCode?: string
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials' | 'expired'
  remainingMs?: number
  data?: {
    token: string
    role: UserRole
    user: { username: string; role?: UserRole }
    mustChangePassword?: boolean
  }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const userInfo = useStorage<AdminInfo | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')
  const role = computed<UserRole>(() => userInfo.value?.role || 'admin')
  const isAdmin = computed(() => role.value === 'admin' || role.value === 'super_admin')

  function applyUser(data: any) {
    if (!data) return
    userInfo.value = {
      username: data.username || '',
      role: data.role === 'user' ? 'user' : 'admin',
      avatar: data.avatar,
      mustChangePassword: data.mustChangePassword,
      accountLimit: data.accountLimit,
      expiresAt: data.expiresAt,
      isPermanent: data.isPermanent,
      cardCode: data.cardCode,
    }
  }

  async function login(loginName: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username: loginName, password: await sha256Hex(password) })
      if (res.data.ok) {
        token.value = res.data.data.token
        applyUser({
          ...(res.data.data.user || {}),
          role: res.data.data.role,
          mustChangePassword: res.data.data.mustChangePassword,
        })
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '网络错误'), errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function register(loginName: string, password: string, cardCode: string) {
    try {
      const res = await api.post('/api/users/register', { username: loginName, password: await sha256Hex(password), cardCode })
      return res.data
    }
    catch (error: any) {
      return error.response?.data || { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function claimCard(loginName?: string) {
    try {
      const res = await api.post('/api/users/claim-card', {
        username: loginName,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'web',
      })
      return res.data
    }
    catch (error: any) {
      return error.response?.data || { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function fetchCardClaimStatus() {
    try {
      const res = await api.get('/api/users/card-claim-status')
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function renew(cardCode: string) {
    try {
      const res = await api.post('/api/users/renew', { cardCode })
      return res.data
    }
    catch (error: any) {
      return error.response?.data || { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
      userInfo.value = null
    }
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok && res.data.data)
        applyUser(res.data.data)
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword: await sha256Hex(oldPassword), newPassword: await sha256Hex(newPassword) })
    return res.data
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    username,
    avatar,
    role,
    isAdmin,
    login,
    register,
    claimCard,
    fetchCardClaimStatus,
    renew,
    logout,
    fetchUserInfo,
    changePassword,
    applyUser,
  }
})
