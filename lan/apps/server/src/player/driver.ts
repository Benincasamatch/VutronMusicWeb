import { AppError } from '../errors.js'

export type DriverEvent =
  | { type: 'sample', playbackId: string, positionSeconds: number | null, durationSeconds: number | null }
  | { type: 'pause', playbackId: string, paused: boolean }
  | { type: 'ended', playbackId: string, reason: 'eof' | 'error' }
  | { type: 'unavailable', playbackId: string | null }
  | { type: 'device', playbackId: string, expected: string, detected: string | null, mismatch: boolean }

export interface PlayerDriver {
  readonly simulation: boolean
  setEventSink: (sink: (event: DriverEvent) => void) => void
  start: () => Promise<void>
  // Rebuild after an unrecoverable failure. A throw means the player is still unavailable.
  restart: () => Promise<void>
  load: (path: string, playbackId: string, startAt?: number) => Promise<void>
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
