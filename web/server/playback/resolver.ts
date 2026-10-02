/**
 * 媒体解析钩子：播放引擎在需要把「插件曲目」变成可播放地址时调用此处注册的实现。
 * 实现由插件宿主（server/plugins）在启动时注入，避免播放引擎直接依赖插件层。
 */
import type { PlaybackTrack } from '../../shared/contract.ts'

export interface ResolveResult {
  mediaUrl?: string
  error?: string
}

export type MediaResolver = (track: PlaybackTrack, userId: string | null) => Promise<ResolveResult>

let resolver: MediaResolver | null = null

export function setMediaResolver(fn: MediaResolver | null): void {
  resolver = fn
}

export function hasMediaResolver(): boolean {
  return resolver !== null
}

export async function resolveTrackMedia(
  track: PlaybackTrack,
  userId: string | null
): Promise<ResolveResult> {
  if (track.mediaUrl) return { mediaUrl: track.mediaUrl }
  if (!resolver) return { error: '媒体解析器未注册' }
  try {
    return await resolver(track, userId)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
