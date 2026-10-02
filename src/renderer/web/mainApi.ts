/**
 * 浏览器版 window.mainApi：与桌面版 preload 保持同一套 send/on/once/off/invoke 接口，
 * 让既有渲染层无需改动即可在普通浏览器中运行。
 *
 * 通道分三类：
 * 1. 真实映射（见 invokeHandlers / sendHandlers）：转发到 web/shared/contract.ts 里定义的 HTTP 接口。
 * 2. 桌面专用（托盘 / 更新 / OSD / 全局快捷键 / 日志 / 文件对话框 / Discord / Last.fm / MPRIS 等）：
 *    返回无害默认值并 console.debug 记录通道名，绝不抛异常。
 * 3. 未知通道：invoke 返回 null，send 直接忽略，同样只记录日志。
 *
 * 事件方向：桌面版由主进程 IPC 触发渲染层监听，浏览器版改由实时通道经 dispatchRendererEvent 触发，
 * on/once/off 因此是“可用的空实现”——注册与反注册都真实生效。
 */
import { API } from '../../../web/shared/contract.ts'
import { apiFetch, withFallback } from './http.ts'
import appPackage from '../../../package.json'

export type MainApiListener = (...args: unknown[]) => void

export interface MainApi {
  send: (channel: string, ...data: unknown[]) => void
  on: (channel: string, listener: MainApiListener) => void
  once: (channel: string, listener: MainApiListener) => void
  off: (channel: string, listener: MainApiListener) => void
  invoke: (channel: string, ...data: unknown[]) => Promise<unknown>
}

export const APP_VERSION: string = appPackage.version

/** 桌面版 get-song-url 失败时的返回结构（与主进程 IPCs.ts 保持一致，url 为空表示当前不可播放） */
const SONG_URL_FALLBACK = {
  url: [] as string[],
  replayGain: 0,
  peak: 1,
  cueOffset: 0,
  cueDuration: 0
}

/** 服务端返回的 JSON 对象视图；字段读取一律配合 typeof/Array.isArray 收窄 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

// ── 渲染层监听器 ────────────────────────────────────────────────

const listeners = new Map<string, Set<MainApiListener>>()
const onceWrappers = new WeakMap<MainApiListener, Map<string, MainApiListener>>()

function addListener(channel: string, listener: MainApiListener): void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(listener)
}

function removeListener(channel: string, listener: MainApiListener): void {
  const set = listeners.get(channel)
  if (set) {
    set.delete(listener)
    const wrapper = onceWrappers.get(listener)?.get(channel)
    if (wrapper) set.delete(wrapper)
  }
  onceWrappers.get(listener)?.delete(channel)
}

function addOnceListener(channel: string, listener: MainApiListener): void {
  const wrapper: MainApiListener = (...args: unknown[]) => {
    removeListener(channel, listener)
    listener(...args)
  }
  let wrappers = onceWrappers.get(listener)
  if (!wrappers) {
    wrappers = new Map()
    onceWrappers.set(listener, wrappers)
  }
  wrappers.set(channel, wrapper)
  addListener(channel, wrapper)
}

/**
 * 触发渲染层通过 on/once 注册的监听器（对齐 IpcRendererEvent 签名：首参为事件对象）。
 * 实时通道（realtime.ts）用它把服务端播放状态推给既有渲染层代码。
 */
export function dispatchRendererEvent(channel: string, ...args: unknown[]): void {
  const set = listeners.get(channel)
  if (!set || set.size === 0) return
  for (const listener of [...set]) {
    try {
      listener({ channel }, ...args)
    } catch (err) {
      console.error(`[mainApi] 监听器执行失败 (${channel}):`, err)
    }
  }
}

// ── 插件数据规范化 ──────────────────────────────────────────────

/**
 * get-plugins 期望 [pluginId, meta][]（桌面版主进程即返回该结构）。
 * 这里同时兼容服务端可能返回的对象数组写法，减少两侧接线时的耦合。
 */
function normalizePluginList(data: unknown): [string, Record<string, unknown>][] {
  const container = asRecord(data)
  const list = Array.isArray(data) ? data : Array.isArray(container?.plugins) ? container.plugins : []
  const out: [string, Record<string, unknown>][] = []
  for (const item of list) {
    if (Array.isArray(item) && typeof item[0] === 'string') {
      out.push([item[0], asRecord(item[1]) ?? {}])
      continue
    }
    const record = asRecord(item)
    const id = record?.id ?? record?.pluginId ?? record?.code
    if (record && typeof id === 'string') out.push([id, record])
  }
  return out
}

// ── 用户设置（/api/me/settings）─────────────────────────────────

async function readUserSettings(): Promise<Record<string, any>> {
  const data = await apiFetch(API.me.settings)
  const record = asRecord(data)
  return asRecord(record?.settings) ?? record ?? {}
}

/** 歌词偏移按曲目存进用户设置；key 前缀固定，读写共用同一构造 */
function lyricOffsetKey(pluginId: unknown, trackId: unknown): string | null {
  if (typeof pluginId !== 'string' || !pluginId) return null
  if (typeof trackId !== 'string' && typeof trackId !== 'number') return null
  return `lyric-offset:${encodeURIComponent(`${pluginId}:${trackId}`)}`
}

// ── invoke：真实映射的通道 ──────────────────────────────────────

const invokeHandlers: Record<string, (args: unknown[]) => Promise<unknown>> = {
  'get-plugins': async () => normalizePluginList(await apiFetch(API.plugins.list)),

  'plugin-method-call': async (args) => {
    const payload = asRecord(args[0])
    const pluginId = String(payload?.pluginId ?? '')
    const methodName = String(payload?.methodName ?? '')
    if (!pluginId || !methodName) return null
    return await apiFetch(API.plugins.call(pluginId), {
      method: 'POST',
      body: { methodName, params: payload?.params ?? {} }
    })
  },

  // 歌词失败不能阻断播放，按桌面版“拿不到就返回 404”的语义兜底
  'plugin-lyric': async (args) => {
    const payload = asRecord(args[0])
    const pluginId = String(payload?.pluginId ?? '')
    if (!pluginId) return { code: 404, data: null }
    return await withFallback(
      () =>
        apiFetch(API.plugins.lyric(pluginId), {
          method: 'POST',
          body: { sourceContext: payload?.sourceContext }
        }),
      { code: 404, data: null }
    )
  },

  'get-song-url': async (args) => {
    const payload = asRecord(args[0])
    const pluginId = String(payload?.pluginId ?? '')
    if (!pluginId) return SONG_URL_FALLBACK
    return await withFallback(async () => {
      const data = asRecord(
        await apiFetch(API.plugins.songUrl(pluginId), {
          method: 'POST',
          body: {
            pluginId,
            sourceContext: payload?.sourceContext,
            track: payload?.track
          }
        })
      )
      const rawUrl = data?.url
      const urls: string[] = Array.isArray(rawUrl)
        ? rawUrl.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : typeof rawUrl === 'string' && rawUrl.length > 0
          ? [rawUrl]
          : []
      if (!urls.length) return SONG_URL_FALLBACK
      return {
        url: urls,
        replayGain: Number(data?.replayGain ?? 0),
        peak: Number(data?.peak ?? 1),
        cueOffset: Number(data?.cueOffset ?? 0),
        cueDuration: Number(data?.cueDuration ?? 0)
      }
    }, SONG_URL_FALLBACK)
  },

  'get-source-priority': async () =>
    await withFallback(() => apiFetch(API.plugins.sourcePriority), {
      trackInfoOrder: ['path', 'online', 'embedded']
    }),

  'create-plugin-instance': async (args) => {
    const payload = asRecord(args[0])
    return await withFallback(
      () =>
        apiFetch(API.plugins.instances, {
          method: 'POST',
          body: { basePluginId: payload?.basePluginId, name: payload?.name }
        }),
      { success: false }
    )
  },

  // 桌面版该通道直接收 instanceId 字符串
  'delete-plugin-instance': async (args) => {
    const instanceId = typeof args[0] === 'string' ? args[0] : String(asRecord(args[0])?.instanceId ?? '')
    if (!instanceId) return { success: false }
    return await withFallback(
      () =>
        apiFetch(API.plugins.instances, {
          method: 'DELETE',
          query: { instanceId }
        }),
      { success: false }
    )
  },

  'get-lyric-offset': async (args) => {
    const payload = asRecord(args[0])
    const key = lyricOffsetKey(payload?.pluginId, payload?.trackId)
    if (!key) return undefined
    const settings = await withFallback(readUserSettings, {})
    const value = settings[key]
    return typeof value === 'number' ? value : undefined
  },

  'set-lyric-offset': async (args) => {
    const payload = asRecord(args[0])
    const key = lyricOffsetKey(payload?.pluginId, payload?.trackId)
    if (!key) return false
    await apiFetch(API.me.settings, {
      method: 'POST',
      body: { [key]: Number(payload?.offset ?? 0) }
    })
    return true
  },

  msgRequestGetVersion: async () => APP_VERSION
}

/** 桌面专用通道的 invoke 默认值：形状对齐各调用点的读取方式，保证不崩、也不假装有数据 */
const invokeFallbacks: Record<string, unknown> = {
  'upload-plugin': { code: 404, error: 'NOT_SUPPORTED' },
  getFontList: [],
  'check-update': null,
  'get-cache-path': '',
  getCacheTracksInfo: { length: 0, size: 0 },
  clearCacheTracks: false,
  getStreamMatchCount: 0,
  clearStreamMatches: null,
  'lastfm-auth': { name: '' },
  'get-lastfm-session': { name: '' },
  disconnectLastfm: null,
  trackMatch: null,
  accurateMatch: null,
  selecteFolder: null,
  showOpenDialog: null,
  getFilesInFolder: [],
  msgOpenFile: null,
  'get-screenshot': null,
  'delete-screenshot': false,
  askExtensionStatus: false,
  maximizeOrUnmaximize: false,
  'plugin-comment': { code: 404, data: null },
  'plugin-intelligence': null
}

export async function invokeChannel(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = invokeHandlers[channel]
  if (handler) return await handler(args)

  // 本地扫描：桌面版会检查路径存在性，浏览器拿不到本地目录，统一判定为不存在
  if (channel === 'msgCheckFileExist') {
    const dirs = Array.isArray(args[0]) ? args[0] : []
    return dirs.map((path) => ({ path, exist: false }))
  }

  if (Object.prototype.hasOwnProperty.call(invokeFallbacks, channel)) {
    console.debug(`[mainApi] 桌面专用通道，返回默认值: ${channel}`)
    return invokeFallbacks[channel]
  }

  console.debug(`[mainApi] invoke 未映射的通道，返回 null: ${channel}`)
  return null
}

// ── send：真实映射的通道 ────────────────────────────────────────

function postUserSettings(channel: string, payload: unknown): void {
  if (!payload) return
  void apiFetch(API.me.settings, { method: 'POST', body: payload }).catch((err) => {
    console.debug(`[mainApi] ${channel} 保存失败:`, (err as Error)?.message ?? err)
  })
}

const sendHandlers: Record<string, (args: unknown[]) => void> = {
  msgOpenExternalLink: (args) => {
    const url = args[0]
    if (typeof url === 'string' && url) window.open(url, '_blank', 'noopener,noreferrer')
  },

  setStoreSettings: (args) => postUserSettings('setStoreSettings', asRecord(args[0])),

  /** 桌面版触发主进程扫描本地目录；Web 版触发服务器端扫描 */
  msgScanLocalMusic: () => {
    void apiFetch(API.library.scan, { method: 'POST', body: {} }).catch((err) =>
      console.warn('[mainApi] 触发服务器扫描失败:', err)
    )
  },

  'set-source-priority': (args) => {
    const payload = asRecord(args[0])
    if (!payload) return
    void apiFetch(API.plugins.sourcePriority, { method: 'PUT', body: payload }).catch((err) => {
      console.debug('[mainApi] set-source-priority 保存失败:', (err as Error)?.message ?? err)
    })
  },

  setPluginEnable: (args) => {
    const payload = asRecord(args[0])
    if (!payload) return
    void apiFetch(API.plugins.list, { method: 'PATCH', body: payload }).catch((err) => {
      console.debug('[mainApi] setPluginEnable 保存失败:', (err as Error)?.message ?? err)
    })
  },

  // 桌面版送给 MPRIS / 托盘；浏览器版没有宿主可对接，记录后忽略
  metadata: () => {
    console.debug('[mainApi] metadata 在 Web 版无对接宿主（MPRIS/托盘），已忽略')
  }
}

export function sendChannel(channel: string, ...args: unknown[]): void {
  const handler = sendHandlers[channel]
  if (!handler) {
    console.debug(`[mainApi] send 未映射的通道，已忽略: ${channel}`)
    return
  }
  try {
    handler(args)
  } catch (err) {
    console.debug(`[mainApi] send 处理失败 (${channel}):`, (err as Error)?.message ?? err)
  }
}

// ── 安装 ────────────────────────────────────────────────────────

export const mainApi: MainApi = {
  send(channel: string, ...data: unknown[]): void {
    sendChannel(channel, ...data)
  },
  on(channel: string, listener: MainApiListener): void {
    addListener(channel, listener)
  },
  once(channel: string, listener: MainApiListener): void {
    addOnceListener(channel, listener)
  },
  off(channel: string, listener: MainApiListener): void {
    removeListener(channel, listener)
  },
  invoke(channel: string, ...data: unknown[]): Promise<unknown> {
    return invokeChannel(channel, ...data)
  }
}

// 全局类型由渲染层 main.ts 声明，此处不重复声明以免类型冲突
const globals = window as unknown as { mainApi?: MainApi }
globals.mainApi = mainApi
