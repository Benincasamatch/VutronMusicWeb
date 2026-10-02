/** 插件宿主内部共享类型 */
import type { PluginCapabilities } from '../../../src/types/schemas.ts'

export type MusicType = 'local' | 'library' | 'stream'

/** 插件 exports.meta 的形态（字段由插件自定，宿主只读取已知字段） */
export interface PluginMeta {
  name?: string
  icon?: string
  type?: MusicType
  capabilities?: PluginCapabilities
  [key: string]: unknown
}

/** plugin_instances 行 */
export interface InstanceRow {
  id: string
  plugin_id: string
  owner_user_id: string | null
  name: string | null
  type: string | null
  built_in: number
  enabled: number
  created_at: number
  updated_at: number
}

/** 返回给前端 / 路由使用的实例信息（绝不含凭据与服务器路径） */
export interface PluginInstanceInfo {
  id: string
  pluginId: string
  name: string
  icon: string
  type: MusicType | null
  capabilities: PluginCapabilities | null
  builtIn: boolean
  enabled: boolean
  ownerUserId: string | null
  /** 缓存的登录状态，未探测过为 unknown */
  loginStatus: LoginStatus
  /** 该实例是否已保存过插件状态（凭据/配置） */
  configured: boolean
  loaded: boolean
  loadError: string | null
}

export type LoginStatus = 'unknown' | 'logout' | 'login' | 'offline'

/** 插件可用实现（可被实例化的插件文件） */
export interface PluginSourceInfo {
  id: string
  name: string
  type: MusicType | null
  builtIn: boolean
}

/** 与桌面版 pluginDbGet('Track') 对齐的行结构 */
export interface TrackRow {
  id: string
  name: string
  duration: number
  albumId: string
  albumName: string
  artists: { id: string; name: string }[]
  albumArtists: { id: string; name: string }[]
  filePath: string
  size: number
  md5: string
  cueOffset: number
  cueDuration: number
  picUrl: string
  playCount: number
  liked: number
  createTime: number
  no: number
  alias: string
}

export interface AlbumRow {
  id: string
  name: string
  picUrl: string
  trackCount: number
  subscribed: boolean
}

export interface ArtistRow {
  id: string
  name: string
  followed: boolean
}
