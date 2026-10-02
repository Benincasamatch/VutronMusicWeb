/**
 * 服务器本地音乐库扫描器。
 *
 * 职责：
 * - 维护「音乐根目录」列表（默认取 config.musicDirs，可由管理员通过接口覆盖/追加，持久化到 data 目录的 JSON 文件，
 *   不新增数据库表）。
 * - 递归扫描根目录下的音频文件，用 music-metadata 解析元数据写入 local_tracks。
 * - 依据 mtime + size 跳过未变更文件；清理磁盘上已消失的记录（仅限本次扫描的根目录范围）。
 * - 提供增量进度回调、并发限制与取消能力。
 *
 * 安全：所有文件路径都必须落在已配置的根目录之下（含 realpath 解析），防止目录穿越。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseAudioFile } from './metadata.ts'
import { config } from '../config.ts'
import { getDb } from '../db/index.ts'
import { randomToken } from '../auth/password.ts'

/** 支持的音频扩展名（小写，含点） */
export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.m4b',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.wma',
  '.aif',
  '.aiff',
  '.ape',
  '.wv',
  '.mp4',
  '.mka',
  '.mpc',
  '.tak',
  '.dsf',
  '.dff'
])

export interface LocalTrackRow {
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

export type ScanPhase = 'idle' | 'scanning' | 'finished' | 'cancelled' | 'error'

export interface ScanProgress {
  running: boolean
  phase: ScanPhase
  startedAt: number | null
  finishedAt: number | null
  roots: string[]
  total: number
  processed: number
  added: number
  updated: number
  skipped: number
  removed: number
  errors: number
  currentFile: string | null
  message?: string
}

export interface ScanResult extends ScanProgress {
  durationMs: number
}

export interface ScanOptions {
  /** 覆盖扫描根目录（默认取已配置列表）；调用方需保证已校验 */
  roots?: string[]
  /** 并发解析上限，默认 4 */
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
  /** 忽略 mtime/size 命中，强制重新解析全部文件 */
  force?: boolean
}

/* ------------------------------------------------------------------ 根目录 */

function rootsFile(): string {
  return path.join(config.dataDir, 'library-roots.json')
}

let cachedRoots: string[] | null = null

function readPersistedRoots(): string[] | null {
  try {
    const raw = fs.readFileSync(rootsFile(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((p) => path.resolve(p))
  } catch {
    return null
  }
}

/** 当前生效的音乐根目录（管理员设置优先，否则回退 config.musicDirs） */
export function getMusicRoots(): string[] {
  if (!cachedRoots) {
    const persisted = readPersistedRoots()
    cachedRoots = persisted ?? config.musicDirs.map((p) => path.resolve(p))
  }
  return [...cachedRoots]
}

/** 校验一组候选目录：必须为绝对路径且为服务器上真实存在的目录 */
export function validateMusicRoots(dirs: unknown[]): string[] {
  const out: string[] = []
  for (const raw of dirs) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('音乐目录必须是非空字符串')
    const resolved = path.resolve(raw.trim())
    if (!path.isAbsolute(raw.trim())) throw new Error(`必须是绝对路径: ${raw}`)
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
    } catch {
      throw new Error(`目录不存在: ${raw}`)
    }
    if (!stat.isDirectory()) throw new Error(`不是目录: ${raw}`)
    if (!out.includes(resolved)) out.push(resolved)
  }
  return out
}

/**
 * 设置音乐根目录并持久化。
 * mode = 'replace' 覆盖；'append' 在现有基础上追加（去重）。
 */
export function setMusicRoots(dirs: unknown[], mode: 'replace' | 'append' = 'replace'): string[] {
  const validated = validateMusicRoots(dirs)
  const next =
    mode === 'append'
      ? [...new Set([...getMusicRoots(), ...validated])]
      : validated
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.writeFileSync(rootsFile(), JSON.stringify(next, null, 2), 'utf8')
  cachedRoots = next
  return [...next]
}

/* -------------------------------------------------------------- 路径安全 */

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** 判断路径是否位于给定根目录之下（同时比较 resolve 与 realpath，抵御符号链接穿越） */
export function isUnderRoots(filePath: string, roots: string[] = getMusicRoots()): boolean {
  const candidates = new Set([path.resolve(filePath), realpathSafe(filePath)])
  for (const root of roots) {
    for (const base of [path.resolve(root), realpathSafe(root)]) {
      for (const candidate of candidates) {
        if (candidate !== base && candidate.startsWith(base + path.sep)) return true
      }
    }
  }
  return false
}

/** 断言路径安全，返回解析后的绝对路径；否则抛错 */
export function assertPathSafe(filePath: string, roots: string[] = getMusicRoots()): string {
  const resolved = path.resolve(filePath)
  if (!isUnderRoots(resolved, roots)) throw new Error('路径不在已配置的音乐目录中')
  return resolved
}

/* --------------------------------------------------------------- 扫描状态 */

function initialStatus(roots: string[] = []): ScanProgress {
  return {
    running: false,
    phase: 'idle',
    startedAt: null,
    finishedAt: null,
    roots: [...roots],
    total: 0,
    processed: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    errors: 0,
    currentFile: null
  }
}

let status: ScanProgress = initialStatus()
let active: { controller: AbortController; promise: Promise<ScanResult> } | null = null

export function getScanStatus(): ScanProgress {
  return { ...status, roots: [...status.roots] }
}

export function isScanRunning(): boolean {
  return active !== null
}

/** 取消进行中的扫描；返回是否确实有扫描被取消 */
export function cancelScan(): boolean {
  if (!active) return false
  active.controller.abort()
  return true
}

export function scanLibrary(options: ScanOptions = {}): Promise<ScanResult> {
  if (active) return Promise.reject(new Error('已有扫描正在进行中'))
  const controller = new AbortController()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const roots = (options.roots ?? getMusicRoots()).map((p) => path.resolve(p))
  status = initialStatus(roots)

  const promise = runScan(roots, options, controller.signal).finally(() => {
    active = null
  })
  active = { controller, promise }
  return promise
}

/* ------------------------------------------------------------------ 扫描 */

interface DiscoveredFile {
  filePath: string
  size: number
  mtime: number
}

async function collectFiles(roots: string[], signal: AbortSignal): Promise<DiscoveredFile[]> {
  const found = new Map<string, DiscoveredFile>()
  const stack = [...roots]
  while (stack.length > 0) {
    if (signal.aborted) break
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) stack.push(full)
      } else if (entry.isFile()) {
        if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        try {
          const stat = await fsp.stat(full)
          found.set(full, { filePath: full, size: stat.size, mtime: Math.floor(stat.mtimeMs) })
        } catch {
          /* 忽略读取失败的文件 */
        }
      }
    }
  }
  return [...found.values()]
}

interface ParsedMeta {
  title: string
  artist: string
  album: string
  albumArtist: string
  duration: number | null
  trackNo: number | null
  discNo: number | null
  hasCover: boolean
}

async function parseMeta(filePath: string): Promise<ParsedMeta> {
  const metadata = await parseAudioFile(filePath, { duration: true })
  const common = metadata.common
  const fallbackTitle = path.basename(filePath, path.extname(filePath))
  return {
    title: common.title?.trim() || fallbackTitle,
    artist: common.artist?.trim() || '',
    album: common.album?.trim() || '',
    albumArtist: common.albumartist?.trim() || '',
    duration: typeof metadata.format.duration === 'number' ? metadata.format.duration : null,
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    hasCover: Array.isArray(common.picture) && common.picture.length > 0
  }
}

async function runScan(
  roots: string[],
  options: ScanOptions,
  signal: AbortSignal
): Promise<ScanResult> {
  const db = getDb()
  const startedAt = Date.now()
  const emit = (partial: Partial<ScanProgress>): void => {
    status = { ...status, ...partial }
    try {
      options.onProgress?.(getScanStatus())
    } catch {
      /* 回调异常不影响扫描 */
    }
  }

  emit({ running: true, phase: 'scanning', startedAt, message: '正在枚举文件' })

  try {
    const files = await collectFiles(roots, signal)
    emit({ total: files.length, message: '正在解析元数据' })

    const existingRows = db
      .prepare('SELECT id, file_path, size, mtime FROM local_tracks')
      .all() as unknown as { id: string; file_path: string; size: number | null; mtime: number | null }[]
    const existing = new Map(existingRows.map((row) => [row.file_path, row]))

    const upsert = db.prepare(`
      INSERT INTO local_tracks
        (id, file_path, title, artist, album, album_artist, duration, track_no, disc_no, size, mtime, has_cover, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        album_artist = excluded.album_artist,
        duration = excluded.duration,
        track_no = excluded.track_no,
        disc_no = excluded.disc_no,
        size = excluded.size,
        mtime = excluded.mtime,
        has_cover = excluded.has_cover,
        scanned_at = excluded.scanned_at
    `)

    let added = 0
    let updated = 0
    let skipped = 0
    let errors = 0
    let processed = 0

    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16))
    let cursor = 0

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor++
        if (index >= files.length) return
        const file = files[index]
        const previous = existing.get(file.filePath)
        const unchanged =
          !options.force &&
          previous !== undefined &&
          previous.size === file.size &&
          previous.mtime === file.mtime
        if (unchanged) {
          skipped++
          processed++
          emit({ processed, skipped, currentFile: file.filePath })
          continue
        }
        try {
          const meta = await parseMeta(file.filePath)
          if (signal.aborted) return
          const id = previous?.id ?? randomToken(12)
          upsert.run(
            id,
            file.filePath,
            meta.title,
            meta.artist,
            meta.album,
            meta.albumArtist,
            meta.duration,
            meta.trackNo,
            meta.discNo,
            file.size,
            file.mtime,
            meta.hasCover ? 1 : 0,
            Date.now()
          )
          if (previous) updated++
          else added++
        } catch {
          errors++
        }
        processed++
        emit({ processed, added, updated, errors, currentFile: file.filePath })
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(files.length, 1)) }, worker))

    // 清理已消失的记录（仅限本次扫描根目录范围内的记录）
    let removed = 0
    if (!signal.aborted) {
      const discovered = new Set(files.map((f) => f.filePath))
      const del = db.prepare('DELETE FROM local_tracks WHERE id = ?')
      for (const row of existingRows) {
        if (!discovered.has(row.file_path) && isUnderRoots(row.file_path, roots)) {
          del.run(row.id)
          removed++
        }
      }
    }

    const finishedAt = Date.now()
    const phase: ScanPhase = signal.aborted ? 'cancelled' : 'finished'
    emit({
      running: false,
      phase,
      finishedAt,
      total: files.length,
      processed,
      added,
      updated,
      skipped,
      removed,
      errors,
      currentFile: null,
      message: phase === 'cancelled' ? '扫描已取消' : undefined
    })
    return { ...getScanStatus(), durationMs: finishedAt - startedAt }
  } catch (err) {
    const finishedAt = Date.now()
    emit({
      running: false,
      phase: 'error',
      finishedAt,
      currentFile: null,
      message: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}
