import { LIMITS } from '@lan/shared'
import { DriverError, type DriverEvent, type PlayerDriver } from './driver.js'

// Only the entrypoint's explicit development flag may construct this at runtime.
// Tests may inject their own driver without starting mpv or opening audio devices.
export class SimulationDriver implements PlayerDriver {
  readonly simulation = true
  readonly settings = { volume: 35, muted: false }
  private sink: (event: DriverEvent) => void = () => undefined
  private playbackId: string | null = null
  private paused = true
  private position = 0
  private timer: ReturnType<typeof setInterval> | undefined

  setEventSink(sink: (event: DriverEvent) => void): void {
    this.sink = sink
  }

  async start(): Promise<void> {
    this.timer = setInterval(() => {
      if (!this.playbackId || this.paused) return
      this.position = Math.min(LIMITS.maxDurationSeconds, this.position + 1)
      this.sink({ type: 'sample', playbackId: this.playbackId, positionSeconds: this.position, durationSeconds: null })
    }, 1000)
    this.timer.unref()
  }

  async load(_path: string, playbackId: string): Promise<void> {
    this.playbackId = playbackId
    this.position = 0
    this.paused = false
  }

  async stop(): Promise<void> {
    this.playbackId = null
    this.paused = true
  }

  async pause(paused: boolean): Promise<void> {
    if (!this.playbackId) throw new DriverError()
    this.paused = paused
  }

  async seek(positionSeconds: number): Promise<void> {
    if (!this.playbackId) throw new DriverError()
    this.position = positionSeconds
  }

  async volume(volume: number): Promise<void> {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new DriverError()
    this.settings.volume = volume
  }

  async mute(muted: boolean): Promise<void> {
    this.settings.muted = muted
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.stop()
  }
}
