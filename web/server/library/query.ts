/**
 * 本地音乐库查询层：列表 / 专辑 / 艺人聚合、单曲详情、歌词读取、内嵌封面提取。
 *
 * 约束：
 * - 返回给前端的曲目结构绝不包含服务器绝对路径（file_path 只留在服务端与播放链路）。
 * - 封面用 sharp 统一压成 jpeg，缓存到 config.cacheDir，文件名带 mtime 以便随文件变化失效。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseAudioFile } from './metadata.ts'
import iconv from 'iconv-lite'
import jschardet from 'jschardet'
import sharp from 'sharp'
import { config, ensureDirs } from '../config.ts'
import { getDb } from '../db/index.ts'
import type { LocalTrackRow } from './scanner.ts'

export type { LocalTrackRow }

/** 对外的曲目结构（不含服务器路径） */
export interface LibraryTrack {
  id: string
  title: string
  artist: string
  album: string
  albumArtist: string
  durationMs: number
  trackNo: number | null
  discNo: number | null
  hasCover: boolean
  scannedAt: number
  streamUrl: string
  coverUrl: string
}

export interface AlbumSummary {
  album: string
  albumArtist: string
  trackCount: number
  durationMs: number
  hasCover: boolean
}

export interface ArtistSummary {
  artist: string
  trackCount: number
  albumCount: number
  durationMs: number
}

export interface TrackPage {
  items: LibraryTrack[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface TrackQueryOptions {
  q?: string
  page?: number
  pageSize?: number
  sort?: string
  order?: 'asc' | 'desc'
}

const SORT_COLUMNS: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumArtist: 'album_artist',
  album_artist: 'album_artist',
  duration: 'duration',
  durationMs: 'duration',
  trackNo: 'track_no',
  track_no: 'track_no',
  discNo: 'disc_no',
  disc_no: 'disc_no',
  scannedAt: 'scanned_at',
  scanned_at: 'scanned_at',
  size: 'size'
}

function toLibraryTrack(row: LocalTrackRow): LibraryTrack {
  return {
    id: row.id,
    title: row.title ?? '',
    artist: row.artist ?? '',
    album: row.album ?? '',
    albumArtist: row.album_artist ?? '',
    durationMs: Math.round((row.duration ?? 0) * 1000),
    trackNo: row.track_no ?? null,
    discNo: row.disc_no ?? null,
    hasCover: row.has_cover === 1,
    scannedAt: row.scanned_at,
    streamUrl: `/api/library/tracks/${row.id}/stream`,
    coverUrl: `/api/library/tracks/${row.id}/cover`
  }
}

/** 关键字搜索 + 排序 + 分页 */
export function listTracks(options: TrackQueryOptions = {}): TrackPage {
  const db = getDb()
  const page = Math.max(1, Math.floor(options.page ?? 1))
  const pageSize = Math.max(1, Math.min(Math.floor(options.pageSize ?? 50), 200))

  let sortKey = (options.sort ?? 'title').trim()
  let direction: 'asc' | 'desc' = options.order === 'desc' ? 'desc' : 'asc'
  if (sortKey.startsWith('-')) {
    direction = 'desc'
    sortKey = sortKey.slice(1)
  } else if (sortKey.startsWith('+')) {
    sortKey = sortKey.slice(1)
  }
  const column = SORT_COLUMNS[sortKey] ?? 'title'
  const dir = direction === 'desc' ? 'DESC' : 'ASC'

  const clauses: string[] = []
  const params: (string | number)[] = []
  const q = options.q?.trim()
  if (q) {
    const like = `%${q.toLowerCase()}%`
    clauses.push(
      '(LOWER(COALESCE(title, \'\')) LIKE ? OR LOWER(COALESCE(artist, \'\')) LIKE ? OR LOWER(COALESCE(album, \'\')) LIKE ? OR LOWER(COALESCE(album_artist, \'\')) LIKE ?)'
    )
    params.push(like, like, like, like)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  const countRow = db.prepare(`SELECT COUNT(*) AS n FROM local_tracks ${where}`).get(...params) as {
    n: number
  }
  const total = Number(countRow.n)
  const rows = db
    .prepare(
      `SELECT * FROM local_tracks ${where} ORDER BY ${column} COLLATE NOCASE ${dir}, id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as LocalTrackRow[]

  return {
    items: rows.map(toLibraryTrack),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  }
}

export function getTrackById(id: string): LibraryTrack | null {
  const row = getDb().prepare('SELECT * FROM local_tracks WHERE id = ?').get(id) as unknown as
    | LocalTrackRow
    | undefined
  return row ? toLibraryTrack(row) : null
}

/** 取原始行（含 file_path），仅供服务端播放链路使用，不得直接下发前端 */
export function getTrackRow(id: string): LocalTrackRow | null {
  const row = getDb().prepare('SELECT * FROM local_tracks WHERE id = ?').get(id) as unknown as
    | LocalTrackRow
    | undefined
  return row ?? null
}

export function listAlbums(): AlbumSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT album, MAX(album_artist) AS album_artist, COUNT(*) AS track_count,
              COALESCE(SUM(duration), 0) AS duration, MAX(has_cover) AS has_cover
         FROM local_tracks
        WHERE album IS NOT NULL AND TRIM(album) <> ''
        GROUP BY album
        ORDER BY album COLLATE NOCASE ASC`
    )
    .all() as unknown as {
    album: string
    album_artist: string | null
    track_count: number
    duration: number
    has_cover: number
  }[]
  return rows.map((row) => ({
    album: row.album,
    albumArtist: row.album_artist ?? '',
    trackCount: Number(row.track_count),
    durationMs: Math.round(Number(row.duration) * 1000),
    hasCover: Number(row.has_cover) === 1
  }))
}

export interface AlbumDetail {
  album: string
  albumArtist: string
  trackCount: number
  durationMs: number
  tracks: LibraryTrack[]
}

export function getAlbumDetail(name: string): AlbumDetail | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM local_tracks
        WHERE album = ?
        ORDER BY COALESCE(disc_no, 0) ASC, COALESCE(track_no, 9999) ASC, title COLLATE NOCASE ASC`
    )
    .all(name) as unknown as LocalTrackRow[]
  if (rows.length === 0) return null
  return {
    album: name,
    albumArtist: rows.find((r) => r.album_artist)?.album_artist ?? '',
    trackCount: rows.length,
    durationMs: Math.round(rows.reduce((sum, r) => sum + (r.duration ?? 0), 0) * 1000),
    tracks: rows.map(toLibraryTrack)
  }
}

export function listArtists(): ArtistSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT artist, COUNT(*) AS track_count, COUNT(DISTINCT album) AS album_count,
              COALESCE(SUM(duration), 0) AS duration
         FROM local_tracks
        WHERE artist IS NOT NULL AND TRIM(artist) <> ''
        GROUP BY artist
        ORDER BY artist COLLATE NOCASE ASC`
    )
    .all() as unknown as { artist: string; track_count: number; album_count: number; duration: number }[]
  return rows.map((row) => ({
    artist: row.artist,
    trackCount: Number(row.track_count),
    albumCount: Number(row.album_count),
    durationMs: Math.round(Number(row.duration) * 1000)
  }))
}

export interface ArtistDetail {
  artist: string
  trackCount: number
  albums: AlbumSummary[]
  tracks: LibraryTrack[]
}

export function getArtistDetail(name: string): ArtistDetail | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM local_tracks
        WHERE artist = ?
        ORDER BY album COLLATE NOCASE ASC, COALESCE(disc_no, 0) ASC, COALESCE(track_no, 9999) ASC`
    )
    .all(name) as unknown as LocalTrackRow[]
  if (rows.length === 0) return null
  const albums = new Map<string, AlbumSummary>()
  for (const row of rows) {
    const album = row.album ?? ''
    if (!album) continue
    const current = albums.get(album)
    if (current) {
      current.trackCount++
      current.durationMs += Math.round((row.duration ?? 0) * 1000)
      if (row.has_cover === 1) current.hasCover = true
    } else {
      albums.set(album, {
        album,
        albumArtist: row.album_artist ?? '',
        trackCount: 1,
        durationMs: Math.round((row.duration ?? 0) * 1000),
        hasCover: row.has_cover === 1
      })
    }
  }
  return {
    artist: name,
    trackCount: rows.length,
    albums: [...albums.values()],
    tracks: rows.map(toLibraryTrack)
  }
}

/* ------------------------------------------------------------------ 歌词 */

export interface LyricResult {
  lyric: string
  encoding: string
  source: 'file'
  path: string
}

function decodeLyricBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    if (swapped.length % 2 === 0) swapped.swap16()
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return { text, encoding: 'utf-8' }
  } catch {
    /* 继续尝试探测编码 */
  }
  try {
    const detected = jschardet.detect(buf)
    const encoding = detected?.encoding ?? ''
    if (encoding && encoding.toLowerCase() !== 'utf-8' && iconv.encodingExists(encoding)) {
      return { text: iconv.decode(buf, encoding), encoding: encoding.toLowerCase() }
    }
  } catch {
    /* 落到 gbk 兜底 */
  }
  return { text: iconv.decode(buf, 'gbk'), encoding: 'gbk' }
}

/** 读取同目录同名 .lrc 歌词；不存在返回 null */
export function readTrackLyric(id: string): LyricResult | null {
  const row = getTrackRow(id)
  if (!row) return null
  const base = row.file_path.replace(/\.[^/.]+$/, '')
  const candidates = [`${base}.lrc`, `${base}.LRC`, `${base}.Lrc`]
  for (const candidate of candidates) {
    try {
      const buf = fs.readFileSync(candidate)
      if (buf.length === 0) continue
      if (buf.length > 2 * 1024 * 1024) continue
      const decoded = decodeLyricBuffer(buf)
      return { lyric: decoded.text.replace(/^\uFEFF/, ''), encoding: decoded.encoding, source: 'file', path: candidate }
    } catch {
      continue
    }
  }
  return null
}

/* ------------------------------------------------------------------ 封面 */

export interface CoverResult {
  data: Buffer
  mime: string
  etag: string
  cached: boolean
}

function clampCoverSize(size: unknown): number {
  const n = Math.floor(Number(size))
  if (!Number.isFinite(n) || n <= 0) return 256
  return Math.max(48, Math.min(n, 1024))
}

/** 提取内嵌封面并压缩为 jpeg；无封面返回 null。结果缓存到 config.cacheDir/covers。 */
export async function getTrackCover(id: string, sizeInput?: unknown): Promise<CoverResult | null> {
  const row = getTrackRow(id)
  if (!row) return null
  const size = clampCoverSize(sizeInput)
  const mtime = row.mtime ?? 0
  const etag = `${mtime}-${size}`
  const cacheDir = path.join(config.cacheDir, 'covers')
  const cacheName = `${row.id}.${mtime}.${size}.jpg`
  const cachePath = path.join(cacheDir, cacheName)

  try {
    const data = await fsp.readFile(cachePath)
    if (data.length > 0) return { data, mime: 'image/jpeg', etag, cached: true }
  } catch {
    /* 未命中缓存 */
  }

  let picture
  try {
    const metadata = await parseAudioFile(row.file_path, { duration: false })
    picture = metadata.common.picture?.[0]
  } catch {
    return null
  }
  if (!picture || !picture.data || picture.data.length === 0) return null

  const data = await sharp(Buffer.from(picture.data))
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 82 })
    .toBuffer()

  ensureDirs()
  await fsp.mkdir(cacheDir, { recursive: true })
  await fsp.writeFile(cachePath, data)
  return { data, mime: 'image/jpeg', etag, cached: false }
}
