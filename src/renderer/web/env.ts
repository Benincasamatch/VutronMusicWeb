/**
 * 浏览器版 window.env 安装器，替代 Electron preload 中的 contextBridge 注入。
 *
 * 保持 isElectron = true：既有渲染层用该标记选择 hash 路由、以及“播放交给宿主”的分支，
 * 浏览器版的宿主是局域网服务端，语义一致，因此不在渲染层新增分支。
 * 用 isWeb = true 标记“浏览器 UI + 服务端播放”这一形态，供后续需要区分的位置使用。
 */

export interface WebEnv {
  isElectron: boolean
  isEnableTitlebar: boolean
  isLinux: boolean
  isMac: boolean
  isWindows: boolean
  isDev: boolean
  isWeb: boolean
}

export const env: WebEnv = {
  // 渲染层以 isElectron 选择 hash 路由与“播放交给宿主”的分支，浏览器版的宿主是服务端
  isElectron: true,
  // 浏览器没有自绘标题栏
  isEnableTitlebar: false,
  isLinux: false,
  isMac: false,
  isWindows: false,
  isDev: Boolean(import.meta.env?.DEV),
  isWeb: true
}

/** 幂等安装；多次调用只会覆盖成同一份值 */
export function installEnv(target: Window = window): WebEnv {
  // 全局类型由渲染层 main.ts 声明（含 isWeb?），此处不重复声明以免类型冲突
  const globals = target as unknown as { env?: WebEnv }
  globals.env = { ...env }
  return env
}

installEnv()
