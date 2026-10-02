/**
 * 播放地址解析：把插件 songUrl 返回的地址（可能是 http(s)、vutron://local-asset、
 * vutron://get-plugin-asset）解析成媒体令牌层可登记的 MediaSource。
 *
 * 说明：只解释 URL 本身（协议/查询串），不解析 sourceContext，也不把上游地址/凭据回传给前端。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { MediaSource } from '../media/tokens.ts'
import { getDb } from '../db/index.ts'
import { config } from '../config.ts'

export type ResolveUrlResult = { source: MediaSource } | { error: string }

/** 只依赖 call 方法，避免与 host.ts 形成运行时循环依赖 */
export interface PluginCaller {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
}

function lookupLocalFile(id: string | null, explicitPath: string | null): string | null {
  if (explicitPath) {
    try {
      return decodeURIComponent(explicitPath)
    } catch {
      return explicitPath
    }
  }
  if (!id) return null
  const row = getDb()
    .prepare('SELECT file_path FROM local_tracks WHERE id = ?')
    .get(id) as { file_path: string } | undefined
  return row?.file_path ?? null
}

/** 本地文件需真实存在，且（配置了 musicDirs 时）必须位于允许的目录内，避免插件越权读取任意文件 */
function checkLocalFile(filePath: string): string | null {
  if (!filePath) return '本地音乐文件不存在'
  const resolved = path.resolve(filePath)
  if (config.musicDirs.length) {
    const allowed = config.musicDirs.some(
      (dir) => resolved === dir || resolved.startsWith(dir + path.sep)
    )
    if (!allowed) return '本地音乐文件不在允许的目录内'
  }
  if (!fs.existsSync(resolved)) return '本地音乐文件不存在'
  return null
}

export async function resolvePluginUrl(
  rawUrl: string,
  instance: PluginCaller
): Promise<ResolveUrlResult> {
  if (typeof rawUrl !== 'string' || !rawUrl) return { error: '插件未返回播放地址' }

  if (/^https?:\/\//i.test(rawUrl)) {
    return { source: { kind: 'remote', url: rawUrl } }
  }

  if (rawUrl.startsWith('vutron://')) {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return { error: '播放地址格式非法' }
    }
    const host = url.hostname
    const type = url.searchParams.get('type')

    if (host === 'local-asset') {
      if (type !== 'stream') return { error: `不支持的 local-asset 类型: ${type ?? ''}` }
      const filePath = lookupLocalFile(url.searchParams.get('id'), url.searchParams.get('path'))
      const error = checkLocalFile(filePath ?? '')
      if (error) return { error }
      return { source: { kind: 'local', filePath: path.resolve(filePath!) } }
    }

    if (host === 'get-plugin-asset') {
      if (type !== 'stream') return { error: `不支持的 get-plugin-asset 类型: ${type ?? ''}` }
      const id = url.searchParams.get('id')
      if (!id) return { error: '播放地址缺少 id' }
      const stream = (await instance.call('getStream', { id })) as
        | { url?: string; headers?: Record<string, string> }
        | undefined
      if (!stream?.url) return { error: '插件未能提供流地址' }
      return { source: { kind: 'remote', url: stream.url, headers: stream.headers } }
    }

    return { error: `不支持的插件地址: vutron://${host}` }
  }

  if (path.isAbsolute(rawUrl) && fs.existsSync(rawUrl)) {
    const error = checkLocalFile(rawUrl)
    if (error) return { error }
    return { source: { kind: 'local', filePath: path.resolve(rawUrl) } }
  }

  return { error: '不支持的播放地址协议' }
}
