/**
 * 音源登录态预置（Web 版专用）。
 *
 * 桌面版把插件登录态持久化在本地 store 里，启动时 App.vue 依据 `service.status === 'login'`
 * 决定要拉取哪些音源的数据。Web 版首次在新浏览器打开时 store 是空的，而本地音源的目录其实
 * 由服务器配置，因此这里在 App 拉数据之前，用 systemPing 把服务器上的目录与登录态写回 store。
 *
 * 仅当服务端确实返回 login 时才置为登录态；用户已改过目录（store 非空）时不覆盖。
 */
import { usePluginMusic } from '../store/pluginMusic.ts'

const READY_TIMEOUT_MS = 5000
const POLL_MS = 150

interface SystemPingResult {
  status?: 'login' | 'logout' | 'offline'
  scanDir?: string[]
}

async function waitForLocalService() {
  const store = usePluginMusic()
  const started = Date.now()
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const found = store.services?.find((service) => service.type === 'local')
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return undefined
}

/** 由 App.vue 在拉取数据前调用（通过 webBridge.primeSources） */
export async function primeSources(): Promise<void> {
  const store = usePluginMusic()
  const local = await waitForLocalService()
  if (!local) return

  try {
    const res = (await store.pluginMethodCall('local', 'systemPing', {})) as SystemPingResult
    if (res?.status) store.handleStatusChange('local', res.status)
    if (res?.status === 'login' && Array.isArray(res.scanDir) && res.scanDir.length > 0) {
      if (store.scanDir.length === 0) store.scanDir = res.scanDir
    }
  } catch (err) {
    console.warn('[web-local] 同步本地音源登录态失败:', err)
  }
}
