import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StartupError } from './errors.js'

export interface Config {
  environment: 'development' | 'production' | 'test'
  host: '127.0.0.1' | '::1'
  port: number
  publicOrigin: string
  publicHost: string
  secureCookie: boolean
  musicRoot: string
  dataDir: string
  webDist: string
  mpvPath: string
  audioDevice: string
  simulation: boolean
}

// Both src/config.ts and bundled dist/index.js are three levels below lan/.
export const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))

export function isWithin(root: string, candidate: string): boolean {
  const part = relative(root, candidate)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

export function assertUnprivileged(uid: number | undefined = process.getuid?.()): void {
  if (uid === 0) throw new StartupError('Run the service and bootstrap as a dedicated non-root OS account')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, base = workspaceRoot): Config {
  const environment = env.NODE_ENV ?? 'development'
  if (!['development', 'production', 'test'].includes(environment)) {
    throw new StartupError('NODE_ENV must be development, production or test')
  }
  const host = env.HOST ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1') throw new StartupError('HOST must be a loopback address')
  const portText = env.PORT ?? '41840'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1024 || port > 65535) throw new StartupError('PORT must be 1024–65535')
  const originText = env.PUBLIC_ORIGIN ?? (environment === 'production' ? '' : 'http://localhost:5174')
  let origin: URL
  try {
    origin = new URL(originText)
  } catch {
    throw new StartupError('PUBLIC_ORIGIN must be an exact HTTP(S) origin')
  }
  if (origin.origin !== originText || origin.username || origin.password || origin.search || origin.hash ||
    !['http:', 'https:'].includes(origin.protocol)) {
    throw new StartupError('PUBLIC_ORIGIN must have no path, credentials, query, fragment or trailing slash')
  }
  if (environment === 'production' && origin.protocol !== 'https:') {
    throw new StartupError('Production requires an HTTPS PUBLIC_ORIGIN')
  }
  if (environment !== 'production' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new StartupError('Development browser origins must be loopback')
  }
  const simulationText = env.DEV_SIMULATION ?? 'false'
  if (!['true', 'false'].includes(simulationText)) throw new StartupError('DEV_SIMULATION must be true or false')
  const simulation = simulationText === 'true'
  if (simulation && environment !== 'development') throw new StartupError('Simulation is development-only')
  if (!env.MUSIC_ROOT) throw new StartupError('MUSIC_ROOT must be explicitly configured')
  const musicRoot = resolve(base, env.MUSIC_ROOT)
  const dataDir = resolve(base, env.DATA_DIR ?? './data')
  const webDist = resolve(base, 'apps/web/dist')
  if (isWithin(resolve(base, '..'), dataDir) && !isWithin(base, dataDir)) {
    throw new StartupError('DATA_DIR may not reuse the original desktop or web project directories')
  }
  if (isWithin(musicRoot, dataDir) || isWithin(dataDir, musicRoot) ||
    isWithin(musicRoot, webDist) || isWithin(webDist, musicRoot) ||
    isWithin(webDist, dataDir) || isWithin(dataDir, webDist)) {
    throw new StartupError('Music, private data and public assets must be separate directories')
  }
  const mpvPath = env.MPV_PATH ?? '/usr/bin/mpv'
  if (!isAbsolute(mpvPath) || /[\0\r\n]/.test(mpvPath)) throw new StartupError('MPV_PATH must be an absolute executable path')
  const audioDevice = env.MPV_AUDIO_DEVICE ?? 'auto'
  if (!audioDevice || audioDevice.length > 256 || /[\0\r\n]/.test(audioDevice)) {
    throw new StartupError('MPV_AUDIO_DEVICE must be a single device identifier')
  }
  return {
    environment: environment as Config['environment'],
    host,
    port,
    publicOrigin: origin.origin,
    publicHost: origin.host,
    secureCookie: environment === 'production',
    musicRoot,
    dataDir,
    webDist,
    mpvPath,
    audioDevice,
    simulation
  }
}
