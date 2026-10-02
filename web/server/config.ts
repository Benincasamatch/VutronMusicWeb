/**
 * Web 版运行时配置。所有可变项通过环境变量覆盖，默认值面向局域网单机部署。
 * 与桌面版不同：不依赖 Electron 的 app.getPath，数据目录由 VW_DATA_DIR 决定。
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

/** web/ 目录 */
export const WEB_ROOT = path.resolve(serverDir, '..')
/** 仓库根目录（复用 src/types、src/public/plugin） */
export const REPO_ROOT = path.resolve(WEB_ROOT, '..')

function str(key: string, fallback: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function num(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const dataDir = path.resolve(str('VW_DATA_DIR', path.join(WEB_ROOT, 'data')))

export const config = {
  /** 监听地址，默认全部网卡以便局域网访问；VW_HOST=127.0.0.1 可只限本机 */
  host: str('VW_HOST', '0.0.0.0'),
  port: num('VW_PORT', 41831),
  /** 对外可访问的基地址，用于日志与回调拼接；留空时按请求 Host 推断 */
  publicOrigin: str('VW_PUBLIC_ORIGIN', ''),

  dataDir,
  dbFile: path.resolve(str('VW_DB_FILE', path.join(dataDir, 'vutron-web.sqlite3'))),
  /** 服务器本地音乐根目录列表，逗号分隔 */
  musicDirs: str('VW_MUSIC_DIRS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p)),
  /** 缓存/媒体临时目录 */
  cacheDir: path.resolve(str('VW_CACHE_DIR', path.join(dataDir, 'cache'))),

  /** 会话有效期（默认 30 天） */
  sessionTtlMs: num('VW_SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
  /** 初始管理员的用户名与密码；密码留空时自动生成随机密码并写入 data/INITIAL_ADMIN.txt */
  admin: {
    username: str('VW_ADMIN_USER', 'admin'),
    password: str('VW_ADMIN_PASSWORD', '')
  },

  /** 服务器端音频输出 */
  output: {
    /** 'mpv' | 'ffplay' | 'none' */
    driver: str('VW_OUTPUT_DRIVER', 'mpv') as 'mpv' | 'ffplay' | 'none',
    mpvPath: str('VW_MPV_PATH', 'mpv'),
    ffplayPath: str('VW_FFPLAY_PATH', 'ffplay'),
    /** 输出音量 0-100 */
    volume: num('VW_OUTPUT_VOLUME', 100),
    /** mpv 音频输出设备，留空用默认 */
    audioDevice: str('VW_AUDIO_DEVICE', '')
  },

  plugins: {
    dir: path.resolve(str('VW_PLUGIN_DIR', path.join(REPO_ROOT, 'src/public/plugin'))),
    userDir: path.resolve(str('VW_USER_PLUGIN_DIR', path.join(dataDir, 'plugins')))
  },

  repoRoot: REPO_ROOT,
  webRoot: WEB_ROOT
}

export type AppConfig = typeof config

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.cacheDir, config.plugins.userDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/** 枚举本机可用的局域网 IPv4 地址，用于启动日志 */
export function lanAddresses(): string[] {
  const list: string[] = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) list.push(info.address)
    }
  }
  return list
}
