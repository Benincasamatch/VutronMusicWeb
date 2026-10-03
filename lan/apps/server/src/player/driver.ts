import { AppError } from '../errors.js'

export type DriverEvent =
  | { type: 'sample', playbackId: string, positionSeconds: number | null, durationSeconds: number | null }
  | { type: 'pause', playbackId: string, paused: boolean }
  | { type: 'ended', playbackId: string, reason: 'eof' | 'error' }
  | { type: 'unavailable', playbackId: string | null }

export interface PlayerDriver {
  readonly simulation: boolean
  setEventSink: (sink: (event: DriverEvent) => void) => void
  start: () => Promise<void>
  load: (path: string, playbackId: string) => Promise<void>
  stop: () => Promise<void>
  pause: (paused: boolean) => Promise<void>
  seek: (positionSeconds: number) => Promise<void>
  volume: (volume: number) => Promise<void>
  mute: (muted: boolean) => Promise<void>
  close: () => Promise<void>
}

export class DriverError extends AppError {
  constructor(code: 'PLAYER_UNAVAILABLE' | 'PLAYBACK_FAILED' = 'PLAYBACK_FAILED') {
    super(code)
  }
}
