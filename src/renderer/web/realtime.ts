/**
 * 实时通道：连接服务端的 /ws，接收播放状态推送（服务端是唯一播放端）。
 *
 * - 指数退避重连（上限 30s，带抖动）；未登录被服务端关闭时停止重连，等登录事件（vw:auth-changed）后再连。
 * - 对外暴露订阅回调；同时把 playback:state 经 mainApi 派发成本地事件 'playback-state'，
 *   让既有渲染层可以用 window.mainApi.on('playback-state', ...) 订阅。
 */
import { WS_PATH, type PlaybackState, type RealtimeMessage } from '../../../web/shared/contract.ts'
import { dispatchRendererEvent } from './mainApi.ts'

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'closed'

export type RealtimeListener = (message: RealtimeMessage) => void
export type PlaybackStateListener = (state: PlaybackState) => void
export type RealtimeStatusListener = (status: RealtimeStatus) => void

const listeners = new Set<RealtimeListener>()
const playbackListeners = new Set<PlaybackStateListener>()
const statusListeners = new Set<RealtimeStatusListener>()

let socket: WebSocket | null = null
let status: RealtimeStatus = 'idle'
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
/** 主动停止（或服务端判定未登录）后不再自动重连 */
let stopped = false

function setStatus(next: RealtimeStatus): void {
  status = next
  for (const listener of [...statusListeners]) {
    try {
      listener(next)
    } catch (err) {
      console.error('[realtime] 状态监听器执行失败:', err)
    }
  }
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function startPing(): void {
  stopPing()
  // 服务端支持 { type: 'ping' } → pong，用于保活并尽早发现半开连接
  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
  }, 25000)
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return
  const delay = Math.min(30000, 500 * 1.7 ** attempt) + Math.random() * 250
  attempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, delay)
}

function handleMessage(raw: unknown): void {
  if (typeof raw !== 'string') return
  let message: RealtimeMessage
  try {
    message = JSON.parse(raw) as RealtimeMessage
  } catch {
    return
  }
  if (!message || typeof message !== 'object') return

  // 服务端在未认证时发 error 后立即关闭连接，此时重连没有意义
  if (message.type === 'error' && message.error === 'UNAUTHENTICATED') {
    stopped = true
    setStatus('closed')
    return
  }

  for (const listener of [...listeners]) {
    try {
      listener(message)
    } catch (err) {
      console.error('[realtime] 消息监听器执行失败:', err)
    }
  }

  if (message.type === 'playback:state') {
    dispatchRendererEvent('playback-state', message.state)
    for (const listener of [...playbackListeners]) {
      try {
        listener(message.state)
      } catch (err) {
        console.error('[realtime] 播放状态监听器执行失败:', err)
      }
    }
  }
}

function openSocket(): void {
  if (stopped) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${location.host}${WS_PATH}`
  setStatus('connecting')

  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch (err) {
    console.debug('[realtime] 建立连接失败:', (err as Error)?.message ?? err)
    setStatus('closed')
    scheduleReconnect()
    return
  }

  socket = ws
  ws.addEventListener('open', () => {
    attempt = 0
    setStatus('open')
    startPing()
  })
  ws.addEventListener('message', (event) => handleMessage(event.data))
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    stopPing()
    setStatus('closed')
    scheduleReconnect()
  })
  ws.addEventListener('error', () => {
    // 具体原因由随后的 close 事件处理，这里只记录
    console.debug('[realtime] 连接出错')
  })
}

export function startRealtime(): void {
  stopped = false
  attempt = 0
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  openSocket()
}

export function stopRealtime(): void {
  stopped = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopPing()
  const current = socket
  socket = null
  if (current) {
    try {
      current.close()
    } catch {
      /* 忽略 */
    }
  }
  setStatus('closed')
}

export function subscribeRealtime(listener: RealtimeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function onPlaybackState(listener: PlaybackStateListener): () => void {
  playbackListeners.add(listener)
  return () => playbackListeners.delete(listener)
}

/** 订阅时会立刻回调一次当前状态，便于调用方同步初始化 */
export function onRealtimeStatus(listener: RealtimeStatusListener): () => void {
  statusListeners.add(listener)
  listener(status)
  return () => statusListeners.delete(listener)
}

// 登录后立刻重连（此前若因未登录被服务端断开，会一直停在这里）
window.addEventListener('vw:auth-changed', () => {
  if (stopped) startRealtime()
})
