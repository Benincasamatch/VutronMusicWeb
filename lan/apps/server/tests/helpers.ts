import { randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Role, Track, TrackListQuery, TrackListResponse } from '@lan/shared'
import { Auth, digestToken } from '../src/auth.js'
import type { PlayableCatalog } from '../src/catalog.js'
import { Coordinator, type MutationContext } from '../src/coordinator.js'
import { DriverError, type DriverEvent, type PlayerDriver } from '../src/player/driver.js'
import { Store } from '../src/store.js'

export class FakeDriver implements PlayerDriver {
  readonly simulation = true
  sink: (event: DriverEvent) => void = () => undefined
  calls: Array<{ operation: string, value?: unknown, startAt?: number }> = []
  playbackId: string | null = null
  failLoad = false
  loadGate: Promise<void> | undefined
  // A real driver is terminal once closed, and every command fails once its process is gone.
  // Modelling both is what lets these tests see recovery bugs at all: without them the fake keeps
  // working after a kill, so a coordinator that can never rebuild a dead mpv still looks healthy.
  closed = false
  dead = false

  setEventSink(sink: (event: DriverEvent) => void): void { this.sink = sink }
  async start(): Promise<void> {
    this.calls.push({ operation: 'start' })
    if (this.closed) throw new DriverError()
    this.dead = false
  }
  restartFails = false
  async restart(): Promise<void> {
    this.calls.push({ operation: 'restart' })
    if (this.closed) throw new DriverError()
    if (this.restartFails) throw new DriverError()
    this.dead = false
  }
  private alive(): void {
    if (this.closed || this.dead) throw new DriverError()
  }
  async load(_path: string, playbackId: string, startAt = 0): Promise<void> {
    this.calls.push({ operation: 'load', value: playbackId, startAt })
    this.alive()
    if (this.loadGate) await this.loadGate
    if (this.failLoad) throw new DriverError()
    this.playbackId = playbackId
  }
  async stop(): Promise<void> { this.calls.push({ operation: 'stop' }); this.alive() }
  async pause(paused: boolean): Promise<void> { this.calls.push({ operation: 'pause', value: paused }); this.alive() }
  async seek(position: number): Promise<void> { this.calls.push({ operation: 'seek', value: position }); this.alive() }
  async volume(volume: number): Promise<void> { this.calls.push({ operation: 'volume', value: volume }); this.alive() }
  async mute(muted: boolean): Promise<void> { this.calls.push({ operation: 'mute', value: muted }); this.alive() }
  async close(): Promise<void> { this.calls.push({ operation: 'close' }); this.closed = true }
  emit(event: DriverEvent): void { this.sink(event) }
}

export class FakeCatalog implements PlayableCatalog {
  readonly track: Track = { id: randomUUID(), title: 'Local song', artist: null, album: null, durationSeconds: null }
  available = true
  get(id: string): Track | undefined { return id === this.track.id ? this.track : undefined }
  async acquire(_id: string) {
    if (!this.available) throw new DriverError()
    return { path: '/private/test-only/audio', close: async () => undefined }
  }
  list(query: TrackListQuery): TrackListResponse {
    const matching = this.track.title.toLowerCase().includes(query.q.toLowerCase()) ? [this.track] : []
    return { tracks: matching.slice(query.offset, query.offset + query.limit), total: matching.length, offset: query.offset, limit: query.limit }
  }
}

export function memoryStore(): Store {
  return new Store(new DatabaseSync(':memory:'))
}

export function addSession(store: Store, role: Role, username = `test-${randomUUID().slice(0, 8)}`, passwordHash = 'unused-test-hash') {
  const user = store.createAccount(username, passwordHash, role)
  const token = randomBytes(32).toString('base64url')
  const csrf = randomBytes(32).toString('base64url')
  const digest = digestToken(token)
  store.createSession({ digest, user_id: user.id, csrf, created_at: Date.now(), expires_at: Date.now() + 3600000 }, null, Date.now())
  const context: MutationContext = { digest, csrf }
  return { user, token, csrf, digest, context }
}

export async function fixture() {
  const store = memoryStore()
  const auth = new Auth(store)
  const catalog = new FakeCatalog()
  const driver = new FakeDriver()
  const coordinator = new Coordinator(store, catalog, driver, auth)
  auth.onRevoked = (digests) => coordinator.forgetSessions(digests)
  const admin = addSession(store, 'admin', 'administrator')
  const user = addSession(store, 'user', 'ordinary')
  const other = addSession(store, 'user', 'another')
  await coordinator.initialize()
  const mutation = () => ({
    requestId: randomUUID(),
    serverInstanceId: coordinator.serverInstanceId,
    expectedRevision: coordinator.snapshot().queue.revision
  })
  const playback = () => ({ ...mutation(), targetPlaybackId: coordinator.snapshot().player.playbackId })
  return {
    store, auth, catalog, driver, coordinator, admin, user, other, mutation, playback,
    enqueue: () => coordinator.enqueue(user.context, { ...mutation(), trackId: catalog.track.id }),
    close: async () => {
      await coordinator.close()
      store.close()
    }
  }
}
