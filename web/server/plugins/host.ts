/**
 * 插件宿主：把桌面版 src/main/utils/pluginManager.ts 的 Worker 宿主移植到 Web 服务端。
 *
 * - 每个插件实例独占一个 Worker（`runner.mjs`，纯 JS，不依赖 tsx），凭据/状态按 instance_id 隔离在 plugin_state。
 * - 内置插件（config.plugins.dir）首次启动登记为全局实例（owner_user_id=NULL，built_in=1），由 admin 管理；
 *   登录用户可创建自己的实例（独立凭据）。
 * - 所有插件返回值经 PluginResultSchema[method] 校验，失败时回退到 defaultMap 语义的默认值并记录日志。
 * - 宿主负责把 songUrl 结果解析成真实音源并登记 media token，只把 /api/media/<token> 交给前端；
 *   同时通过 setMediaResolver 注册实现，使服务器（浏览器离线时）也能自行取到播放地址。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { PluginResultSchema } from '../../../src/types/schemas.ts'
import { config } from '../config.ts'
import { getDb, initDatabase } from '../db/index.ts'
import { randomToken } from '../auth/password.ts'
import { registerMediaSource } from '../media/tokens.ts'
import { setMediaResolver } from '../playback/resolver.ts'
import type { PlaybackTrack } from '../../shared/contract.ts'
import { pluginDbGet, pluginDbSet } from './dbBridge.ts'
import { getEmbeddedLyric, getPathLyric, parseLyricInput } from './lyric.ts'
import { resolvePluginUrl } from './songUrl.ts'
import type {
  InstanceRow,
  LoginStatus,
  MusicType,
  PluginInstanceInfo,
  PluginMeta,
  PluginSourceInfo
} from './types.ts'

const HTTP_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 60_000
const LOG_PREFIX = '[plugin]'

/** 与桌面版 src/types/plugin.ts 的 defaultMap 对齐：Zod 校验失败时的回退值 */
const DEFAULT_RESULTS: Record<string, unknown> = {
  updateBaseUrl: { code: 404 },
  getAccount: { code: 404, baseUrl: '', userName: '', pwd: '' },
  search: { code: 404, data: [], count: 0, sourceContext: {} },
  getLyric: { code: 404, data: [] },
  getBanner: { code: 404, data: [] },
  userPlaylist: { code: 404, liked: null, playlists: [], albums: [], sourceContext: {} },
  getRecommendPlaylist: { code: 404, data: [] },
  getRecommendTracks: { code: 404, data: [], sourceContext: {} },
  getPlaylistDetail: { code: 404, data: null },
  getPlaylistTracks: { code: 404, data: [], sourceContext: {} },
  personalFM: { code: 404, data: [], sourceContext: {} },
  fmTrash: { code: 404 },
  topSong: { code: 404, data: [], sourceContext: {} },
  topArtists: { code: 404, data: [], sourceContext: {} },
  artistsList: { code: 404, data: [], sourceContext: {} },
  topAlbums: { code: 404, hasMore: false, albums: [], sourceContext: {} },
  rankTop: { code: 404, data: [] },
  rankList: { code: 404, data: [], sourceContext: {} },
  songUrl: { code: 404, data: { url: [], replayGain: -14, peak: 1 } },
  loginQrKey: { code: 404, data: { url: '', qrcode: '' } },
  loginQrCodeCheck: { code: 800, message: '' },
  catlist: { code: 404, data: null },
  getCategoryPlaylist: { code: 404, data: [], sourceContext: { id: 0, offset: 0 } },
  systemPing: { code: 404, status: 'logout' },
  likelist: { code: 404, data: [], sourceContext: {} },
  userLikedArtists: { code: 404, data: [], sourceContext: {} },
  userLikedMVs: { code: 404, data: [], sourceContext: {} },
  userRecord: { code: 404, weekData: [], allData: [], sourceContext: {} },
  cloudDisk: { code: 404, data: [], sourceContext: {} },
  resizePicUrl: { code: 404, data: '' },
  albumDetail: { code: 404, data: null },
  artistAlbums: { code: 404, data: [], sourceContext: {} },
  artistDetail: { code: 404, artist: null, songs: [], sourceContext: {} },
  artistMVs: { code: 404, data: [], sourceContext: {} },
  simiArtists: { code: 404, data: [], sourceContext: {} },
  getTrackDetail: { code: 404, data: [] },
  likeATrack: { code: 404 },
  addOrRemoveTracksToPlaylist: { code: 404 },
  reorderPlaylistTracks: { code: 404 },
  createPlaylist: { code: 404 },
  editPlaylist: { code: 404 },
  deletePlaylist: { code: 404 },
  subscribePlaylist: { code: 404 },
  followArtist: { code: 404 },
  subscribeAlbum: { code: 404 },
  getTrackCatlist: { code: 404, data: [] },
  getAlbumCatlist: { code: 404, data: [] },
  newAlbums: { code: 404, data: [], sourceContext: {} },
  getArtistCatlist: { code: 404, data: [] },
  doLogin: { code: 404, message: '' },
  doLogout: { code: 404 },
  getAllTracks: { code: 404, data: [], count: 0, sourceContext: {} },
  scrobble: { code: 404 },
  mvDetail: { code: 404, data: null },
  subAMV: { code: 404 },
  likeAMV: { code: 404 },
  getCommentTab: { code: 404, data: [] },
  getComments: { code: 404, data: [], count: 0, sourceContext: {} },
  likeAComment: { code: 404 },
  submitAComment: { code: 404, data: null },
  getFloorComments: { code: 404, data: [], count: 0, sourceContext: {} },
  reportPlayback: { code: 404 },
  matchTrack: { code: 404 }
}

type SongUrlResult = z.infer<typeof PluginResultSchema.songUrl>

const SONG_URL_FALLBACK: SongUrlResult = {
  code: 404,
  data: { url: [], replayGain: -14, peak: 1 }
}

function schemaFor(method: string): z.ZodTypeAny | undefined {
  return (PluginResultSchema as unknown as Record<string, z.ZodTypeAny>)[method]
}

/** 校验插件返回值；失败时返回 defaultMap 语义的默认值 */
export function validatePluginResult(method: string, raw: unknown, context: string): unknown {
  const schema = schemaFor(method)
  if (!schema) {
    console.warn(`${LOG_PREFIX} ${context}.${method}: PluginResultSchema 未定义该方法，跳过校验`)
    return raw
  }
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  console.error(
    `${LOG_PREFIX} ${context}.${method}: 返回值未通过校验，回退默认值`,
    z.treeifyError(parsed.error)
  )
  return DEFAULT_RESULTS[method] ?? { code: 404 }
}

function normalizeMusicType(value: unknown): MusicType | null {
  return value === 'local' || value === 'library' || value === 'stream' ? value : null
}

/** 扫描插件目录：仅取顶层 *.js（跳过下划线/点开头的临时文件） */
function listPluginFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(
      (e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_') && !e.name.startsWith('.')
    )
    .map((e) => e.name.slice(0, -3))
    .sort((a, b) => a.localeCompare(b))
}

/** 插件实现文件查找：内置目录优先，避免同名用户插件覆盖内置实现 */
function resolvePluginFile(pluginId: string): string | null {
  const builtin = path.join(config.plugins.dir, `${pluginId}.js`)
  if (fs.existsSync(builtin)) return builtin
  const user = path.join(config.plugins.userDir, `${pluginId}.js`)
  if (fs.existsSync(user)) return user
  return null
}

function readInstanceRow(id: string): InstanceRow | undefined {
  return getDb().prepare('SELECT * FROM plugin_instances WHERE id = ?').get(id) as
    | InstanceRow
    | undefined
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Worker 消息形态（来自插件 Worker 的不可信输入，逐字段做运行时收窄） */
interface WorkerMessage {
  type: string
  requestId?: string
  callId?: number
  key?: unknown
  value?: unknown
  filter?: unknown
  paths?: unknown
  msg?: unknown
  meta?: unknown
  message?: unknown
  filePath?: unknown
  url?: unknown
  params?: unknown
  headers?: unknown
  method?: unknown
  data?: unknown
  raw?: unknown
  result?: unknown
  error?: unknown
}

function messageFilter(value: unknown): { ids?: string[] } | undefined {
  if (!value || typeof value !== 'object' || !('ids' in value)) return undefined
  const ids = value.ids
  if (!Array.isArray(ids)) return undefined
  return { ids: ids.filter((id): id is string => typeof id === 'string') }
}

function messageHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') result[key] = val
  }
  return result
}

export class PluginInstance {
  readonly id: string
  readonly pluginId: string
  readonly file: string
  readonly builtIn: boolean
  readonly ownerUserId: string | null
  name: string
  type: MusicType | null
  enabled: boolean
  meta: PluginMeta = {}
  loaded = false
  loadError: string | null = null
  loginStatus: LoginStatus = 'unknown'

  private worker: Worker | null = null
  private loading: Promise<void> | null = null
  private loadResolve: (() => void) | null = null
  private disposed = false
  private callIdCounter = 0
  private readonly callResolvers = new Map<number, PendingCall>()

  constructor(row: InstanceRow, file: string) {
    this.id = row.id
    this.pluginId = row.plugin_id
    this.file = file
    this.builtIn = row.built_in === 1
    this.ownerUserId = row.owner_user_id
    this.name = row.name ?? row.plugin_id
    this.type = normalizeMusicType(row.type)
    this.enabled = row.enabled === 1
  }

  get info(): PluginInstanceInfo {
    return {
      id: this.id,
      pluginId: this.pluginId,
      name: this.name,
      icon: typeof this.meta.icon === 'string' ? this.meta.icon : '',
      type: this.type,
      capabilities: this.meta.capabilities ?? null,
      builtIn: this.builtIn,
      enabled: this.enabled,
      ownerUserId: this.ownerUserId,
      loginStatus: this.loginStatus,
      configured: this.hasState(),
      loaded: this.loaded,
      loadError: this.loadError
    }
  }

  hasState(): boolean {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS cnt FROM plugin_state WHERE instance_id = ?')
      .get(this.id) as { cnt: number } | undefined
    return Number(row?.cnt ?? 0) > 0
  }

  ensureLoaded(): Promise<void> {
    if (this.disposed || this.loaded) return Promise.resolve()
    if (this.loading) return this.loading
    if (!this.file || !fs.existsSync(this.file)) {
      this.loadError = this.loadError ?? '插件文件不存在'
      return Promise.resolve()
    }
    this.loading = this.startWorker()
    return this.loading
  }

  private startWorker(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()

    let code: string
    try {
      code = fs.readFileSync(this.file, 'utf-8')
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err)
      return Promise.resolve()
    }

    this.loadResolve = () => {
      this.loadResolve = null
      resolve()
    }

    const worker = new Worker(new URL('./runner.mjs', import.meta.url))
    this.worker = worker

    // 只有仍为「当前 Worker」的事件才生效，避免停用后旧 Worker 的 exit 事件清掉新 Worker
    worker.on('message', (msg) => {
      if (this.worker !== worker) return
      // Worker 消息为跨线程不可信输入，交由 onMessage 逐字段收窄
      this.onMessage(msg as WorkerMessage).catch((err) => {
        console.error(`${LOG_PREFIX} ${this.id} 处理消息失败:`, err)
      })
    })
    worker.on('error', (err) => {
      if (this.worker !== worker) return
      this.loadError = err.message
      this.loaded = false
      this.rejectAllCalls(new Error(`插件运行错误: ${err.message}`))
      this.loadResolve?.()
    })
    worker.on('exit', (exitCode) => {
      if (this.worker !== worker) return
      this.worker = null
      this.loaded = false
      if (!this.disposed) {
        this.rejectAllCalls(new Error(`插件进程退出（code=${exitCode}）`))
      }
      this.loadResolve?.()
    })

    worker.postMessage({ type: 'LOAD_PLUGIN', code })
    return promise
  }

  private rejectAllCalls(error: Error): void {
    for (const pending of this.callResolvers.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.callResolvers.clear()
  }

  /** 调用插件方法（原始结果，未校验） */
  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.disposed || !this.loaded || !this.worker) {
      return Promise.reject(new Error(this.loadError ?? `插件 ${this.pluginId} 未加载`))
    }
    const worker = this.worker
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const callId = ++this.callIdCounter
    const timer = setTimeout(() => {
      if (this.callResolvers.has(callId)) {
        this.callResolvers.delete(callId)
        reject(new Error(`插件方法调用超时: ${method}`))
      }
    }, CALL_TIMEOUT_MS)
    timer.unref?.()
    this.callResolvers.set(callId, { resolve, reject, timer })
    worker.postMessage({ type: 'CALL_METHOD', callId, method, args: [params ?? {}] })
    return promise
  }

  /** 调用插件方法并做 Zod 校验（失败回退默认值） */
  async callValidated(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const raw = await this.call(method, params)
    const value = validatePluginResult(method, raw, this.id)
    this.trackLoginStatus(method, value)
    return value
  }

  private trackLoginStatus(method: string, value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    if (method === 'systemPing' && 'status' in value) {
      const status = value.status
      if (status === 'login' || status === 'logout' || status === 'offline') {
        this.loginStatus = status
      }
    } else if (method === 'doLogin' && 'code' in value && value.code === 200) {
      this.loginStatus = 'login'
    } else if (method === 'doLogout') {
      this.loginStatus = 'logout'
    }
  }

  private async onMessage(msg: WorkerMessage): Promise<void> {
    switch (msg.type) {
      case 'LOAD_DONE': {
        const rawMeta = msg.meta
        const isMetaObject = !!rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
        // 插件自述 meta：字段由插件定义，读取时逐个 typeof 收窄
        this.meta = isMetaObject ? (rawMeta as PluginMeta) : {}
        this.loaded = true
        this.loadError = null
        const type = normalizeMusicType(this.meta.type)
        if (type) this.type = type
        this.loadResolve?.()
        break
      }

      case 'ERROR': {
        this.loaded = false
        this.loadError = typeof msg.message === 'string' ? msg.message : '插件加载失败'
        console.error(`${LOG_PREFIX} ${this.id} 加载失败: ${this.loadError}`)
        this.loadResolve?.()
        break
      }

      case 'LOG': {
        console.log(`${LOG_PREFIX} ${this.id}:`, msg.msg)
        break
      }

      case 'CALL_RESULT': {
        if (typeof msg.callId !== 'number') return
        const pending = this.callResolvers.get(msg.callId)
        if (!pending) return
        this.callResolvers.delete(msg.callId)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(new Error(String(msg.error)))
        else pending.resolve(msg.result)
        break
      }

      case 'STORE_REQUEST': {
        const requestId = msg.requestId
        const key = typeof msg.key === 'string' ? msg.key : ''
        const data = key ? this.storeGet(key) : this.storeGetAll()
        this.post({ type: 'STORE_RESPONSE', requestId, data })
        break
      }

      case 'STORE_SET': {
        if (typeof msg.key === 'string') this.storeSet(msg.key, msg.value)
        break
      }

      case 'DB_REQUEST': {
        let data: unknown = null
        const key = typeof msg.key === 'string' ? msg.key : ''
        try {
          data = pluginDbGet(this.id, key, messageFilter(msg.filter))
        } catch (err) {
          console.error(`${LOG_PREFIX} ${this.id} DB_REQUEST(${key}) 失败:`, err)
        }
        this.post({ type: 'DB_RESPONSE', requestId: msg.requestId, data })
        break
      }

      case 'DB_SET': {
        if (typeof msg.key !== 'string') break
        try {
          pluginDbSet(this.id, msg.key, msg.value)
        } catch (err) {
          console.error(`${LOG_PREFIX} ${this.id} DB_SET(${msg.key}) 失败:`, err)
        }
        break
      }

      case 'LYRIC_PARSE': {
        this.post({
          type: 'LYRIC_RESPONSE',
          requestId: msg.requestId,
          data: parseLyricInput(msg.msg)
        })
        break
      }

      case 'LYRIC_EMBEDDED': {
        const filePath = String(msg.filePath ?? '')
        const data = await this.safeLyric(() => getEmbeddedLyric(filePath))
        this.post({ type: 'LYRIC_RESPONSE', requestId: msg.requestId, data })
        break
      }

      case 'LYRIC_PATH': {
        const filePath = String(msg.filePath ?? '')
        const data = await this.safeLyric(() => getPathLyric(filePath))
        this.post({ type: 'LYRIC_RESPONSE', requestId: msg.requestId, data })
        break
      }

      case 'CHECK_FILE_EXIST': {
        const paths = Array.isArray(msg.paths) ? msg.paths : []
        const data = paths.map((filePath) => ({
          path: filePath,
          exist: typeof filePath === 'string' && fs.existsSync(filePath)
        }))
        this.post({ type: 'STORE_RESPONSE', requestId: msg.requestId, data })
        break
      }

      case 'HTTP_REQUEST': {
        void this.handleHttp(msg)
        break
      }
    }
  }

  private async safeLyric(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      return await fn()
    } catch (err) {
      // .lrc 缺失属于正常探测流程，只记一行
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`${LOG_PREFIX} ${this.id} 歌词读取失败: ${message}`)
      return []
    }
  }

  private post(message: Record<string, unknown>): void {
    try {
      this.worker?.postMessage(message)
    } catch {
      /* worker 已退出 */
    }
  }

  private storeGetAll(): Record<string, unknown> {
    const rows = getDb().prepare('SELECT key, value FROM plugin_state WHERE instance_id = ?').all(
      this.id
    ) as unknown as { key: string; value: string }[]
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value)
      } catch {
        result[row.key] = row.value
      }
    }
    return result
  }

  private storeGet(key: string): unknown {
    const row = getDb()
      .prepare('SELECT value FROM plugin_state WHERE instance_id = ? AND key = ?')
      .get(this.id, key) as { value: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return row.value
    }
  }

  private storeSet(key: string, value: unknown): void {
    getDb()
      .prepare(
        `INSERT INTO plugin_state (instance_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value`
      )
      .run(this.id, key, JSON.stringify(value ?? null))
  }

  /** 出站域名限制：只允许访问插件自身 store 中配置的 baseUrl（与桌面版语义一致） */
  private checkDomain(rawUrl: string): boolean {
    const allowed = this.storeGet('baseUrl')
    if (typeof allowed !== 'string' || !allowed) return false
    try {
      const target = new URL(rawUrl)
      const allowedUrl = new URL(allowed)
      return (
        target.protocol === allowedUrl.protocol &&
        target.hostname === allowedUrl.hostname &&
        (allowedUrl.port === '' || target.port === allowedUrl.port)
      )
    } catch {
      return false
    }
  }

  private async handleHttp(msg: WorkerMessage): Promise<void> {
    const requestId = msg.requestId
    const method = typeof msg.method === 'string' ? msg.method : 'GET'
    const raw = msg.raw === true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

    let fullUrl: string
    try {
      const u = new URL(String(msg.url))
      const searchParams = new URLSearchParams(u.search)
      if (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)) {
        for (const [key, value] of Object.entries(msg.params)) {
          if (value !== undefined && value !== null) searchParams.set(key, String(value))
        }
      }
      u.search = searchParams.toString()
      fullUrl = u.toString()
    } catch {
      clearTimeout(timeout)
      this.post({ type: 'HTTP_RESPONSE', requestId, error: 'Invalid URL' })
      return
    }

    if (!this.checkDomain(fullUrl)) {
      clearTimeout(timeout)
      this.post({ type: 'HTTP_RESPONSE', requestId, error: 'Domain not allowed' })
      return
    }

    let response: Response
    try {
      const baseHeaders: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 VutronMusic' }
      if (method === 'POST') baseHeaders['Content-Type'] = 'application/json'
      response = await fetch(fullUrl, {
        method,
        headers: { ...baseHeaders, ...(messageHeaders(msg.headers) ?? {}) },
        body: method === 'GET' ? undefined : JSON.stringify(msg.data ?? {}),
        redirect: 'manual',
        signal: controller.signal
      })
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      this.post({
        type: 'HTTP_RESPONSE',
        requestId,
        error: isTimeout ? 'Request timeout' : err instanceof Error ? err.message : 'Network error'
      })
      return
    } finally {
      clearTimeout(timeout)
    }

    // 阻止重定向（与桌面版一致：跟随重定向可能绕过域名白名单）
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      this.post({
        type: 'HTTP_RESPONSE',
        requestId,
        error:
          !location || !this.checkDomain(location)
            ? 'Redirect target not allowed'
            : 'Redirect blocked'
      })
      return
    }

    let resData: unknown = null
    try {
      const rawText = await response.text()
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        try {
          resData = JSON.parse(rawText)
        } catch {
          resData = rawText
        }
      } else {
        resData = rawText
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} ${this.id} HTTP 响应解析失败:`, err)
    }

    if (response.status >= 400) {
      let message = `HTTP ${response.status}`
      if (typeof resData === 'object' && resData !== null && 'error' in resData) {
        message = String(resData.error)
      }
      this.post({ type: 'HTTP_RESPONSE', requestId, status: response.status, error: message })
      return
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    this.post({
      type: 'HTTP_RESPONSE',
      requestId,
      raw,
      data: resData,
      status: response.status,
      headers: responseHeaders
    })
  }

  /** 释放 Worker 但保留实例（可再次 ensureLoaded 唤醒） */
  release(): void {
    this.loaded = false
    this.loading = null
    this.loadResolve?.() // 结束可能在途的加载等待，避免调用方悬挂
    this.rejectAllCalls(new Error('插件实例已停用'))
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate()
  }

  /** 永久关闭实例 */
  terminate(): void {
    this.disposed = true
    this.release()
  }
}

/** 把 plugin_instances 行写入（已存在则只更新 updated_at，不覆盖 enabled/name） */
function upsertInstanceRow(row: {
  id: string
  pluginId: string
  ownerUserId: string | null
  builtIn: boolean
  name?: string | null
  type?: MusicType | null
}): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO plugin_instances
         (id, plugin_id, owner_user_id, name, type, built_in, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .run(
      row.id,
      row.pluginId,
      row.ownerUserId,
      row.name ?? null,
      row.type ?? null,
      row.builtIn ? 1 : 0,
      now,
      now
    )
}

function updateInstanceMeta(id: string, name: string, type: MusicType | null): void {
  getDb()
    .prepare('UPDATE plugin_instances SET name = ?, type = ?, updated_at = ? WHERE id = ?')
    .run(name, type, Date.now(), id)
}

export interface SongUrlOutcome {
  code: number
  mediaUrl: string | null
  error?: string
  replayGain?: number
  peak?: number
  cueOffset?: number
  cueDuration?: number
}

/** 调用插件 songUrl，解析真实音源并登记 media token；只对外暴露 mediaUrl */
export async function fetchInstanceSongUrl(
  instance: PluginInstance,
  params: Record<string, unknown>,
  userId: string | null
): Promise<SongUrlOutcome> {
  if (!instance.enabled) return { code: 0, mediaUrl: null, error: '该插件实例已停用' }

  const raw = await instance.call('songUrl', params)
  const value = validatePluginResult('songUrl', raw, instance.id)
  const parsed = PluginResultSchema.songUrl.safeParse(value)
  const result = parsed.success ? parsed.data : SONG_URL_FALLBACK
  const urls = result.data.url.filter((u) => typeof u === 'string' && u.length > 0)

  if (result.code !== 200 || !urls.length) {
    return { code: result.code, mediaUrl: null, error: `插件未返回可播放地址（code=${result.code}）` }
  }

  let lastError = '无法解析播放地址'
  for (const candidate of urls) {
    const resolved = await resolvePluginUrl(candidate, instance)
    if ('error' in resolved) {
      lastError = resolved.error
      continue
    }
    return {
      code: 200,
      mediaUrl: registerMediaSource(resolved.source, userId),
      replayGain: result.data.replayGain,
      peak: result.data.peak,
      cueOffset: result.data.cueOffset ?? 0,
      cueDuration: result.data.cueDuration ?? 0
    }
  }

  return { code: result.code, mediaUrl: null, error: lastError }
}

/** 由 PlaybackTrack 的 sourceContext 原样构造 songUrl 参数（不解析字段，仅展开透传） */
function songUrlParamsForTrack(track: PlaybackTrack): Record<string, unknown> {
  const ctx = track.sourceContext
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
    return { ...(ctx as Record<string, unknown>) }
  }
  return {}
}

export class PluginHost {
  private readonly instances = new Map<string, PluginInstance>()
  private readonly userPluginSources = new Map<string, PluginSourceInfo>()
  private builtinSources: PluginSourceInfo[] = []

  async init(): Promise<void> {
    initDatabase()

    for (const pluginId of listPluginFiles(config.plugins.dir)) {
      if (!readInstanceRow(pluginId)) {
        upsertInstanceRow({ id: pluginId, pluginId, ownerUserId: null, builtIn: true })
      }
      const row = readInstanceRow(pluginId)
      const file = resolvePluginFile(pluginId)
      if (row && file) this.instances.set(pluginId, new PluginInstance(row, file))
    }

    for (const pluginId of listPluginFiles(config.plugins.userDir)) {
      if (this.instances.has(pluginId)) continue
      this.userPluginSources.set(pluginId, {
        id: pluginId,
        name: pluginId,
        type: null,
        builtIn: false
      })
    }

    // 恢复用户自建实例
    const userRows = getDb()
      .prepare('SELECT * FROM plugin_instances WHERE built_in = 0')
      .all() as unknown as InstanceRow[]
    for (const row of userRows) {
      if (this.instances.has(row.id)) continue
      const file = resolvePluginFile(row.plugin_id)
      const instance = new PluginInstance(row, file ?? '')
      if (!file) instance.loadError = '插件文件不存在'
      this.instances.set(row.id, instance)
    }

    // 逐个加载（失败不阻塞其它实例）
    await Promise.all([...this.instances.values()].map((inst) => inst.ensureLoaded()))

    for (const inst of this.instances.values()) {
      if (inst.loaded) {
        const name =
          typeof inst.meta.name === 'string' && inst.meta.name ? inst.meta.name : inst.name
        inst.name = name
        updateInstanceMeta(inst.id, name, inst.type)
      }
    }

    this.builtinSources = [...this.instances.values()]
      .filter((inst) => inst.builtIn)
      .map((inst) => ({ id: inst.pluginId, name: inst.name, type: inst.type, builtIn: true }))

    setMediaResolver((track, userId) => this.resolveMediaForTrack(track, userId))
  }

  listInstancesFor(user: { id: string; role: string }): PluginInstanceInfo[] {
    return [...this.instances.values()]
      .filter((inst) => inst.builtIn || user.role === 'admin' || inst.ownerUserId === user.id)
      .map((inst) => inst.info)
  }

  listSources(): PluginSourceInfo[] {
    return [...this.builtinSources, ...this.userPluginSources.values()]
  }

  getInstance(id: string): PluginInstance | undefined {
    return this.instances.get(id)
  }

  resolveInstanceForTrack(track: PlaybackTrack): PluginInstance | undefined {
    if (track.instanceId) {
      const byId = this.instances.get(track.instanceId)
      if (byId) return byId
    }
    for (const inst of this.instances.values()) {
      if (inst.builtIn && inst.pluginId === track.pluginId) return inst
    }
    return undefined
  }

  async createInstance(ownerUserId: string, pluginId: string, name?: string): Promise<InstanceRow> {
    const file = resolvePluginFile(pluginId)
    if (!file) throw new Error(`插件不存在: ${pluginId}`)
    const id = `u_${randomToken(8)}`
    upsertInstanceRow({ id, pluginId, ownerUserId, builtIn: false, name: name ?? null })
    const row = readInstanceRow(id)
    if (!row) throw new Error('创建插件实例失败')
    const instance = new PluginInstance(row, file)
    this.instances.set(id, instance)
    await instance.ensureLoaded()
    if (instance.loaded) {
      const finalName =
        name || (typeof instance.meta.name === 'string' && instance.meta.name) || instance.name
      instance.name = finalName
      updateInstanceMeta(id, finalName, instance.type)
    }
    return readInstanceRow(id)!
  }

  deleteInstance(id: string): boolean {
    const instance = this.instances.get(id)
    if (!instance || instance.builtIn) return false
    instance.terminate()
    this.instances.delete(id)
    getDb().prepare('DELETE FROM plugin_state WHERE instance_id = ?').run(id)
    getDb().prepare('DELETE FROM plugin_instances WHERE id = ?').run(id)
    return true
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInstance> {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`插件实例不存在: ${id}`)
    instance.enabled = enabled
    getDb()
      .prepare('UPDATE plugin_instances SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id)
    if (enabled) await instance.ensureLoaded()
    else instance.release()
    return instance
  }

  private async resolveMediaForTrack(
    track: PlaybackTrack,
    userId: string | null
  ): Promise<{ mediaUrl?: string; error?: string }> {
    const instance = this.resolveInstanceForTrack(track)
    if (!instance) return { error: `未找到插件实例: ${track.pluginId}` }
    try {
      const outcome = await fetchInstanceSongUrl(instance, songUrlParamsForTrack(track), userId)
      if (outcome.mediaUrl) return { mediaUrl: outcome.mediaUrl }
      return { error: outcome.error ?? '无法解析播放地址' }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  shutdown(): void {
    for (const inst of this.instances.values()) inst.terminate()
    this.instances.clear()
    setMediaResolver(null)
  }
}

let hostSingleton: PluginHost | null = null
let hostInit: Promise<PluginHost> | null = null

/** 初始化插件宿主（幂等）：登记内置实例、恢复用户实例、加载 Worker、注册媒体解析器 */
export function initPluginHost(): Promise<PluginHost> {
  if (!hostInit) {
    hostSingleton = new PluginHost()
    hostInit = hostSingleton.init().then(() => hostSingleton!)
  }
  return hostInit
}

/** 取已初始化的宿主；未初始化时抛错 */
export function getPluginHost(): PluginHost {
  if (!hostSingleton) throw new Error('插件宿主未初始化，请先调用 initPluginHost()')
  return hostSingleton
}

/** 关闭插件宿主（测试/退出时释放 Worker） */
export function shutdownPluginHost(): void {
  hostSingleton?.shutdown()
  hostSingleton = null
  hostInit = null
}
