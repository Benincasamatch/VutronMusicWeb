import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LIMITS } from '@lan/shared'
import { DriverError, type DriverEvent, type PlayerDriver } from './driver.js'

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (error: DriverError) => void
  timer: ReturnType<typeof setTimeout>
}

interface Loading {
  playbackId: string
  playlistId: number | null
  resolve: () => void
  reject: (error: DriverError) => void
  timer: ReturnType<typeof setTimeout>
}

interface Observation {
  playbackId: string
  property: 'time-pos' | 'duration' | 'pause' | 'audio-out-detected-device'
}

// Journal lines must stay diagnosable without echoing absolute library paths.
// Everything from the first absolute path to the end of the line is dropped, so a
// filename containing spaces cannot leak through either.
const redact = (line: string): string => line.replace(/(^|[\s'"(=:])\/.*$/, '$1<path>').slice(0, 300)

// mpv reports the AO's own device name for a configured `ao/device` pair, so compare loosely.
// 'auto' means "let mpv choose", which is never a mismatch.
const deviceMismatch = (expected: string, detected: string | null): boolean => {
  if (expected === 'auto' || !detected) return false
  const wanted = expected.trim().toLowerCase()
  const actual = detected.trim().toLowerCase()
  if (!actual || wanted === actual) return false
  const device = wanted.slice(wanted.indexOf('/') + 1)
  if (!device) return false
  return !(actual === device || actual.endsWith(device) || device.endsWith(actual))
}

export class MpvDriver implements PlayerDriver {
  readonly simulation = false
  private sink: (event: DriverEvent) => void = () => undefined
  private child: ChildProcess | undefined
  private socket: Socket | undefined
  private directory: string | undefined
  private broken = false
  private closing = false
  private ready = false
  private buffer = ''
  private failure: string | undefined
  private readonly stderrTail: string[] = []
  private requestCounter = 0
  private observeCounter = 0
  private readonly pending = new Map<number, PendingCommand>()
  private readonly observations = new Map<number, Observation>()
  private readonly playlist = new Map<number, string>()
  private loading: Loading | undefined
  private playbackId: string | null = null
  private startedPlaylistId: number | null = null
  private position: number | null = null
  private duration: number | null = null
  private expectedPause = false
  private suppressPause = false

  constructor(
    private readonly executable: string,
    private readonly audioDevice: string,
    private readonly report: (message: string) => void = (message) => { process.stderr.write(`${message}\n`) }
  ) {}

  setEventSink(sink: (event: DriverEvent) => void): void {
    this.sink = sink
  }

  async start(): Promise<void> {
    if (process.platform !== 'linux') {
      throw new Error('Real playback requires Linux, mpv and procfs. Simulation must be explicitly enabled in development')
    }
    if (process.getuid?.() === 0) throw new Error('mpv must not run as OS root')
    if (this.child || this.closing) throw new DriverError('PLAYER_UNAVAILABLE')
    this.directory = await mkdtemp(join(tmpdir(), 'lan-mpv-'))
    await chmod(this.directory, 0o700)
    const socketPath = join(this.directory, 'ipc')
    if (Buffer.byteLength(socketPath) > 100) {
      await this.close()
      this.report('mpv player unavailable: the private IPC socket path is too long for this temporary directory')
      throw new Error('Temporary directory is too long for a private Unix socket')
    }
    try {
      this.child = spawn(this.executable, [
        '--no-config',
        '--load-scripts=no',
        '--ytdl=no',
        '--idle=yes',
        '--keep-open=no',
        '--terminal=no',
        '--input-terminal=no',
        '--input-default-bindings=no',
        '--input-vo-keyboard=no',
        '--osc=no',
        '--video=no',
        '--audio-display=no',
        '--sub-auto=no',
        '--audio-file-auto=no',
        '--cover-art-auto=no',
        '--autoload-files=no',
        '--access-references=no',
        '--demuxer-lavf-o=protocol_whitelist=file',
        '--volume=35',
        '--volume-max=100',
        '--replaygain=no',
        `--audio-device=${this.audioDevice}`,
        `--input-ipc-server=${socketPath}`
      ], { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      this.child.on('error', (error) => this.connectionFailed(`spawn failed: ${error.message}`))
      this.child.on('exit', (code, signal) => this.connectionFailed(`mpv exited (code=${code ?? 'none'}, signal=${signal ?? 'none'})`))
      this.child.stderr?.setEncoding('utf8')
      this.child.stderr?.on('data', (chunk: string) => this.collectStderr(chunk))
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !this.broken) {
        const stat = await lstat(socketPath).catch(() => null)
        if (stat?.isSocket()) {
          if (stat.uid !== process.getuid?.()) throw new DriverError('PLAYER_UNAVAILABLE')
          await chmod(socketPath, 0o600)
          const socket = await this.connect(socketPath)
          if (socket) {
            this.socket = socket
            break
          }
        }
        await delay(25)
      }
      if (!this.socket || this.broken) {
        if (!this.broken) this.report('mpv player unavailable: mpv did not open its private IPC socket within 5 seconds')
        throw new DriverError('PLAYER_UNAVAILABLE')
      }
      this.socket.setEncoding('utf8')
      this.socket.on('data', (chunk: Buffer | string) => this.consume(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
      this.socket.on('error', () => this.connectionFailed('the private IPC socket reported an error'))
      this.socket.on('close', () => this.connectionFailed('the private IPC socket closed unexpectedly'))
      await this.command(['get_property', 'mpv-version'])
      this.ready = true
    } catch (error) {
      await this.close()
      if (!this.failure) this.report(`mpv player unavailable: ${error instanceof Error ? redact(error.message) : 'startup failed'}`)
      throw new DriverError('PLAYER_UNAVAILABLE')
    }
  }

  private connect(path: string): Promise<Socket | null> {
    return new Promise((resolve) => {
      const socket = createConnection(path)
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(null)
      }, 250)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve(null)
      })
    })
  }

  private command(command: unknown[]): Promise<unknown> {
    if (!this.socket || this.broken || this.closing) return Promise.reject(new DriverError('PLAYER_UNAVAILABLE'))
    if (this.pending.size >= 32 || this.requestCounter >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new DriverError('PLAYER_UNAVAILABLE'))
    }
    const requestId = ++this.requestCounter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.connectionFailed('an IPC command timed out after 5 seconds'), 5000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.socket!.write(`${JSON.stringify({ command, request_id: requestId })}\n`, (error) => {
        if (error) this.connectionFailed('an IPC write failed')
      })
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 262144) {
      this.connectionFailed('an IPC message exceeded the size limit')
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      try {
        const message: unknown = JSON.parse(line)
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid IPC')
        this.message(message as Record<string, unknown>)
      } catch {
        this.connectionFailed('an IPC message was not valid JSON')
        return
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  private message(message: Record<string, unknown>): void {
    if (typeof message.request_id === 'number') {
      const pending = this.pending.get(message.request_id)
      if (!pending) return
      this.pending.delete(message.request_id)
      clearTimeout(pending.timer)
      if (message.error === 'success') pending.resolve(message.data)
      else pending.reject(new DriverError())
      return
    }
    if (message.event === 'start-file' && typeof message.playlist_entry_id === 'number') {
      if (this.loading) {
        this.loading.playlistId = message.playlist_entry_id
        this.playlist.set(message.playlist_entry_id, this.loading.playbackId)
        this.startedPlaylistId = message.playlist_entry_id
      }
      return
    }
    if (message.event === 'file-loaded') {
      const loading = this.loading
      if (loading && loading.playlistId !== null && this.startedPlaylistId === loading.playlistId) {
        clearTimeout(loading.timer)
        this.loading = undefined
        loading.resolve()
      }
      return
    }
    if (message.event === 'end-file' && typeof message.playlist_entry_id === 'number') {
      const id = this.playlist.get(message.playlist_entry_id)
      this.playlist.delete(message.playlist_entry_id)
      if (!id) return
      if (this.loading?.playbackId === id) {
        const loading = this.loading
        this.loading = undefined
        clearTimeout(loading.timer)
        loading.reject(new DriverError())
      }
      // stop/quit/redirect never mean a successful natural finish.
      if (id === this.playbackId && (message.reason === 'eof' || message.reason === 'error')) {
        this.sink({ type: 'ended', playbackId: id, reason: message.reason })
      } else if (id === this.playbackId && message.reason !== 'stop' && message.reason !== 'quit') {
        this.sink({ type: 'ended', playbackId: id, reason: 'error' })
      }
      return
    }
    if (message.event === 'property-change' && typeof message.id === 'number') {
      const observation = this.observations.get(message.id)
      if (!observation || observation.playbackId !== this.playbackId) return
      if (observation.property === 'pause') {
        if (typeof message.data === 'boolean' && !this.suppressPause && message.data !== this.expectedPause) {
          this.expectedPause = message.data
          this.sink({ type: 'pause', playbackId: observation.playbackId, paused: message.data })
        }
        return
      }
      if (observation.property === 'audio-out-detected-device') {
        const detected = typeof message.data === 'string' && message.data.trim() ? message.data : null
        this.sink({
          type: 'device',
          playbackId: observation.playbackId,
          expected: this.audioDevice,
          detected,
          mismatch: deviceMismatch(this.audioDevice, detected)
        })
        return
      }
      const value = typeof message.data === 'number' && Number.isFinite(message.data) && message.data >= 0 &&
        message.data <= LIMITS.maxDurationSeconds ? message.data : null
      if (observation.property === 'time-pos') this.position = value
      else this.duration = value
      this.sink({ type: 'sample', playbackId: observation.playbackId, positionSeconds: this.position, durationSeconds: this.duration })
    }
  }

  async load(path: string, playbackId: string): Promise<void> {
    // Flush an explicit stop before assigning a new generation. Old end-file/observer IDs cannot advance it.
    await this.stop()
    this.playbackId = playbackId
    this.expectedPause = false
    this.suppressPause = true
    this.position = null
    this.duration = null
    const loaded = new Promise<void>((resolve, reject) => {
      this.loading = {
        playbackId,
        playlistId: null,
        resolve,
        reject,
        timer: setTimeout(() => this.connectionFailed('mpv did not load the file within 15 seconds'), 15000)
      }
    })
    try {
      await Promise.all([loaded, this.command(['loadfile', path, 'replace'])])
      for (const property of ['time-pos', 'duration', 'pause'] as const) {
        if (this.observeCounter >= Number.MAX_SAFE_INTEGER) throw new DriverError('PLAYER_UNAVAILABLE')
        const id = ++this.observeCounter
        this.observations.set(id, { playbackId, property })
        await this.command(['observe_property', id, property])
      }
      if (this.observeCounter < Number.MAX_SAFE_INTEGER) {
        const deviceObserver = ++this.observeCounter
        this.observations.set(deviceObserver, { playbackId, property: 'audio-out-detected-device' })
        try {
          await this.command(['observe_property', deviceObserver, 'audio-out-detected-device'])
        } catch {
          // Optional diagnostic property: an mpv build without it must not fail playback.
          this.observations.delete(deviceObserver)
        }
      }
      await this.command(['set_property', 'pause', false])
      this.suppressPause = false
    } catch (error) {
      if (this.loading?.playbackId === playbackId) {
        clearTimeout(this.loading.timer)
        this.loading.reject(new DriverError())
        this.loading = undefined
      }
      // Best-effort silence, never allow a partially loaded entry to play after an HTTP error.
      await this.stop().catch(() => undefined)
      throw error instanceof DriverError ? error : new DriverError()
    }
  }

  async stop(): Promise<void> {
    this.playbackId = null
    this.startedPlaylistId = null
    this.playlist.clear()
    if (this.loading) {
      clearTimeout(this.loading.timer)
      this.loading.reject(new DriverError())
      this.loading = undefined
    }
    const observers = [...this.observations.keys()]
    this.observations.clear()
    for (const id of observers) await this.command(['unobserve_property', id])
    await this.command(['stop'])
  }

  async pause(paused: boolean): Promise<void> {
    this.expectedPause = paused
    await this.command(['set_property', 'pause', paused])
  }

  async seek(positionSeconds: number): Promise<void> {
    await this.command(['seek', positionSeconds, 'absolute+exact'])
  }

  async volume(volume: number): Promise<void> {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new DriverError()
    await this.command(['set_property', 'volume', volume])
  }

  async mute(muted: boolean): Promise<void> {
    await this.command(['set_property', 'mute', muted])
  }

  private collectStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const text = line.trim()
      if (!text) continue
      this.stderrTail.push(redact(text))
      if (this.stderrTail.length > 8) this.stderrTail.shift()
    }
  }

  private connectionFailed(cause: string): void {
    if (this.broken) return
    this.broken = true
    this.failure = cause
    if (!this.closing) {
      const last = this.stderrTail[this.stderrTail.length - 1]
      this.report(`mpv player unavailable: ${cause}${last ? `; last mpv output: ${last}` : ''}`)
    }
    const error = new DriverError('PLAYER_UNAVAILABLE')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    if (this.loading) {
      clearTimeout(this.loading.timer)
      this.loading.reject(error)
      this.loading = undefined
    }
    this.socket?.destroy()
    this.child?.kill('SIGTERM')
    if (this.ready && !this.closing) this.sink({ type: 'unavailable', playbackId: this.playbackId })
  }

  async restart(): Promise<void> {
    if (this.closing) throw new DriverError('PLAYER_UNAVAILABLE')
    await this.reset()
    await this.start()
  }

  // Clear everything a previous attempt left behind without making close() terminal.
  private async reset(): Promise<void> {
    await this.discardChild()
    this.broken = false
    this.ready = false
    this.failure = undefined
    this.buffer = ''
    this.pending.clear()
    this.observations.clear()
    this.playlist.clear()
    this.loading = undefined
    this.playbackId = null
    this.startedPlaylistId = null
    this.position = null
    this.duration = null
    this.expectedPause = false
    this.suppressPause = false
    this.stderrTail.length = 0
  }

  private async discardChild(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.socket?.destroy()
    this.socket = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill('SIGTERM')
      })
    }
    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true })
      this.directory = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.connectionFailed('the driver was closed')
    await this.discardChild()
  }
}
