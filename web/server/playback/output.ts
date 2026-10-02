/**
 * 服务器端音频输出驱动（"服务器为主播放端"）。
 *
 * - mpv：常驻进程 + JSON IPC（unix socket）控制，能回报真实 position/duration 用于校准锚点。
 * - ffplay：无 IPC；seek / 切歌通过重启进程实现，位置由引擎锚点估算，暂停借 stdin 的 'p' 键。
 * - none：不出声，仅维护播放状态（ready=false 并给出原因）。
 *
 * 所有实现都不得抛未捕获异常：可执行文件缺失、进程异常退出都转成 getError() / onExit 上报。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.ts'

export type OutputDriver = 'mpv' | 'ffplay' | 'none'

export interface OutputExitInfo {
  code: number | null
  signal: string | null
  error?: string
}

export interface OutputLoadOptions {
  positionMs?: number
  paused?: boolean
  durationMs?: number
}

export interface AudioOutput {
  readonly driver: OutputDriver
  /** 启动输出端（拉起常驻进程 / 校验可执行文件）。不抛异常，失败写入 getError()。 */
  start(): Promise<void>
  /** 加载并（按 paused）开始播放指定媒体地址 */
  load(url: string, opts?: OutputLoadOptions): void
  play(): void
  pause(): void
  seek(positionMs: number): void
  /** volume: 0..1 */
  setVolume(volume: number): void
  stop(): void
  isReady(): boolean
  isAlive(): boolean
  getError(): string | undefined
  onExit(cb: (info: OutputExitInfo) => void): void
  onPosition(cb: (positionMs: number, durationMs: number) => void): void
  onEnd(cb: () => void): void
  destroy(): void
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/* -------------------------------------------------------------------------- */
/*                                    mpv                                     */
/* -------------------------------------------------------------------------- */

export class MpvOutput implements AudioOutput {
  readonly driver = 'mpv' as const

  private child: ChildProcess | null = null
  private socket: net.Socket | null = null
  private socketPath: string
  private buffer = ''
  private reqId = 1
  private pendingCmds: string[] = []
  private ready = false
  private error: string | undefined
  private exiting = false
  private started = false
  private loaded = false
  private paused = false
  private volume = 1
  private positionMs = 0
  private durationMs = 0
  private pendingSeekMs: number | null = null
  /** 防止 end-file 与 eof-reached 重复上报 */
  private endEmitted = false

  private exitCb?: (info: OutputExitInfo) => void
  private positionCb?: (positionMs: number, durationMs: number) => void
  private endCb?: () => void

  constructor() {
    const rand = crypto.randomBytes(4).toString('hex')
    this.socketPath = path.join(config.cacheDir, `mpv-${process.pid}-${rand}.sock`)
  }

  onExit(cb: (info: OutputExitInfo) => void): void {
    this.exitCb = cb
  }
  onPosition(cb: (positionMs: number, durationMs: number) => void): void {
    this.positionCb = cb
  }
  onEnd(cb: () => void): void {
    this.endCb = cb
  }

  getError(): string | undefined {
    return this.error
  }
  isReady(): boolean {
    return this.ready && this.child !== null
  }
  isAlive(): boolean {
    return this.child !== null
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.exiting = false

    try {
      fs.mkdirSync(config.cacheDir, { recursive: true })
      fs.rmSync(this.socketPath, { force: true })
    } catch {
      /* 目录问题会在 spawn 时体现 */
    }

    const args = [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      '--really-quiet',
      `--input-ipc-server=${this.socketPath}`,
      `--volume=${Math.round(clamp01(this.volume) * 100)}`
    ]
    if (config.output.audioDevice) args.push(`--audio-device=${config.output.audioDevice}`)

    try {
      this.child = spawn(config.output.mpvPath, args, { stdio: 'ignore' })
    } catch (err) {
      this.error = `无法启动 mpv: ${err instanceof Error ? err.message : String(err)}`
      this.ready = false
      return
    }

    this.child.once('error', (err) => {
      this.error = `无法启动 mpv: ${err.message}`
      this.ready = false
      if (!this.exiting) {
        try {
          this.exitCb?.({ code: null, signal: null, error: this.error })
        } catch {
          /* 回调不得导致进程崩溃 */
        }
      }
    })
    this.child.once('exit', (code, signal) => this.handleExit(code, signal))

    await this.connectIpc()
    if (!this.ready && !this.error) this.error = '无法连接 mpv IPC（超时）'
    if (this.error) this.ready = false
  }

  private connectIpc(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    const deadline = Date.now() + 5000
    const attempt = (): void => {
      if (this.exiting || !this.child || this.error) return resolve()
      const sock = net.connect(this.socketPath)
      sock.setNoDelay(true)
      sock.once('connect', () => {
        this.socket = sock
        this.ready = true
        this.error = undefined
        sock.on('data', (chunk) => this.onData(chunk))
        sock.on('error', () => {
          /* 断开由 close 处理 */
        })
        sock.on('close', () => {
          if (this.socket === sock) this.socket = null
        })
        this.flushPending()
        this.observeProperties()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() < deadline) setTimeout(attempt, 100)
        else {
          this.error = `无法连接 mpv IPC（超时，socket=${this.socketPath}）`
          this.ready = false
          resolve()
        }
      })
    }
    attempt()
    return promise
  }

  private observeProperties(): void {
    this.send(['observe_property', 1, 'time-pos'])
    this.send(['observe_property', 2, 'duration'])
    this.send(['observe_property', 3, 'eof-reached'])
  }

  private send(command: unknown[]): void {
    const payload = JSON.stringify({ command, request_id: this.reqId++ })
    if (this.socket && this.ready) this.socket.write(payload + '\n')
    else this.pendingCmds.push(payload)
  }

  private flushPending(): void {
    if (!this.socket) return
    const cmds = this.pendingCmds
    this.pendingCmds = []
    for (const c of cmds) this.socket.write(c + '\n')
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const event = msg.event
    if (event === 'property-change') {
      const name = msg.name
      const data = msg.data
      if (name === 'time-pos' && typeof data === 'number') {
        this.positionMs = Math.max(0, data * 1000)
        this.positionCb?.(this.positionMs, this.durationMs)
      } else if (name === 'duration' && typeof data === 'number') {
        this.durationMs = Math.max(0, data * 1000)
        this.positionCb?.(this.positionMs, this.durationMs)
      } else if (name === 'eof-reached' && data === true) {
        this.emitEnd()
      }
      return
    }
    if (event === 'file-loaded') {
      if (this.pendingSeekMs !== null && this.pendingSeekMs > 0) {
        this.send(['seek', (this.pendingSeekMs / 1000).toFixed(3), 'absolute'])
      }
      this.pendingSeekMs = null
      this.send(['set_property', 'pause', this.paused])
      return
    }
    if (event === 'end-file') {
      if (msg.reason === 'eof') this.emitEnd()
      return
    }
  }

  private emitEnd(): void {
    if (this.endEmitted || !this.loaded) return
    this.endEmitted = true
    this.endCb?.()
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.child = null
    this.ready = false
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
    try {
      fs.rmSync(this.socketPath, { force: true })
    } catch {
      /* ignore */
    }
    if (this.exiting) return
    if (!this.error) this.error = `mpv 进程已退出 (code=${code ?? 'null'} signal=${signal ?? 'null'})`
    try {
      this.exitCb?.({ code, signal })
    } catch {
      /* 回调不得导致进程崩溃 */
    }
  }

  load(url: string, opts: OutputLoadOptions = {}): void {
    this.loaded = true
    this.endEmitted = false
    this.paused = opts.paused ?? false
    this.positionMs = opts.positionMs ?? 0
    this.durationMs = opts.durationMs ?? 0
    this.pendingSeekMs = this.positionMs > 0 ? this.positionMs : null
    this.send(['loadfile', url, 'replace'])
    this.send(['set_property', 'pause', this.paused])
    this.send(['set_property', 'volume', Math.round(clamp01(this.volume) * 100)])
  }

  play(): void {
    if (!this.loaded) return
    this.paused = false
    this.send(['set_property', 'pause', false])
  }

  pause(): void {
    if (!this.loaded) return
    this.paused = true
    this.send(['set_property', 'pause', true])
  }

  seek(positionMs: number): void {
    if (!this.loaded) return
    this.positionMs = Math.max(0, positionMs)
    this.send(['seek', (this.positionMs / 1000).toFixed(3), 'absolute'])
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume)
    this.send(['set_property', 'volume', Math.round(this.volume * 100)])
  }

  stop(): void {
    this.loaded = false
    this.endEmitted = true
    this.pendingCmds = []
    this.send(['stop'])
  }

  destroy(): void {
    this.exiting = true
    this.ready = false
    this.loaded = false
    try {
      this.socket?.end()
    } catch {
      /* ignore */
    }
    this.socket = null
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 1000)
      t.unref?.()
    }
    try {
      fs.rmSync(this.socketPath, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                   ffplay                                   */
/* -------------------------------------------------------------------------- */

export class FfplayOutput implements AudioOutput {
  readonly driver = 'ffplay' as const

  private child: ChildProcess | null = null
  private gen = 0
  private binaryOk = false
  private started = false
  private exiting = false
  private error: string | undefined
  private loaded = false
  private paused = false
  private url: string | null = null
  private positionMs = 0
  private volume = 1
  private stderr = ''

  private exitCb?: (info: OutputExitInfo) => void
  private endCb?: () => void

  onExit(cb: (info: OutputExitInfo) => void): void {
    this.exitCb = cb
  }
  onPosition(): void {
    /* ffplay 无位置回报，位置由引擎锚点估算 */
  }
  onEnd(cb: () => void): void {
    this.endCb = cb
  }

  getError(): string | undefined {
    return this.error
  }
  isReady(): boolean {
    return this.binaryOk && this.error === undefined
  }
  isAlive(): boolean {
    return this.child !== null
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const probe = spawnSync(config.output.ffplayPath, ['-version'], { stdio: 'ignore' })
    if (probe.error) {
      this.binaryOk = false
      this.error = `无法启动 ffplay: ${probe.error.message}`
      return
    }
    this.binaryOk = true
  }

  load(url: string, opts: OutputLoadOptions = {}): void {
    this.url = url
    this.positionMs = opts.positionMs ?? 0
    this.paused = opts.paused ?? false
    this.loaded = true
    this.error = undefined
    this.ensureChild()
  }

  private ensureChild(): void {
    this.stopChild()
    if (!this.loaded || !this.url || !this.binaryOk) return

    const args = ['-nodisp', '-autoexit', '-hide_banner', '-loglevel', 'warning']
    if (this.positionMs > 0) args.push('-ss', (this.positionMs / 1000).toFixed(3))
    args.push('-volume', String(Math.round(clamp01(this.volume) * 100)))
    args.push(this.url)

    const gen = ++this.gen
    this.stderr = ''
    const child = spawn(config.output.ffplayPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    this.child = child

    child.once('error', (err) => {
      if (gen !== this.gen) return
      this.child = null
      this.error = `无法启动 ffplay: ${err.message}`
      try {
        this.exitCb?.({ code: null, signal: null, error: this.error })
      } catch {
        /* ignore */
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-2000)
    })
    child.once('exit', (code, signal) => {
      if (gen !== this.gen) return
      this.child = null
      if (this.exiting) return
      if (code === 0) {
        this.endCb?.()
        return
      }
      const tail = this.stderr.trim().split('\n').slice(-3).join(' | ')
      this.error = `ffplay 退出 (code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''})${tail ? `: ${tail}` : ''}`
      try {
        this.exitCb?.({ code, signal })
      } catch {
        /* ignore */
      }
    })

    if (this.paused) {
      const started = child
      const timer = setTimeout(() => {
        try {
          started.stdin?.write('p')
        } catch {
          /* ignore */
        }
      }, 300)
      timer.unref?.()
    }
  }

  private stopChild(): void {
    this.gen++
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }

  play(): void {
    if (!this.loaded) return
    this.paused = false
    if (!this.child) this.ensureChild()
    else
      try {
        this.child.stdin?.write('p')
      } catch {
        /* ignore */
      }
  }

  pause(): void {
    if (!this.loaded || this.paused) return
    this.paused = true
    try {
      this.child?.stdin?.write('p')
    } catch {
      /* ignore */
    }
  }

  seek(positionMs: number): void {
    if (!this.loaded) return
    this.positionMs = Math.max(0, positionMs)
    this.ensureChild()
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume)
    if (this.loaded && this.child) this.ensureChild()
  }

  stop(): void {
    this.loaded = false
    this.paused = false
    this.url = null
    this.stopChild()
  }

  destroy(): void {
    this.exiting = true
    this.stop()
  }
}

/* -------------------------------------------------------------------------- */
/*                                    none                                    */
/* -------------------------------------------------------------------------- */

export class NullOutput implements AudioOutput {
  readonly driver = 'none' as const
  private error = '音频输出已禁用（VW_OUTPUT_DRIVER=none），仅同步播放状态'

  onExit(): void {}
  onPosition(): void {}
  onEnd(): void {}
  async start(): Promise<void> {}
  load(): void {}
  play(): void {}
  pause(): void {}
  seek(): void {}
  setVolume(): void {}
  stop(): void {}
  isReady(): boolean {
    return false
  }
  isAlive(): boolean {
    return false
  }
  getError(): string | undefined {
    return this.error
  }
  destroy(): void {}
}

export function createOutput(): AudioOutput {
  switch (config.output.driver) {
    case 'mpv':
      return new MpvOutput()
    case 'ffplay':
      return new FfplayOutput()
    default:
      return new NullOutput()
  }
}
