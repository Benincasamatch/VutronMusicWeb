/**
 * Web 版桥接（在渲染层加载前安装，供路由、App 启动流程与播放器调用）。
 *
 * 1）localSourceReady：本地音源目录在 Web 版由服务器配置，而插件登录态在桌面版是本地持久化的。
 *    首次在新浏览器打开时 store 还是空的，路由会把 /localMusic 重定向到登录页；
 *    这里让路由先问一次服务器是否已配置目录，已配置就直接放行。
 * 2）primeSources：App 在 getPlugins 之后、拉取数据之前调用，用服务器状态补齐本地音源登录态。
 * 3）serverDrivenPlayback / onLocalTrackEnded / requestServerNext：曲目推进由服务器掌握，
 *    浏览器播完只上报，不自行切歌，避免两端各自推进导致跳曲错乱。
 *
 * 依赖渲染层 store 的实现模块统一通过 import.meta.glob 懒加载，避免 web/tsconfig 把渲染层拉进类型检查。
 */
import { API } from '../../../web/shared/contract.ts'
import { apiFetch } from './http.ts'

export interface WebBridge {
  isWeb: true
  localSourceReady: () => Promise<boolean>
  primeSources?: () => Promise<void>
  serverDrivenPlayback?: boolean
  onLocalTrackEnded?: () => void
  requestServerNext?: () => void
}

const booters = import.meta.glob('./bootWeb.ts')

let mirrorModule: Promise<unknown> | null = null

function loadMirror(): Promise<{ onLocalTrackEnded?: () => void; requestServerNext?: () => void }> {
  if (!mirrorModule) {
    const load = booters['./bootWeb.ts'] as (() => Promise<unknown>) | undefined
    mirrorModule = load ? load() : Promise.resolve({})
  }
  return mirrorModule as Promise<{ onLocalTrackEnded?: () => void; requestServerNext?: () => void }>
}

async function localSourceReady(): Promise<boolean> {
  try {
    const data = await apiFetch<{ roots?: string[] }>(API.library.roots, { allowUnauthorized: true })
    return Array.isArray(data?.roots) && data.roots.length > 0
  } catch {
    return false
  }
}

async function primeSources(): Promise<void> {
  const mod = (await loadMirror()) as { primeSources?: () => Promise<void> }
  await mod.primeSources?.()
}

const bridge: WebBridge = {
  isWeb: true,
  localSourceReady,
  primeSources,
  serverDrivenPlayback: true,
  onLocalTrackEnded: () => {
    void loadMirror().then((mod) => mod.onLocalTrackEnded?.())
  },
  requestServerNext: () => {
    void loadMirror().then((mod) => mod.requestServerNext?.())
  }
}

const globals = window as unknown as { vwWeb?: WebBridge }
globals.vwWeb = bridge
