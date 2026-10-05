import type { QueueEntry, SessionResponse, Snapshot, Track } from '@lan/shared'

export const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
export const NOW = Date.parse('2026-10-02T12:00:00.000Z')
export const instanceA = uuid(1)
export const instanceB = uuid(2)
export const track: Track = {
  id: uuid(10),
  title: '本地试听曲目',
  artist: null,
  album: null,
  durationSeconds: 180
}
export const entry: QueueEntry = {
  entryId: uuid(20),
  track,
  requester: { id: uuid(30), username: 'listener' },
  addedAt: '2026-10-02T12:00:00.000Z'
}

export function session(role: 'admin' | 'dj' | 'user' = 'admin'): SessionResponse {
  return {
    user: { id: uuid(30), username: 'listener', role },
    csrfToken: 'a'.repeat(43),
    expiresAt: '2026-10-03T00:00:00.000Z'
  }
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    serverInstanceId: instanceA,
    eventSeq: 1,
    simulation: false,
    player: {
      status: 'idle',
      current: null,
      playbackId: null,
      positionSeconds: 0,
      durationSeconds: null,
      volume: 50,
      muted: false,
      error: null,
      warning: null
    },
    queue: { revision: 1, entries: [entry] },
    ...overrides
  }
}

export function playing(overrides: Partial<Snapshot> = {}): Snapshot {
  return snapshot({
    player: {
      status: 'playing',
      current: entry,
      playbackId: uuid(40),
      positionSeconds: 15,
      durationSeconds: 180,
      volume: 50,
      muted: false,
      error: null,
      warning: null
    },
    queue: { revision: 1, entries: [] },
    ...overrides
  })
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
