/**
 * 每用户隔离的个人数据：收藏、歌单、设置。
 * 所有读写都必须带 user_id 过滤；曲目 payload 以 JSON 原样存取，宿主不解析其字段。
 */
import crypto from 'node:crypto'
import { getDb, jsonParse, transaction } from './index.ts'

export interface FavoriteRecord {
  trackKey: string
  payload: unknown
  createdAt: number
}

export interface PlaylistSummary {
  id: string
  name: string
  description: string
  trackCount: number
  createdAt: number
  updatedAt: number
}

export interface PlaylistTrackRecord {
  trackKey: string
  payload: unknown
  position: number
  addedAt: number
}

export interface PlaylistDetail extends PlaylistSummary {
  tracks: PlaylistTrackRecord[]
}

interface FavoriteRow {
  track_key: string
  payload: string
  created_at: number
}

interface PlaylistRow {
  id: string
  user_id: string
  name: string
  description: string | null
  created_at: number
  updated_at: number
}

interface PlaylistTrackRow {
  track_key: string
  payload: string
  position: number
  added_at: number
}

export function listFavorites(userId: string): FavoriteRecord[] {
  const rows = getDb()
    .prepare('SELECT track_key, payload, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as unknown as FavoriteRow[]
  return rows.map((row) => ({
    trackKey: row.track_key,
    payload: jsonParse<unknown>(row.payload, null),
    createdAt: row.created_at
  }))
}

export function upsertFavorite(userId: string, trackKey: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO favorites (user_id, track_key, payload, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, track_key) DO UPDATE SET payload = excluded.payload`
    )
    .run(userId, trackKey, JSON.stringify(payload ?? null), Date.now())
}

export function removeFavorite(userId: string, trackKey: string): number {
  const result = getDb()
    .prepare('DELETE FROM favorites WHERE user_id = ? AND track_key = ?')
    .run(userId, trackKey)
  return Number(result.changes ?? 0)
}

function playlistRowToSummary(row: PlaylistRow, trackCount: number): PlaylistSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    trackCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listPlaylists(userId: string): PlaylistSummary[] {
  const rows = getDb()
    .prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as unknown as PlaylistRow[]
  const counts = getDb()
    .prepare(
      `SELECT p.id AS id, COUNT(t.track_key) AS n
       FROM playlists p LEFT JOIN playlist_tracks t ON t.playlist_id = p.id
       WHERE p.user_id = ? GROUP BY p.id`
    )
    .all(userId) as unknown as { id: string; n: number }[]
  const countById = new Map(counts.map((c) => [c.id, c.n]))
  return rows.map((row) => playlistRowToSummary(row, countById.get(row.id) ?? 0))
}

export function findPlaylistRow(userId: string, id: string): PlaylistRow | undefined {
  return getDb().prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(id, userId) as
    | PlaylistRow
    | undefined
}

export function getPlaylist(userId: string, id: string): PlaylistDetail | null {
  const row = findPlaylistRow(userId, id)
  if (!row) return null
  const tracks = getDb()
    .prepare('SELECT track_key, payload, position, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC')
    .all(id) as unknown as PlaylistTrackRow[]
  return {
    ...playlistRowToSummary(row, tracks.length),
    tracks: tracks.map((t) => ({
      trackKey: t.track_key,
      payload: jsonParse<unknown>(t.payload, null),
      position: t.position,
      addedAt: t.added_at
    }))
  }
}

export function createPlaylist(userId: string, name: string, description = ''): string {
  const id = crypto.randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO playlists (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, userId, name, description, now, now)
  return id
}

export function updatePlaylist(
  userId: string,
  id: string,
  patch: { name?: string; description?: string }
): boolean {
  const row = findPlaylistRow(userId, id)
  if (!row) return false
  getDb()
    .prepare('UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(patch.name ?? row.name, patch.description ?? row.description ?? '', Date.now(), id)
  return true
}

export function deletePlaylist(userId: string, id: string): boolean {
  if (!findPlaylistRow(userId, id)) return false
  transaction(() => {
    getDb().prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id)
    getDb().prepare('DELETE FROM playlists WHERE id = ?').run(id)
  })
  return true
}

function touchPlaylist(playlistId: string): void {
  getDb().prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId)
}

export function addPlaylistTracks(
  userId: string,
  playlistId: string,
  tracks: { trackKey: string; payload: unknown }[],
  position?: number
): boolean {
  if (!findPlaylistRow(userId, playlistId)) return false
  transaction(() => {
    const maxRow = getDb()
      .prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM playlist_tracks WHERE playlist_id = ?')
      .get(playlistId) as { maxPos: number }
    let next = maxRow.maxPos + 1
    const insertAt = position === undefined ? null : Math.max(0, position)
    if (insertAt !== null && insertAt <= maxRow.maxPos) {
      // 让出插入位：从插入点起整体后移
      getDb()
        .prepare('UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ?')
        .run(playlistId, insertAt)
      next = insertAt
    }
    const stmt = getDb().prepare(
      `INSERT INTO playlist_tracks (playlist_id, track_key, payload, position, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(playlist_id, track_key) DO UPDATE SET payload = excluded.payload`
    )
    const now = Date.now()
    for (const track of tracks) {
      stmt.run(playlistId, track.trackKey, JSON.stringify(track.payload ?? null), next, now)
      next += 1
    }
    touchPlaylist(playlistId)
  })
  return true
}

export function removePlaylistTracks(userId: string, playlistId: string, trackKeys: string[]): boolean {
  if (!findPlaylistRow(userId, playlistId)) return false
  transaction(() => {
    const stmt = getDb().prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_key = ?')
    for (const key of trackKeys) stmt.run(playlistId, key)
    renumberPlaylist(playlistId)
    touchPlaylist(playlistId)
  })
  return true
}

function renumberPlaylist(playlistId: string): void {
  const rows = getDb()
    .prepare('SELECT track_key FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC')
    .all(playlistId) as unknown as { track_key: string }[]
  const stmt = getDb().prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_key = ?')
  rows.forEach((row, index) => stmt.run(index, playlistId, row.track_key))
}

/** 按传入顺序重排歌单；未列出的曲目保持原相对顺序排在后面 */
export function reorderPlaylist(userId: string, playlistId: string, trackKeys: string[]): boolean {
  if (!findPlaylistRow(userId, playlistId)) return false
  transaction(() => {
    const stmt = getDb().prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_key = ?')
    trackKeys.forEach((key, index) => stmt.run(index, playlistId, key))
    renumberPlaylist(playlistId)
    touchPlaylist(playlistId)
  })
  return true
}

export function getSettings(userId: string): Record<string, unknown> {
  const rows = getDb().prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId) as unknown as {
    key: string
    value: string
  }[]
  const out: Record<string, unknown> = {}
  for (const row of rows) out[row.key] = jsonParse<unknown>(row.value, null)
  return out
}

export function putSettings(userId: string, patch: Record<string, unknown>): Record<string, unknown> {
  transaction(() => {
    const stmt = getDb().prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
    )
    for (const [key, value] of Object.entries(patch)) stmt.run(userId, key, JSON.stringify(value ?? null))
  })
  return getSettings(userId)
}
