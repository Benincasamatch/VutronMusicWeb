/**
 * 浏览器版登录态：直接对接 /api/auth/*（会话 Cookie，credentials: 'include'）。
 * 未登录时 currentUser() 返回 null（后端 401 已被 apiFetch 识别为 UnauthorizedError 并在此处吞掉），
 * 其余调用会抛出 UnauthorizedError，调用方据此区分“未登录”和“有数据”。
 */
import { API } from '../../../web/shared/contract.ts'
import { apiFetch } from './http.ts'

export interface WebUser {
  id: string
  username: string
  role: string
  displayName: string
  mustChangePassword: boolean
  disabled: boolean
  canControl: boolean
  createdAt: number
}

export interface LoginResult {
  user: WebUser
  token: string
  expiresAt: number
}

function notifyAuthChanged(user: WebUser | null): void {
  try {
    window.dispatchEvent(new CustomEvent('vw:auth-changed', { detail: user }))
  } catch {
    /* 忽略 */
  }
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const result = await apiFetch<LoginResult>(API.auth.login, {
    method: 'POST',
    body: { username, password }
  })
  notifyAuthChanged(result.user)
  return result
}

export async function logout(): Promise<void> {
  await apiFetch(API.auth.logout, { method: 'POST' })
  notifyAuthChanged(null)
}

/** 未登录返回 null，不抛错 */
export async function currentUser(): Promise<WebUser | null> {
  const result = await apiFetch<{ user: WebUser } | null>(API.auth.me, { allowUnauthorized: true })
  notifyAuthChanged(result?.user ?? null)
  return result?.user ?? null
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiFetch(API.auth.password, { method: 'POST', body: { currentPassword, newPassword } })
}

export async function updateProfile(displayName: string): Promise<void> {
  await apiFetch(API.auth.profile, { method: 'PATCH', body: { displayName } })
}

export interface WebAuthApi {
  login: (username: string, password: string) => Promise<LoginResult>
  logout: () => Promise<void>
  currentUser: () => Promise<WebUser | null>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  updateProfile: (displayName: string) => Promise<void>
}

export const authApi: WebAuthApi = {
  login,
  logout,
  currentUser,
  changePassword,
  updateProfile
}

// 供渲染层/后续 UI 直接取用；不做 declare global，避免与 main.ts 的 window 声明冲突
const globals = window as unknown as { vwAuth?: WebAuthApi }
globals.vwAuth = authApi
