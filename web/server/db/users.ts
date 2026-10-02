/**
 * 用户与会话数据访问。
 */
import crypto from 'node:crypto'
import { getDb } from './index.ts'

export type UserRole = 'admin' | 'user'

export interface UserRow {
  id: string
  username: string
  password_hash: string
  role: UserRole
  display_name: string | null
  must_change_password: number
  disabled: number
  can_control: number
  created_at: number
  updated_at: number
}

export interface PublicUser {
  id: string
  username: string
  role: UserRole
  displayName: string
  mustChangePassword: boolean
  disabled: boolean
  canControl: boolean
  createdAt: number
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name || row.username,
    mustChangePassword: row.must_change_password === 1,
    disabled: row.disabled === 1,
    canControl: row.can_control === 1 || row.role === 'admin',
    createdAt: row.created_at
  }
}

export function countUsers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return row.n
}

export function findUserByUsername(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | UserRow
    | undefined
}

export function findUserById(id: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
}

export function listUsers(): UserRow[] {
  return getDb()
    .prepare('SELECT * FROM users ORDER BY created_at ASC')
    .all() as unknown as UserRow[]
}

export function insertUser(input: {
  username: string
  passwordHash: string
  role: UserRole
  displayName?: string | null
  mustChangePassword?: boolean
  canControl?: boolean
}): UserRow {
  const now = Date.now()
  const id = crypto.randomUUID()
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, display_name, must_change_password, disabled, can_control, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      id,
      input.username,
      input.passwordHash,
      input.role,
      input.displayName ?? input.username,
      input.mustChangePassword ? 1 : 0,
      input.canControl ? 1 : 0,
      now,
      now
    )
  return findUserById(id)!
}

export function updateUserPassword(userId: string, passwordHash: string, mustChange = false): void {
  getDb()
    .prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, mustChange ? 1 : 0, Date.now(), userId)
}

export function updateUserProfile(
  userId: string,
  patch: { role?: UserRole; displayName?: string; disabled?: boolean; canControl?: boolean }
): void {
  const current = findUserById(userId)
  if (!current) return
  getDb()
    .prepare(
      'UPDATE users SET role = ?, display_name = ?, disabled = ?, can_control = ?, updated_at = ? WHERE id = ?'
    )
    .run(
      patch.role ?? current.role,
      patch.displayName ?? current.display_name,
      patch.disabled === undefined ? current.disabled : patch.disabled ? 1 : 0,
      patch.canControl === undefined ? current.can_control : patch.canControl ? 1 : 0,
      Date.now(),
      userId
    )
}

export function countAdmins(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
    .get() as { n: number }
  return row.n
}

export function deleteUser(userId: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId)
}
