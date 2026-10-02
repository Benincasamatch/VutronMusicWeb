/**
 * 插件数据桥（apis.db）。
 *
 * - `Track` / `Album` / `Artist`：只读桥接到服务器扫描出的 `local_tracks`（local 插件需要 Track 列表/详情）。
 * - `PluginData`：读写桥接到 `plugin_state`（按 instance_id 隔离）。插件用它保存账号/token/cookie 等凭据，
 *   因此不会下发给前端，也不引入新表。
 * - `Playlist` / `PlaylistEntry`：Web 版歌单属于用户域（由用户数据层管理），插件侧一律返回空，避免越权。
 * - 其余写入一律忽略并记录日志（对元数据表保持只读）。
 *
 * 返回结构对齐桌面版 src/main/dbHelpers.ts 的 pluginDbGet，插件无需改动即可解析。
 */
import { getDb, jsonParse } from '../db/index.ts'
import type { TrackRow, AlbumRow, ArtistRow } from './types.ts'

export interface PluginDbFilter {
  ids?: string[]
  [key: string]: unknown
}

const PLUGIN_DATA_KEY = 'PluginData'

interface LocalTrackRow {
  id: string
  file_path: string
  title: string | null
  artist: string | null
  album: string | null
  album_artist: string | null
  duration: number | null
  track_no: number | null
  disc_no: number | null
  size: number | null
  mtime: number | null
  has_cover: number
  scanned_at: number
}

/** 扫描器写入的 artist 字段可能是 "A/B"、"A; B" 这类复合值，拆成艺人数组以便插件展示 */
function splitArtists(value: string | null): string[] {
  if (!value) return []
  return value
    .split(/\s*[/;；]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function toArtists(value: string | null): { id: string; name: string }[] {
  return splitArtists(value).map((name) => ({ id: `local-artist:${name}`, name }))
}

function toTrackRow(row: LocalTrackRow): TrackRow {
  const albumName = row.album ?? ''
  return {
    id: row.id,
    name: row.title ?? '',
    duration: Number(row.duration ?? 0),
    albumId: albumName,
    albumName,
    artists: toArtists(row.artist),
    albumArtists: toArtists(row.album_artist || row.artist),
    filePath: row.file_path,
    size: Number(row.size ?? 0),
    md5: '',
    cueOffset: 0,
    cueDuration: 0,
    picUrl: '',
    playCount: 0,
    liked: 0,
    createTime: row.scanned_at,
    no: row.track_no ?? 0,
    alias: ''
  }
}

function queryTracks(filterIds?: string[]): LocalTrackRow[] {
  const db = getDb()
  if (filterIds?.length) {
    const placeholders = filterIds.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT * FROM local_tracks WHERE id IN (${placeholders})`)
      .all(...filterIds) as unknown as LocalTrackRow[]
    // SQLite WHERE IN 不保证顺序，按传入 ids 重排
    const order = new Map(filterIds.map((id, i) => [id, i]))
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    return rows
  }
  return db.prepare('SELECT * FROM local_tracks ORDER BY id').all() as unknown as LocalTrackRow[]
}

function queryAlbums(): AlbumRow[] {
  const rows = getDb()
    .prepare(
      "SELECT album AS name, COUNT(*) AS cnt FROM local_tracks WHERE album IS NOT NULL AND album <> '' GROUP BY album ORDER BY album"
    )
    .all() as unknown as { name: string; cnt: number }[]
  return rows.map((row) => ({
    id: row.name,
    name: row.name,
    picUrl: '',
    trackCount: Number(row.cnt ?? 0),
    subscribed: false
  }))
}

function queryArtists(): ArtistRow[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT artist FROM local_tracks WHERE artist IS NOT NULL AND artist <> ''")
    .all() as unknown as { artist: string }[]
  const map = new Map<string, { id: string; name: string; followed: boolean }>()
  for (const row of rows) {
    for (const name of splitArtists(row.artist)) {
      if (!map.has(name)) map.set(name, { id: `local-artist:${name}`, name, followed: false })
    }
  }
  return [...map.values()]
}

function readPluginData(instanceId: string): Record<string, unknown> {
  const row = getDb()
    .prepare('SELECT value FROM plugin_state WHERE instance_id = ? AND key = ?')
    .get(instanceId, PLUGIN_DATA_KEY) as { value: string } | undefined
  return jsonParse<Record<string, unknown>>(row?.value, {})
}

/** 通用插件数据查询：key 路由到对应数据源 */
export function pluginDbGet(
  instanceId: string,
  key: string,
  filter?: PluginDbFilter
): unknown {
  switch (key) {
    case 'PluginData':
      return readPluginData(instanceId)
    case 'Track': {
      const songs = queryTracks(filter?.ids).map(toTrackRow)
      return { code: 200, songs, privileges: {} }
    }
    case 'Album':
      return queryAlbums()
    case 'Artist':
      return queryArtists()
    case 'Playlist':
    case 'PlaylistEntry':
      return []
    default:
      return null
  }
}

/** 通用插件数据写入：仅 PluginData（凭据，按实例隔离）落库，其余只读忽略 */
export function pluginDbSet(instanceId: string, key: string, value: unknown): void {
  if (key === 'PluginData') {
    getDb()
      .prepare(
        `INSERT INTO plugin_state (instance_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value`
      )
      .run(instanceId, PLUGIN_DATA_KEY, JSON.stringify(value ?? {}))
    return
  }
  console.warn(`[pluginDbSet] 忽略对只读表 ${key} 的写入（instance=${instanceId}）`)
}
