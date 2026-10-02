/**
 * 服务器权威播放会话（单例）。
 *
 * 设计要点：
 * - 位置以「锚点」表示：{ positionMs, updatedAt, playing }。对外广播时 positionMs 是 updatedAt
 *   时刻的位置，客户端自行按 playing 推算实时位置；服务器每 10s 发一次心跳用于漂移再同步。
 * - 每次状态变更 seq 递增并广播 `playback:state`（带 reason）；mpv 回报的 position/duration
 *   用于校准锚点。
 * - 队列在内存中维护，并节流持久化到 playback_state(scope='global')：结构变化（track/queue/playing）
 *   立即写入，其余 >=1s 写入一次。
 * - 曲目无 mediaUrl 时经 playback/resolver.ts 解析；解析失败标记 mediaError 并跳到下一首，
 *   一轮内全部失败则停止，避免无限跳过。
 * - 所有被授权用户共享同一个服务器播放会话。
 */
import crypto from 'node:crypto'
import { config } from '../config.ts'
import { getDb, jsonParse } from '../db/index.ts'
import { broadcast } from '../realtime.ts'
import { resolveTrackMedia } from './resolver.ts'
import { createOutput, type AudioOutput } from './output.ts'
import type { PlaybackAction, PlaybackState, PlaybackTrack, RepeatMode } from '../../shared/contract.ts'

const SCOPE = 'global'
const HEARTBEAT_MS = 10_000
const PERSIST_THROTTLE_MS = 1_000

type TrackInput = Omit<PlaybackTrack, 'key'> & { key?: string }

export interface ActingUser {
  id: string
  name: string
}

interface Anchor {
  positionMs: number
  updatedAt: number
  playing: boolean
}

interface PersistedState {
  seq: number
  playing: boolean
  volume: number
  muted: boolean
  repeatMode: RepeatMode
  positionMs: number
  updatedAt: number
  durationMs: number
  index: number
  queue: PlaybackTrack[]
  controlledBy?: { id: string; name: string }
}

/** 可预期的命令错误（由路由转成 4xx） */
export class PlaybackError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message)
    this.name = 'PlaybackError'
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

function normalizeTrack(input: TrackInput): PlaybackTrack {
  return {
    key: input.key ?? crypto.randomUUID(),
    pluginId: input.pluginId,
    instanceId: input.instanceId,
    title: input.title,
    artist: input.artist ?? '',
    album: input.album,
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0,
    picUrl: input.picUrl,
    sourceContext: input.sourceContext,
    mediaUrl: input.mediaUrl,
    mediaError: input.mediaError
  }
}

export class PlaybackEngine {
  private output: AudioOutput = createOutput()
  private started = false
  private shuttingDown = false
  private disposed = false

  private seq = 0
  private playing = false
  private volume = clamp01(config.output.volume / 100)
  private muted = false
  private repeatMode: RepeatMode = 'list'
  private durationMs = 0
  private queue: PlaybackTrack[] = []
  private index = -1
  private anchor: Anchor = { positionMs: 0, updatedAt: Date.now(), playing: false }
  private controlledBy?: { id: string; name: string }

  /** 解析媒体时使用的用户（最近一次控制者），供插件层鉴权 */
  private resolveUserId: string | null = null
  /** 本轮自动跳曲中已失败的曲目 key，全部失败后停止 */
  private failed = new Set<string>()
  /** 递增令牌，丢弃过期的异步解析结果 */
  private loadToken = 0

  private heartbeatTimer?: NodeJS.Timeout
  private persistTimer?: NodeJS.Timeout
  private lastPersistAt = 0
  private initPromise?: Promise<void>

  /* ------------------------------ 生命周期 ------------------------------ */

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    if (this.started) return
    this.started = true
    this.restore()
    this.output = createOutput()
    this.output.onExit(() => this.handleOutputExit())
    this.output.onPosition((posMs, durMs) => this.handleOutputPosition(posMs, durMs))
    this.output.onEnd(() => {
      void this.handleTrackEnded()
    })
    this.output.setVolume(this.effectiveVolume())

    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    this.heartbeatTimer.unref?.()

    registerProcessCleanup(this)

    try {
      await this.output.start()
    } catch (err) {
      // output 实现承诺不抛异常，这里只做最后兜底
      console.error('[playback] 输出驱动启动失败:', err)
    }

    if (this.queue[this.index]) {
      // 恢复上次的曲目与位置，但保持暂停，避免服务重启后突然出声
      this.playing = false
      await this.playIndex(this.index, 'restore', this.anchor.positionMs)
    } else {
      this.commit('init')
    }
  }

  /** 释放输出进程与定时器；服务退出时调用 */
  shutdown(): void {
    if (this.disposed) return
    this.disposed = true
    this.shuttingDown = true
    clearInterval(this.heartbeatTimer)
    clearTimeout(this.persistTimer)
    this.heartbeatTimer = undefined
    this.persistTimer = undefined
    this.persistNow()
    try {
      this.output.destroy()
    } catch (err) {
      console.error('[playback] 释放输出驱动失败:', err)
    }
  }

  /* -------------------------------- 命令 -------------------------------- */

  getState(): PlaybackState {
    return this.snapshot()
  }

  async handleAction(action: PlaybackAction, user: ActingUser): Promise<PlaybackState> {
    this.controlledBy = { id: user.id, name: user.name }
    this.resolveUserId = user.id

    switch (action.action) {
      case 'play': {
        if (this.index < 0 && this.queue.length > 0) {
          this.failed.clear()
          this.playing = true
          await this.playIndex(0, 'play')
        } else {
          this.playing = true
          this.output.play()
          this.commit('play', true)
        }
        break
      }
      case 'pause': {
        this.playing = false
        this.output.pause()
        this.commit('pause', true)
        break
      }
      case 'toggle': {
        if (this.playing) {
          this.playing = false
          this.output.pause()
          this.commit('toggle', true)
        } else if (this.index < 0 && this.queue.length > 0) {
          this.failed.clear()
          this.playing = true
          await this.playIndex(0, 'toggle')
        } else {
          this.playing = true
          this.output.play()
          this.commit('toggle', true)
        }
        break
      }
      case 'next': {
        this.failed.clear()
        await this.advance(false, 'next')
        break
      }
      case 'previous': {
        this.failed.clear()
        await this.goPrevious('previous')
        break
      }
      case 'seek': {
        const target = this.clampPosition(action.positionMs)
        this.anchor = { positionMs: target, updatedAt: Date.now(), playing: this.playing }
        this.output.seek(target)
        this.commit('seek')
        break
      }
      case 'volume': {
        this.volume = clamp01(action.volume)
        this.output.setVolume(this.effectiveVolume())
        this.commit('volume')
        break
      }
      case 'mute': {
        this.muted = action.muted
        this.output.setVolume(this.effectiveVolume())
        this.commit('mute')
        break
      }
      case 'repeat': {
        this.repeatMode = action.mode
        this.commit('repeat')
        break
      }
      case 'play-now': {
        await this.playNow(action.track)
        break
      }
      case 'queue-add': {
        const tracks = action.tracks.map(normalizeTrack)
        if (tracks.length === 0) break
        const requested = Number.isFinite(action.position) ? Math.trunc(action.position as number) : null
        if (requested !== null) {
          const at = Math.min(Math.max(0, requested), this.queue.length)
          this.queue.splice(at, 0, ...tracks)
          // 插到当前曲目之前会把正在播放的曲目往后挤，下标必须同步
          if (this.index >= 0 && at <= this.index) this.index += tracks.length
          this.commit('queue-add', true)
          break
        }
        if (action.next && this.index >= 0) this.queue.splice(this.index + 1, 0, ...tracks)
        else this.queue.push(...tracks)
        this.commit('queue-add', true)
        break
      }
      case 'queue-set': {
        const tracks = action.tracks.map(normalizeTrack)
        const maxIndex = Math.max(0, tracks.length - 1)
        const rawIndex = Number.isFinite(action.index) ? Math.trunc(action.index) : 0
        const target = Math.min(Math.max(0, rawIndex), maxIndex)
        this.failed.clear()
        this.loadToken += 1
        this.output.stop()
        this.queue = tracks
        this.durationMs = 0
        if (tracks.length === 0) {
          this.index = -1
          this.playing = false
          this.anchor = { positionMs: 0, updatedAt: Date.now(), playing: false }
          this.commit('queue-set', true)
          break
        }
        this.index = target
        this.playing = action.autoplay !== false
        this.anchor = { positionMs: 0, updatedAt: Date.now(), playing: this.playing }
        await this.playIndex(target, 'queue-set')
        break
      }
      case 'queue-remove': {
        await this.queueRemove(action.index)
        break
      }
      case 'queue-clear': {
        this.queue = []
        this.index = -1
        this.durationMs = 0
        this.failed.clear()
        this.anchor = { positionMs: 0, updatedAt: Date.now(), playing: false }
        this.output.stop()
        this.commit('queue-clear', true)
        break
      }
      case 'queue-move': {
        this.queueMove(action.from, action.to)
        break
      }
    }
    return this.snapshot()
  }

  private async playNow(input: TrackInput): Promise<void> {
    const track = normalizeTrack(input)
    this.failed.clear()
    if (this.index < 0) {
      this.queue.push(track)
      this.index = this.queue.length - 1
    } else {
      this.queue.splice(this.index + 1, 0, track)
      this.index += 1
    }
    this.playing = true
    await this.playIndex(this.index, 'play-now')
  }

  private async queueRemove(target: number): Promise<void> {
    if (!Number.isInteger(target) || target < 0 || target >= this.queue.length) {
      throw new PlaybackError('INVALID_INDEX', `队列下标越界: ${target}`)
    }
    const removingCurrent = target === this.index
    this.queue.splice(target, 1)
    if (this.queue.length === 0) {
      this.index = -1
      this.durationMs = 0
      this.playing = false
      this.anchor = { positionMs: 0, updatedAt: Date.now(), playing: false }
      this.output.stop()
      this.commit('queue-remove', true)
      return
    }
    if (target < this.index) this.index -= 1
    else if (removingCurrent) {
      if (this.index >= this.queue.length) this.index = this.queue.length - 1
      await this.playIndex(this.index, 'queue-remove')
      return
    }
    this.commit('queue-remove', true)
  }

  private queueMove(from: number, to: number): void {
    const n = this.queue.length
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n || to < 0 || to >= n) {
      throw new PlaybackError('INVALID_INDEX', `队列下标越界: from=${from} to=${to}`)
    }
    if (from === to) return
    const [moved] = this.queue.splice(from, 1)
    this.queue.splice(to, 0, moved)
    if (this.index === from) this.index = to
    else if (from < this.index && to >= this.index) this.index -= 1
    else if (from > this.index && to <= this.index) this.index += 1
    this.commit('queue-move', true)
  }

  /* ------------------------------ 曲目推进 ------------------------------ */

  /** 手动/自动切换到下一首（auto=true 时 repeat=one 保持当前曲目） */
  private async advance(auto: boolean, reason: string): Promise<void> {
    const n = this.queue.length
    if (n === 0) return
    if (this.index < 0) {
      this.playing = true
      await this.playIndex(0, reason)
      return
    }
    if (auto && this.repeatMode === 'one') {
      await this.playIndex(this.index, reason)
      return
    }
    await this.playIndex(this.nextIndex(auto), reason)
  }

  private async goPrevious(reason: string): Promise<void> {
    const n = this.queue.length
    if (n === 0) return
    if (this.index < 0) {
      this.playing = true
      await this.playIndex(0, reason)
      return
    }
    await this.playIndex((this.index - 1 + n) % n, reason)
  }

  private nextIndex(auto: boolean): number {
    const n = this.queue.length
    if (n === 0) return -1
    if (auto && this.repeatMode === 'one') return this.index
    if (this.repeatMode === 'shuffle') {
      if (n === 1) return 0
      let candidate = this.index
      while (candidate === this.index) candidate = Math.floor(Math.random() * n)
      return candidate
    }
    return (this.index + 1) % n
  }

  private async handleTrackEnded(): Promise<void> {
    if (!this.playing || this.shuttingDown) return
    const track = this.queue[this.index]
    if (!track) return
    this.failed.clear()
    await this.advance(true, 'ended')
  }

  /**
   * 加载队列中第 index 首曲目。无 mediaUrl 时先解析；解析失败标记 mediaError 并跳过，
   * 一轮内全部失败则停止播放。
   */
  private async playIndex(index: number, reason: string, positionMs = 0): Promise<void> {
    const track = this.queue[index]
    if (!track) return
    const token = ++this.loadToken
    this.index = index
    this.durationMs = track.durationMs || 0

    let mediaUrl = track.mediaUrl
    let error = track.mediaError
    if (!mediaUrl) {
      const resolved = await resolveTrackMedia(track, this.resolveUserId)
      if (token !== this.loadToken) return
      mediaUrl = resolved.mediaUrl
      error = resolved.error
    }

    if (!mediaUrl) {
      this.queue[index] = { ...track, mediaError: error ?? '无法解析媒体地址' }
      this.failed.add(track.key)
      this.anchor = { positionMs: 0, updatedAt: Date.now(), playing: this.playing }
      this.commit('media-error', true)
      await this.skipFailed(index, reason)
      return
    }

    this.failed.clear()
    this.queue[index] = { ...track, mediaUrl, mediaError: undefined }
    this.durationMs = track.durationMs || 0
    this.anchor = { positionMs: Math.max(0, positionMs), updatedAt: Date.now(), playing: this.playing }
    this.output.load(this.toOutputUrl(mediaUrl), { positionMs: this.anchor.positionMs, paused: !this.playing })
    this.commit(reason, true)
  }

  /**
   * 把契约里的 mediaUrl（形如 /api/media/<token>）转成服务器输出进程可抓取的地址。
   * 已是带协议的绝对地址（http/file/...）或裸文件路径时原样透传；相对路径补全本机 origin。
   * track.mediaUrl 本身保持不变，仍按契约广播给浏览器。
   */
  private toOutputUrl(mediaUrl: string): string {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(mediaUrl)) return mediaUrl
    if (mediaUrl.startsWith('/')) return `http://127.0.0.1:${config.port}${mediaUrl}`
    return mediaUrl
  }

  /** 向后扫描未失败的曲目继续播放；全部失败则停止 */
  private async skipFailed(fromIndex: number, reason: string): Promise<void> {
    const n = this.queue.length
    for (let step = 1; step < n; step++) {
      const candidate = (fromIndex + step) % n
      if (!this.failed.has(this.queue[candidate].key)) {
        await this.playIndex(candidate, reason)
        return
      }
    }
    this.playing = false
    this.anchor = { positionMs: 0, updatedAt: Date.now(), playing: false }
    this.output.stop()
    this.commit('media-error-stop', true)
  }

  /* -------------------------------- 输出 -------------------------------- */

  private handleOutputPosition(positionMs: number, durationMs: number): void {
    if (durationMs > 0) this.durationMs = durationMs
    if (!Number.isFinite(positionMs)) return
    this.anchor = { positionMs: this.clampPosition(positionMs), updatedAt: Date.now(), playing: this.playing }
  }

  private handleOutputExit(): void {
    if (this.shuttingDown) return
    this.playing = false
    this.commit('output-exit', true)
  }

  private effectiveVolume(): number {
    return this.muted ? 0 : this.volume
  }

  private clampPosition(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 0
    if (this.durationMs > 0 && value > this.durationMs) return this.durationMs
    return value
  }

  /* ------------------------------ 广播/持久化 ------------------------------ */

  /** 重锚点、递增 seq、广播并（节流）持久化 */
  private commit(reason: string, structural = false): PlaybackState {
    const now = Date.now()
    const positionMs = this.anchor.playing
      ? this.anchor.positionMs + Math.max(0, now - this.anchor.updatedAt)
      : this.anchor.positionMs
    this.anchor = { positionMs: this.clampPosition(positionMs), updatedAt: now, playing: this.playing }
    this.seq += 1

    const state = this.snapshot()
    try {
      broadcast('playback:state', { state, reason })
    } catch (err) {
      console.error('[playback] 广播失败:', err)
    }
    this.schedulePersist(structural)
    return state
  }

  private heartbeat(): void {
    if (this.shuttingDown || !this.playing) return
    this.commit('heartbeat')
  }

  private snapshot(): PlaybackState {
    return {
      seq: this.seq,
      playing: this.playing,
      volume: this.volume,
      muted: this.muted,
      repeatMode: this.repeatMode,
      updatedAt: this.anchor.updatedAt,
      positionMs: this.anchor.positionMs,
      durationMs: this.durationMs,
      track: this.queue[this.index] ?? null,
      index: this.index,
      queue: this.queue.map((t) => ({ ...t })),
      controlledBy: this.controlledBy,
      output: {
        driver: this.output.driver,
        ready: this.output.isReady(),
        error: this.output.getError()
      }
    }
  }

  private serializable(): PersistedState {
    return {
      seq: this.seq,
      playing: this.playing,
      volume: this.volume,
      muted: this.muted,
      repeatMode: this.repeatMode,
      positionMs: this.anchor.positionMs,
      updatedAt: this.anchor.updatedAt,
      durationMs: this.durationMs,
      index: this.index,
      queue: this.queue,
      controlledBy: this.controlledBy
    }
  }

  private schedulePersist(structural: boolean): void {
    const now = Date.now()
    if (structural || now - this.lastPersistAt >= PERSIST_THROTTLE_MS) {
      this.persistNow()
      return
    }
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined
        this.persistNow()
      }, PERSIST_THROTTLE_MS - (now - this.lastPersistAt))
      this.persistTimer.unref?.()
    }
  }

  private persistNow(): void {
    this.lastPersistAt = Date.now()
    try {
      getDb()
        .prepare(
          'INSERT INTO playback_state (scope, state, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(scope) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at'
        )
        .run(SCOPE, JSON.stringify(this.serializable()), this.lastPersistAt)
    } catch (err) {
      console.error('[playback] 持久化播放状态失败:', err)
    }
  }

  private restore(): void {
    let raw: string | undefined
    try {
      const row = getDb().prepare('SELECT state FROM playback_state WHERE scope = ?').get(SCOPE) as
        | { state: string }
        | undefined
      raw = row?.state
    } catch (err) {
      console.error('[playback] 读取持久化播放状态失败:', err)
      return
    }
    const parsed = jsonParse<PersistedState | null>(raw, null)
    if (!parsed || typeof parsed !== 'object') return

    this.seq = Number.isFinite(parsed.seq) ? parsed.seq : 0
    this.volume = clamp01(Number.isFinite(parsed.volume) ? parsed.volume : this.volume)
    this.muted = parsed.muted === true
    this.repeatMode = parsed.repeatMode === 'one' || parsed.repeatMode === 'shuffle' ? parsed.repeatMode : 'list'
    this.playing = false
    this.durationMs = Number.isFinite(parsed.durationMs) ? Math.max(0, parsed.durationMs) : 0
    this.controlledBy = parsed.controlledBy
    this.queue = Array.isArray(parsed.queue)
      ? parsed.queue.filter((t) => t && typeof t === 'object').map((t) => normalizeTrack(t as TrackInput))
      : []
    this.index =
      Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < this.queue.length ? parsed.index : -1
    this.anchor = {
      positionMs: Number.isFinite(parsed.positionMs) ? Math.max(0, parsed.positionMs) : 0,
      updatedAt: Date.now(),
      playing: false
    }
  }
}

/* ------------------------------ 单例与清理 ------------------------------ */

let engine: PlaybackEngine | null = null

export function initPlayback(): PlaybackEngine {
  if (!engine) engine = new PlaybackEngine()
  void engine.init()
  return engine
}

export function getEngine(): PlaybackEngine {
  if (!engine) return initPlayback()
  return engine
}

let cleanupRegistered = false

/** 服务进程退出时释放输出进程（只注册一次，不改变各信号默认退出行为） */
function registerProcessCleanup(target: PlaybackEngine): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once('exit', () => {
    try {
      target.shutdown()
    } catch {
      /* 退出阶段不再抛错 */
    }
  })
}
