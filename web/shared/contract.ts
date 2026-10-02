/**
 * Web 版与前端共享的接口契约。
 * 客户端 shim（src/renderer/web/*）与服务端路由必须共同遵守此处定义的结构；
 * 修改本文件需要同步两侧实现。
 */

/** 稳定的曲目标识：由插件返回的 id/hash 与插件自身组成，宿主只做拼接不做解析 */
export interface PlaybackTrack {
  key: string
  pluginId: string
  instanceId?: string
  title: string
  artist: string
  album?: string
  durationMs: number
  picUrl?: string
  /** 插件私有上下文，原样透传，宿主与前端都不得解析其字段 */
  sourceContext: unknown
  /** 宿主签发的可播放地址（/api/media/<token>）；为空表示当前无法播放 */
  mediaUrl?: string
  /** 该曲目无法播放时的原因，便于前端提示 */
  mediaError?: string
}

/** 前端提交曲目时可省略宿主生成的 key */
export type PlaybackTrackInput = Omit<PlaybackTrack, 'key'> & { key?: string }

export type RepeatMode = 'list' | 'one' | 'shuffle'

export interface PlaybackState {
  /** 单调递增序号，客户端据此丢弃乱序消息 */
  seq: number
  playing: boolean
  /** 0..1 */
  volume: number
  muted: boolean
  repeatMode: RepeatMode
  /** positionMs 对应的服务端时间戳（epoch ms），客户端据此推算实时位置 */
  updatedAt: number
  positionMs: number
  durationMs: number
  track: PlaybackTrack | null
  index: number
  queue: PlaybackTrack[]
  /** 最近一次发出控制命令的用户 */
  controlledBy?: { id: string; name: string }
  output: {
    driver: 'mpv' | 'ffplay' | 'none'
    ready: boolean
    error?: string
  }
}

export type PlaybackAction =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'toggle' }
  | { action: 'next' }
  | { action: 'previous' }
  | { action: 'seek'; positionMs: number }
  | { action: 'volume'; volume: number }
  | { action: 'mute'; muted: boolean }
  | { action: 'repeat'; mode: RepeatMode }
  | { action: 'play-now'; track: PlaybackTrackInput }
  | {
      action: 'queue-add'
      tracks: PlaybackTrackInput[]
      /** true = 插到当前曲目之后（下一首）；position 优先于 next */
      next?: boolean
      /** 指定插入下标（0..队列长度），用于多端点歌保持先来先播的顺序 */
      position?: number
    }
  /** 原子替换队列并从指定下标开始播放（对应界面上的「播放整个列表」） */
  | { action: 'queue-set'; tracks: PlaybackTrackInput[]; index: number; autoplay?: boolean }
  | { action: 'queue-remove'; index: number }
  | { action: 'queue-clear' }
  | { action: 'queue-move'; from: number; to: number }

/** WebSocket 服务端 → 客户端消息 */
export type RealtimeMessage =
  | { type: 'hello'; userId: string; clientId: number }
  | { type: 'pong'; at: number }
  | { type: 'playback:state'; state: PlaybackState; reason?: string }
  | { type: 'error'; error: string; message?: string }

export interface ApiError {
  error: string
  message?: string
}

export const API = {
  health: '/api/health',
  auth: {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    me: '/api/auth/me',
    password: '/api/auth/password',
    profile: '/api/auth/profile'
  },
  admin: {
    users: '/api/admin/users',
    user: (id: string) => `/api/admin/users/${id}`,
    userPassword: (id: string) => `/api/admin/users/${id}/password`
  },
  playback: {
    state: '/api/playback/state',
    command: '/api/playback/command'
  },
  media: {
    /** 由媒体令牌注册表签发 */
    stream: (token: string) => `/api/media/${token}`
  },
  plugins: {
    list: '/api/plugins',
    call: (instanceId: string) => `/api/plugins/${encodeURIComponent(instanceId)}/call`,
    lyric: (instanceId: string) => `/api/plugins/${encodeURIComponent(instanceId)}/lyric`,
    songUrl: (instanceId: string) => `/api/plugins/${encodeURIComponent(instanceId)}/song-url`,
    enable: (instanceId: string) => `/api/plugins/${encodeURIComponent(instanceId)}/enable`,
    instances: '/api/plugins/instances',
    sourcePriority: '/api/plugins/source-priority'
  },
  library: {
    roots: '/api/library/roots',
    scan: '/api/library/scan',
    tracks: '/api/library/tracks',
    track: (id: string) => `/api/library/tracks/${id}`,
    album: (name: string) => `/api/library/albums/${encodeURIComponent(name)}`,
    artist: (name: string) => `/api/library/artists/${encodeURIComponent(name)}`
  },
  me: {
    favorites: '/api/me/favorites',
    favorite: (key: string) => `/api/me/favorites/${encodeURIComponent(key)}`,
    playlists: '/api/me/playlists',
    playlist: (id: string) => `/api/me/playlists/${id}`,
    playlistTracks: (id: string) => `/api/me/playlists/${id}/tracks`,
    settings: '/api/me/settings'
  }
} as const

/** WebSocket 路径 */
export const WS_PATH = '/ws'
