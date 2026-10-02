/**
 * 媒体令牌：宿主在解析出音源后登记真实来源（本地文件路径或带凭据的上游 URL），
 * 只把不含敏感信息的令牌路径交给前端。避免向浏览器暴露服务器绝对路径、上游凭据，
 * 同时避免任意 URL 代理带来的 SSRF 风险。
 */
import { getDb, jsonParse } from '../db/index.ts'
import { randomToken } from '../auth/password.ts'

export type MediaSource =
  | { kind: 'local'; filePath: string }
  | { kind: 'remote'; url: string; headers?: Record<string, string> }

export interface MediaRecord {
  token: string
  source: MediaSource
  userId: string | null
  expiresAt: number
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

export function registerMediaSource(source: MediaSource, userId: string | null, ttlMs = DEFAULT_TTL_MS): string {
  const token = randomToken(16)
  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO media_tokens (token, kind, payload, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(token, source.kind, JSON.stringify(source), userId, now + ttlMs, now)
  return `/api/media/${token}`
}

export function resolveMediaToken(token: string): MediaRecord | null {
  const row = getDb()
    .prepare('SELECT token, payload, user_id, expires_at FROM media_tokens WHERE token = ?')
    .get(token) as { token: string; payload: string; user_id: string | null; expires_at: number } | undefined
  if (!row) return null
  if (row.expires_at <= Date.now()) {
    getDb().prepare('DELETE FROM media_tokens WHERE token = ?').run(token)
    return null
  }
  return {
    token: row.token,
    source: jsonParse<MediaSource>(row.payload, { kind: 'local', filePath: '' }),
    userId: row.user_id,
    expiresAt: row.expires_at
  }
}

export function pruneExpiredMediaTokens(): number {
  const result = getDb().prepare('DELETE FROM media_tokens WHERE expires_at <= ?').run(Date.now())
  return Number(result.changes ?? 0)
}
