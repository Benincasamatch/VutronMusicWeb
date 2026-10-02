/**
 * 服务器播放镜像（Web 版专用）。
 *
 * 背景：Web 版按「服务器与浏览器同步出声 + 授权用户共同控制」运行，服务器持有唯一权威播放状态。
 * 本模块做三件事：
 * 1）把 WS 推送的 playback:state 应用到本地播放器（换曲、播放/暂停、位置对齐、漂移校正）；
 * 2）把本地用户操作翻译成服务器命令（播放/暂停、拖动进度、音量、播放整个列表）；
 * 3）用 applying 标志隔离「服务器驱动」与「本地发起」，避免回环。
 *
 * 已知边界（不做静默兜底，明确记录）：
 * - 不镜像循环/随机模式（桌面版 repeatMode 语义与服务器 'list'|'one'|'shuffle' 不完全对应）；
 * - CUE 分轨曲目的位置以分轨相对秒计，与服务器绝对位置存在偏移，暂不对齐；
 * - 队列元数据经插件 getTrackDetail 批量解析，解析失败的曲目以占位标题入队。
 */
import { watch } from 'vue'
import { usePlayerStore } from '../store/player.ts'
import { onPlaybackState, subscribeRealtime } from './realtime.ts'
import { apiFetch } from './http.ts'
import { API, type PlaybackState, type PlaybackTrackInput } from '../../../web/shared/contract.ts'

interface SourceTrack {
  pluginId?: string
  name?: string
  duration?: number
  sourceContext?: unknown
  artists?: { name?: string }[]
  album?: { name?: string }
  picUrl?: string
}

const DRIFT_HARD_SEEK_SEC = 2
const DRIFT_DEAD_ZONE_SEC = 0.12
const SEEK_JUMP_SEC = 3
const LIST_PUSH_GRACE_MS = 3000
const DETAIL_BATCH = 50
/** 换曲后这段时间内的进度跳变视为重载导致，不作为用户 seek 上报 */
const LOAD_SETTLE_MS = 2500
/** 播放/暂停上报去抖窗口 */
const PLAYING_DEBOUNCE_MS = 250

/** 诊断开关：在浏览器控制台执行 localStorage.setItem('vw-mirror-debug','1') 后刷新即可看到镜像决策日志 */
const DEBUG = (() => {
  try {
    return window.localStorage.getItem('vw-mirror-debug') === '1'
  } catch {
    return false
  }
})()

function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log('[web-mirror]', ...args)
}

let applying = false
let serverState: PlaybackState | null = null
let serverTrackKey: string | null = null
let lastListPushAt = 0
let lastProgress = 0
/** 最近一次应用服务器状态的时刻：换曲/重载期间本地进度会跳变，不能当成用户拖动进度条 */
let lastApplyAt = 0
let playingTimer: number | undefined
let driftTimer: number | undefined
/** playNextList 中已推送给服务端的条数（用于区分新增项，并保持先来先播） */
let lastPlayNextCount = 0
/** 上一次同步到本地的服务器队列指纹，避免重复赋值触发无谓刷新 */
let lastQueueSignature = ''

function identityOf(pluginId: string | undefined, sourceContext: unknown): string {
  return `${pluginId ?? ''}::${JSON.stringify(sourceContext ?? null)}`
}

function currentTargetMs(state: PlaybackState): number {
  if (!state.playing) return state.positionMs
  return state.positionMs + Math.max(0, Date.now() - state.updatedAt)
}

async function sendCommand(payload: Record<string, unknown>): Promise<void> {
  try {
    debugLog('发送命令', payload.action, payload.track ? { title: (payload.track as { title?: string }).title } : (payload.tracks ? { count: (payload.tracks as unknown[]).length, index: payload.index } : ''))
    await apiFetch(API.playback.command, { method: 'POST', body: payload })
  } catch (err) {
    console.warn('[web-mirror] 播放命令失败:', payload.action, err)
  }
}

/**
 * 插件返回的时长单位并不统一：本地插件是秒（4.048），网易云是毫秒（278961）。
 * 按量级判定：>= 1000 视为毫秒，否则视为秒。判错的窗口只影响 17 分钟以上的秒值，
 * 且服务端会用 mpv 回报的真实时长覆盖，不会影响播放推进。
 */
function durationToMs(raw: number | undefined): number {
  const value = Number(raw ?? 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value >= 1000 ? value : value * 1000)
}

function toTrackInput(track: SourceTrack): PlaybackTrackInput {
  return {
    pluginId: track.pluginId ?? '',
    title: track.name ?? '未知曲目',
    artist: track.artists?.[0]?.name ?? '',
    album: track.album?.name,
    durationMs: durationToMs(track.duration),
    picUrl: track.picUrl,
    sourceContext: track.sourceContext ?? null
  }
}

/** 用插件 getTrackDetail 批量补全队列元数据；失败时退回占位标题，不解析 sourceContext。 */
async function resolveListMetadata(
  list: [string, Record<string, unknown>][]
): Promise<PlaybackTrackInput[]> {
  const out: PlaybackTrackInput[] = list.map(([pluginId, sourceContext]) => ({
    pluginId,
    title: '未知曲目',
    artist: '',
    durationMs: 0,
    sourceContext
  }))

  const groups = new Map<string, number[]>()
  list.forEach(([pluginId], index) => {
    const bucket = groups.get(pluginId)
    if (bucket) bucket.push(index)
    else groups.set(pluginId, [index])
  })

  for (const [pluginId, indexes] of groups) {
    for (let start = 0; start < indexes.length; start += DETAIL_BATCH) {
      const slice = indexes.slice(start, start + DETAIL_BATCH)
      try {
        const res = await apiFetch<{ data?: SourceTrack[] }>(API.plugins.call(pluginId), {
          method: 'POST',
          body: {
            method: 'getTrackDetail',
            params: { tracks: slice.map((i) => list[i][1]) }
          }
        })
        slice.forEach((listIndex, i) => {
          const detail = res?.data?.[i]
          if (!detail) return
          out[listIndex] = { ...toTrackInput({ ...detail, pluginId }), sourceContext: list[listIndex][1] }
        })
      } catch (err) {
        console.warn('[web-mirror] 队列元数据解析失败:', pluginId, err)
      }
    }
  }
  return out
}

async function pushQueueSet(
  list: [string, Record<string, unknown>][],
  index?: number
): Promise<void> {
  if (list.length === 0) return
  const player = usePlayerStore()
  const target = index === undefined ? Math.max(0, player.currentTrackIndex) : index
  lastListPushAt = Date.now()
  const tracks = await resolveListMetadata(list)
  await sendCommand({ action: 'queue-set', tracks, index: target, autoplay: player.playing })
}

function queueIndexOf(state: PlaybackState, track: SourceTrack): number {
  const identity = identityOf(track.pluginId, track.sourceContext)
  return state.queue.findIndex((item) => identityOf(item.pluginId, item.sourceContext) === identity)
}

/**
 * 把「加入待播队列」翻译成服务端 queue-add。
 * 插入位置 = 当前下标 + 1 + 已排队但尚未播放的条数，保证多端点歌先来先播；
 * 不用 play-now —— 那会在队列里插副本并把播放下标前移，是之前"跳切"的根因。
 */
async function pushEnqueue(items: [string, Record<string, unknown>][]): Promise<void> {
  if (items.length === 0) return
  const state = serverState
  const player = usePlayerStore()
  if (!state) {
    debugLog('服务器状态未知，暂不排队:', items.length, '首')
    return
  }
  const pendingBefore = Math.max(0, (player.playNextList?.length ?? 0) - items.length)
  const position = Math.max(0, state.index + 1 + pendingBefore)
  const tracks = await resolveListMetadata(items)
  await sendCommand({ action: 'queue-add', tracks, position })
}

async function handleLocalTrackChange(track: SourceTrack): Promise<void> {
  debugLog('本地换曲', track.name, '距上次列表推送', Date.now() - lastListPushAt, 'ms')
  if (Date.now() - lastListPushAt < LIST_PUSH_GRACE_MS) return
  // 服务器驱动的装载（以及随后的媒体重试、预取）也会改本地曲目，这段时间内不作为本地意图上报
  if (Date.now() - lastApplyAt < LOAD_SETTLE_MS) return

  const state = serverState
  const player = usePlayerStore()
  const identity = identityOf(track.pluginId, track.sourceContext)
  const list = (player.playList ?? []) as [string, Record<string, unknown>][]

  if (!state || state.queue.length === 0) {
    // 服务器还没有队列：只把整份列表推过去，绝不发 play-now（会插副本）
    if (list.length > 0) await pushQueueSet(list, Math.max(0, player.currentTrackIndex))
    return
  }
  if (state.track && identity === identityOf(state.track.pluginId, state.track.sourceContext)) return

  const size = state.queue.length
  const target = queueIndexOf(state, track)
  if (target >= 0 && target === (state.index + 1) % size && state.repeatMode !== 'one') {
    await sendCommand({ action: 'next' })
    return
  }
  if (target >= 0 && target === (state.index - 1 + size) % size) {
    await sendCommand({ action: 'previous' })
    return
  }

  // 任意跳转：以浏览器当前列表为准整体替换
  if (list.length > 0) {
    await pushQueueSet(list, Math.max(0, player.currentTrackIndex))
    return
  }
  // 与服务器队列对不上又没有本地列表：属于新客户端接入服务器的会话，不能改动共享队列与播放态
  debugLog('本地曲目不在服务器队列且无本地列表，忽略:', track.name)
}

/** 服务器播到某条已排队的请求后，把本地那条移除，避免待播队列里重复展示 */
function pruneConsumedEnqueues(state: PlaybackState): void {
  if (!state.track) return
  const player = usePlayerStore()
  const current = identityOf(state.track.pluginId, state.track.sourceContext)
  while (player.playNextList.length > 0) {
    const head = player.playNextList[0]
    if (identityOf(head[0], head[1]) !== current) break
    player.playNextList.shift()
    lastPlayNextCount = Math.max(0, lastPlayNextCount - 1)
  }
}

/**
 * 浏览器自然播完：曲目推进交给服务器。
 * 这里只把本地播放态标记为已停止（并抑制由此产生的命令），服务器推进后会推送下一首，
 * 由 applyState 重新加载并播放。浏览器绝不自行播放下一首。
 */
export function onLocalTrackEnded(): void {
  const player = usePlayerStore()
  applying = true
  try {
    player.isEnd = true
    player.playing = false
  } finally {
    queueMicrotask(() => {
      applying = false
    })
  }
}

/** 本地媒体反复失败时，请服务器切歌（而不是浏览器自己推进） */
export function requestServerNext(): void {
  void sendCommand({ action: 'next' })
}

function syncDrift(): void {
  if (applying || !serverState || !serverState.playing) return
  const player = usePlayerStore()
  if (!player.playing) return
  const drift = player.progress - currentTargetMs(serverState) / 1000
  if (Math.abs(drift) > DRIFT_HARD_SEEK_SEC) {
    player.seek = currentTargetMs(serverState) / 1000
    player.playbackRate = 1
    return
  }
  if (Math.abs(drift) > DRIFT_DEAD_ZONE_SEC) {
    // 领先则放慢，落后则加快，限制在 ±2% 以内避免可闻的音高变化
    player.playbackRate = Math.min(1.02, Math.max(0.98, 1 - drift * 0.25))
    return
  }
  player.playbackRate = 1
}

async function applyState(state: PlaybackState): Promise<void> {
  serverState = state
  debugLog('收到状态', state.seq, state.track?.title ?? '-', 'idx=' + state.index, 'queue=' + state.queue.length)
  const player = usePlayerStore()

  if (!state.track) {
    serverTrackKey = null
    return
  }

  applying = true
  try {
    const sameTrack =
      serverTrackKey === state.track.key ||
      identityOf(player.currentTrack?.pluginId, player.currentTrack?.sourceContext) ===
        identityOf(state.track.pluginId, state.track.sourceContext)

    debugLog('判定明细', {
      keyEqual: serverTrackKey === state.track.key,
      ctxEqual:
        identityOf(player.currentTrack?.pluginId, player.currentTrack?.sourceContext) ===
        identityOf(state.track.pluginId, state.track.sourceContext),
      sameTrack,
      localName: player.currentTrack?.name,
      serverName: state.track.title,
      localPlugin: player.currentTrack?.pluginId,
      serverPlugin: state.track.pluginId,
      serverTrackKey,
      stateKey: state.track.key
    })
    if (!sameTrack) {
      serverTrackKey = state.track.key
      await player.replaceCurrentTrack(state.track.pluginId, (state.track.sourceContext ?? {}) as Record<string, unknown>, false)
    } else {
      serverTrackKey = state.track.key
    }
    // 新客户端接入服务器正在播放的会话时，本地还没有播放器状态，这里补上，否则界面不显示播放栏
    if (!player.enabled) player.enabled = true
    pruneConsumedEnqueues(state)

    // 本地队列视图始终等于服务器队列：待播队列（NextUp 的后续队列）、列表高亮与下标都以它为准，
    // 否则接入端与操作端的队列会长期失配。赋值发生在 applying 窗口内，不会触发回环。
    const signature = state.queue.map((item) => item.key).join(',') + '#' + state.index
    if (signature !== lastQueueSignature) {
      lastQueueSignature = signature
      player.playList = state.queue.map((item) => [
        item.pluginId,
        (item.sourceContext ?? {}) as Record<string, unknown>
      ])
      player.currentTrackIndex = Math.max(0, state.index)
    }

    const targetSec = currentTargetMs(state) / 1000
    const drift = Math.abs(player.progress - targetSec)
    if (!sameTrack || drift > DRIFT_HARD_SEEK_SEC) player.seek = targetSec

    if (player.playing !== state.playing) await player.playOrPause()
    if (Math.abs(player.volume - state.volume) > 0.01) player.volume = state.volume
  } catch (err) {
    console.warn('[web-mirror] 应用服务器播放状态失败:', err)
  } finally {
    lastApplyAt = Date.now()
    applying = false
  }
}

/** 挂载后调用：订阅服务器状态并安装本地意图监听 */
export function startServerMirror(): void {
  const player = usePlayerStore()

  if (DEBUG) {
    subscribeRealtime((msg) => {
      if (msg.type === 'playback:state') {
        debugLog('推送 reason=' + (msg.reason ?? '-'), 'seq=' + msg.state.seq, msg.state.track?.title ?? '-', 'playing=' + msg.state.playing)
      }
    })
  }

  onPlaybackState((state) => {
    void applyState(state)
  })

  // 本地换曲 → 翻译成服务器命令。
  // 关键：不要一律发 play-now。play-now 会在服务器队列里插入副本，导致队列不断增长、
  // 下标与列表错位，表现出来就是"错误切歌"。因此按语义区分：
  //   落在服务器队列的下一首/上一首 → 直接发 next/previous（服务器自会推进，队列不膨胀）；
  //   任意跳转 → 用整列表 + 下标原子替换队列；
  //   服务器还没有队列 → 用 play-now 起播。
  watch(
    () => player.currentTrack,
    (track) => {
      if (applying || !track) return
      void handleLocalTrackChange(track as SourceTrack)
    },
    { flush: 'sync' }
  )

  // 加入待播队列（单击添加 / 右键“添加至队列” / “下一首播放”）→ 服务端 queue-add
  // “下一首播放”会紧接着触发本地换曲，由下面的 currentTrack 监听映射成 next，最终同样落在服务器队列里
  watch(
    () => player.playNextList,
    (list) => {
      if (applying || !list) return
      const count = list.length
      if (count <= lastPlayNextCount) {
        lastPlayNextCount = count
        return
      }
      const added = list.slice(lastPlayNextCount) as [string, Record<string, unknown>][]
      lastPlayNextCount = count
      void pushEnqueue(added)
    },
    { flush: 'sync' }
  )

  // 整列表播放 → 原子替换服务器队列并同步下标
  watch(
    () => player.playList,
    (list) => {
      if (applying || !list || list.length === 0) return
      void pushQueueSet(list as [string, Record<string, unknown>][])
    },
    { flush: 'sync' }
  )

  // 播放/暂停去抖：换曲时本地播放态会瞬时抖动（加载前后 false→true），
  // 立即上报会在服务器上产生一次多余的 pause 再 play；等状态稳定 250ms 再发。
  watch(
    () => player.playing,
    (playing) => {
      if (applying) return
      // 装载/换曲期间本地播放态会先 false 后 true，这段时间内不上报，避免误发 pause 把会话停掉
      if (Date.now() - lastApplyAt < LOAD_SETTLE_MS) return
      if (playingTimer !== undefined) window.clearTimeout(playingTimer)
      playingTimer = window.setTimeout(() => {
        playingTimer = undefined
        void sendCommand({ action: playing ? 'play' : 'pause' })
      }, PLAYING_DEBOUNCE_MS)
    },
    { flush: 'sync' }
  )

  watch(
    () => player.volume,
    (volume) => {
      if (applying) return
      void sendCommand({ action: 'volume', volume })
    },
    { flush: 'sync' }
  )

  // 拖动进度条：本地进度出现远超自然播放的跳变即视为 seek
  watch(
    () => player.progress,
    (progress) => {
      const jump = Math.abs(progress - lastProgress)
      lastProgress = progress
      if (applying || !serverState) return
      // 换曲/重载/重试会在本地产生大幅位置跳变（重设 src 后重新定位），只有明显晚于这些操作的跳变才算用户拖动
      if (Date.now() - lastApplyAt < LOAD_SETTLE_MS) return
      if (jump <= SEEK_JUMP_SEC) return
      // 事件循环卡顿会让一次 timeupdate 的间隔超过阈值，此时本地位置仍与服务器一致，不能当成拖动；
      // 只有跳变后与服务器期望位置相差同样多，才说明用户确实拖到了别处。
      const targetSec = currentTargetMs(serverState) / 1000
      if (Math.abs(progress - targetSec) <= SEEK_JUMP_SEC) return
      void sendCommand({ action: 'seek', positionMs: Math.round(progress * 1000) })
    },
    { flush: 'sync' }
  )

  lastProgress = player.progress
  driftTimer = window.setInterval(syncDrift, 1000)
  window.addEventListener('beforeunload', () => {
    if (driftTimer) window.clearInterval(driftTimer)
  })
}
