/**
 * 会话表访问。令牌为 32 字节随机值，仅存哈希无关信息；过期会话惰性清理。
 */
import { getDb } from './index.ts'
import { config } from '../config.ts'
import { randomToken } from '../auth/password.ts'
import { findUserById, type UserRow } from './users.ts'

export interface SessionRow {
  token: string
  user_id: string
  created_at: number
  expires_at: number
  last_seen_at: number
  user_agent: string | null
}

export const SESSION_COOKIE = 'vw_session'

export function createSession(userId: string, userAgent?: string): SessionRow {
  const token = randomToken(32)
  const now = Date.now()
  const row: SessionRow = {
    token,
    user_id: userId,
    created_at: now,
    expires_at: now + config.sessionTtlMs,
    last_seen_at: now,
    user_agent: userAgent ?? null
  }
  getDb()
    .prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(row.token, row.user_id, row.created_at, row.expires_at, row.last_seen_at, row.user_agent)
  return row
}

export function findSession(token: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(token) as SessionRow | undefined
}

/** 会话 → 用户；过期或用户已禁用时返回 null */
export function resolveSessionUser(token: string): UserRow | null {
  const session = findSession(token)
  if (!session) return null
  if (session.expires_at <= Date.now()) {
    deleteSession(token)
    return null
  }
  const user = findUserById(session.user_id)
  if (!user || user.disabled === 1) return null
  // 每小时刷新一次活跃时间，避免每请求都写库
  if (Date.now() - session.last_seen_at > 60 * 60 * 1000) {
    getDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(Date.now(), token)
  }
  return user
}

export function deleteSession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/** 改密/禁用后吊销该用户其它会话 */
export function deleteSessionsForUser(userId: string, exceptToken?: string): void {
  if (exceptToken) {
    getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, exceptToken)
    return
  }
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export function purgeExpiredSessions(): number {
  const result = getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  return Number(result.changes ?? 0)
}
