import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  LIMITS,
  MutationResponseSchema,
  SnapshotSchema,
  type CreateUserRequest,
  type EnqueueRequest,
  type MutationRequest,
  type MutationResponse,
  type PlaybackRequest,
  type Player,
  type PlayerCommandName,
  type PublicUser,
  type QueueEntry,
  type ServerEvent,
  type SessionRevokedReason,
  type Snapshot,
  type UpdateUserRoleRequest,
  type UserMutationResponse
} from '@lan/shared'
import { Auth, hashPassword, type Principal } from './auth.js'
import type { FileLease, PlayableCatalog } from './catalog.js'
import { AppError, fail } from './errors.js'
import { DriverError, type DriverEvent, type PlayerDriver } from './player/driver.js'
import type { Store } from './store.js'

export interface MutationContext {
  digest: string
  csrf: string | undefined
}

type Cached = { fingerprint: string, expires: number, bytes: number, response: MutationResponse | UserMutationResponse }
const CACHE_BYTE_BUDGET = 64 * 1024 * 1024
type PlayerInput = PlaybackRequest & { positionSeconds?: number, volume?: number, muted?: boolean }
type SampleEvent = Extract<DriverEvent, { type: 'sample' }>
type Admission = 'external' | 'internal'
const PENDING_LIMITS = { external: 512, internal: 1024 }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export class Coordinator {
  readonly serverInstanceId = randomUUID()
  private eventSeq = 0
  private revision = 0
  private queue: QueueEntry[]
  private player: Player
  private history: QueueEntry[] = []
  private currentStarted = false
  // Whether the driver currently holds the file for the current entry.
  private loaded = false
  // Set only when an interrupted entry is restored; consumed by the next load.
  private resumeAt: number | null = null
  private lease: FileLease | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly pending = { external: 0, internal: 0 }
  private pendingSample: { event: SampleEvent } | undefined
  private sampleFlushPending = false
  private closing = false
  private readonly cache = new Map<string, Map<string, Cached>>()
  private cacheBytes = 0
  private readonly cacheSecret = randomBytes(32)
  private readonly subscribers = new Set<(event: ServerEvent) => void>()
  private sampleDirty = false
  private readonly sampleTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly store: Store,
    private readonly catalog: PlayableCatalog,
    private readonly driver: PlayerDriver,
    private readonly auth: Auth,
    private readonly now: () => number = Date.now
  ) {
    this.queue = store.waiting()
    const saved = store.checkpoint()
    // Waiting order and settings survive a restart. The interrupted entry is restored too, but only as
    // a paused entry the user must start again: nothing is loaded into the player, so no audio resumes
    // on its own. An entry whose track left the catalog is dropped instead of being shown as something
    // that can never play.
    const interrupted = saved?.current && catalog.get(saved.current.track.id) ? saved : null
    this.player = {
      status: interrupted ? 'paused' : 'idle',
      current: interrupted?.current ?? null,
      playbackId: interrupted ? randomUUID() : null,
      positionSeconds: interrupted?.positionSeconds ?? 0,
      durationSeconds: interrupted?.durationSeconds ?? null,
      volume: Math.min(100, Math.max(0, saved?.volume ?? 35)),
      muted: saved?.muted ?? false,
      error: null,
      warning: null
    }
    if (interrupted) {
      // The file is not loaded yet, so the first play must load it and then seek to this position.
      this.resumeAt = interrupted.positionSeconds
      // History holds entries that actually started playing, so an entry whose saved state never
      // reached playback - a failed load, or a crash mid-load - must not become a Previous target.
      this.currentStarted = interrupted.status === 'playing' || interrupted.status === 'paused'
    }
    this.snapshot()
    driver.setEventSink((event) => this.enqueueDriverEvent(event))
    this.sampleTimer = setInterval(() => {
      if (this.closing || !this.sampleDirty || this.sampleFlushPending) return
      this.sampleFlushPending = true
      void this.serialInternal(() => {
        if (!this.sampleDirty) return
        this.sampleDirty = false
        this.publish()
      }).catch(() => this.fatalState()).finally(() => { this.sampleFlushPending = false })
    }, 1000)
    this.sampleTimer.unref()
  }

  async initialize(): Promise<void> {
    await this.driver.start()
    await this.driver.volume(this.player.volume)
    await this.driver.mute(this.player.muted)
    this.persist()
  }

  serial<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.schedule('external', operation)
  }

  serialInternal<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.schedule('internal', operation)
  }

  private schedule<T>(admission: Admission, operation: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AppError('PLAYER_UNAVAILABLE'))
    if (this.pending[admission] >= PENDING_LIMITS[admission]) {
      if (admission === 'external') return Promise.reject(new AppError('RATE_LIMITED'))
      this.fatalState()
      return Promise.reject(new AppError('PLAYER_UNAVAILABLE'))
    }
    // External requests cannot exhaust lifecycle capacity, but every job keeps FIFO order.
    this.pending[admission] += 1
    this.pendingSample = undefined
    const task = this.chain.then(() => {
      if (this.closing) return fail('PLAYER_UNAVAILABLE')
      return operation()
    }).catch((error: unknown) => {
      if (!(error instanceof AppError)) this.fatalState()
      throw error
    }).finally(() => { this.pending[admission] -= 1 })
    this.chain = task.catch(() => undefined)
    return task
  }

  private enqueueDriverEvent(event: DriverEvent): void {
    if (this.closing) return
    if (event.type !== 'sample') {
      void this.serialInternal(() => this.onDriverEvent(event)).catch(() => this.fatalState())
      return
    }
    const pending = this.pendingSample
    if (pending && pending.event.playbackId === event.playbackId) {
      pending.event = {
        ...event,
        positionSeconds: event.positionSeconds ?? pending.event.positionSeconds
      }
      return
    }
    const sample = { event }
    const task = this.serialInternal(() => {
      if (this.pendingSample === sample) this.pendingSample = undefined
      return this.onDriverEvent(sample.event)
    })
    // Only adjacent samples coalesce; a seek, next or snapshot is an ordering barrier.
    if (!this.closing) this.pendingSample = sample
    void task.catch(() => this.fatalState())
  }

  snapshot(): Snapshot {
    return SnapshotSchema.parse({
      serverInstanceId: this.serverInstanceId,
      eventSeq: this.eventSeq,
      simulation: this.driver.simulation,
      player: this.player,
      queue: { revision: this.revision, entries: this.queue }
    })
  }

  subscribe(sink: (event: ServerEvent) => void): () => void {
    this.subscribers.add(sink)
    return () => { this.subscribers.delete(sink) }
  }

  private increment(kind: 'revision' | 'eventSeq'): void {
    if (this[kind] >= Number.MAX_SAFE_INTEGER) throw new Error('State epoch exhausted; restart is required')
    this[kind] += 1
  }

  private broadcast(event: ServerEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event)
      } catch {
        this.subscribers.delete(subscriber)
      }
    }
  }

  private publish(): void {
    this.increment('eventSeq')
    this.broadcast({ type: 'snapshot', snapshot: this.snapshot() })
  }

  // A rebuilt player is announced explicitly; clients must never see a silent resume.
  private announceRecovery(): void {
    this.increment('eventSeq')
    this.broadcast({ type: 'player.recovered', serverInstanceId: this.serverInstanceId, eventSeq: this.eventSeq, reason: 'driver_rebuilt' })
  }

  revocation(reason: SessionRevokedReason): ServerEvent {
    this.increment('eventSeq')
    return { type: 'session.revoked', serverInstanceId: this.serverInstanceId, eventSeq: this.eventSeq, reason }
  }

  forgetSessions(digests: string[]): void {
    for (const digest of digests) {
      const entries = this.cache.get(digest)
      if (entries) for (const cached of entries.values()) this.cacheBytes -= cached.bytes
      this.cache.delete(digest)
    }
  }

  private forgetRequest(session: string, requestId: string): void {
    const entries = this.cache.get(session)
    const cached = entries?.get(requestId)
    if (!entries || !cached) return
    this.cacheBytes -= cached.bytes
    entries.delete(requestId)
    if (!entries.size) this.cache.delete(session)
  }

  private principal(context: MutationContext, permission: 'any' | 'control' | 'admin'): Principal {
    const principal = this.auth.byDigest(context.digest)
    this.auth.checkCsrf(principal, context.csrf)
    if (permission === 'admin' && principal.user.role !== 'admin') return fail('FORBIDDEN')
    if (permission === 'control' && principal.user.role === 'user') return fail('FORBIDDEN')
    return principal
  }

  private async idempotent<T extends MutationResponse | UserMutationResponse>(
    context: MutationContext,
    method: string,
    path: string,
    body: { requestId: string },
    permission: 'any' | 'control' | 'admin',
    action: (principal: Principal) => Promise<T> | T
  ): Promise<T> {
    // This entire method is called under serial(). Identical in-flight requests wait and then replay.
    const principal = this.principal(context, permission)
    const now = this.now()
    for (const [session, entries] of this.cache) {
      for (const [id, cached] of entries) if (cached.expires <= now) this.forgetRequest(session, id)
    }
    const fingerprint = createHmac('sha256', this.cacheSecret).update(canonical({ method, path, body })).digest('hex')
    const entries = this.cache.get(principal.digest) ?? new Map<string, Cached>()
    const previous = entries.get(body.requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) return fail('REQUEST_ID_REUSED')
      return structuredClone(previous.response) as T
    }
    const response = await action(principal)
    // A self-demotion revokes this session inside action. Do not recreate its cache afterward.
    try {
      this.auth.byDigest(principal.digest)
    } catch {
      return response
    }
    const bytes = Buffer.byteLength(JSON.stringify(response))
    entries.set(body.requestId, {
      fingerprint,
      expires: this.now() + LIMITS.idempotencyTtlMs,
      bytes,
      response: structuredClone(response)
    })
    this.cacheBytes += bytes
    this.cache.set(principal.digest, entries)
    while (entries.size > LIMITS.idempotencyEntriesPerSession) this.forgetRequest(principal.digest, entries.keys().next().value!)
    // Global pressure can evict older completed requests earlier; never promise replay after eviction.
    while (this.cacheBytes > CACHE_BYTE_BUDGET || this.cache.size > 1000) {
      const oldest = this.cache.entries().next().value!
      this.forgetRequest(oldest[0], oldest[1].keys().next().value!)
    }
    return response
  }

  private checkExpected(body: MutationRequest, target?: { playbackId: string | null }): void {
    if (body.serverInstanceId !== this.serverInstanceId) fail('INSTANCE_CONFLICT')
    if (body.expectedRevision !== this.revision) fail('REVISION_CONFLICT')
    if (target && target.playbackId !== this.player.playbackId) fail('PLAYBACK_CONFLICT')
  }

  private persist(): void {
    this.store.saveState(this.queue, this.player)
  }

  private accepted(requestId: string): MutationResponse {
    this.increment('revision')
    this.persist()
    this.sampleDirty = false
    this.publish()
    return MutationResponseSchema.parse({ requestId, snapshot: this.snapshot() })
  }

  enqueue(context: MutationContext, body: EnqueueRequest): Promise<MutationResponse> {
    return this.serial(() => this.idempotent(context, 'POST', '/api/queue', body, 'any', (principal) => {
      this.checkExpected(body)
      const track = this.catalog.get(body.trackId)
      if (!track) return fail('TRACK_UNAVAILABLE')
      // Every account, including DJs, has at most 50 waiting entries.
      if (this.queue.length >= LIMITS.queueEntries || this.queue.filter((entry) => entry.requester.id === principal.user.id).length >= 50) {
        return fail('QUEUE_FULL')
      }
      this.queue.push({
        entryId: randomUUID(),
        track,
        requester: { id: principal.user.id, username: principal.user.username },
        addedAt: new Date(this.now()).toISOString()
      })
      return this.accepted(body.requestId)
    }))
  }

  remove(context: MutationContext, entryId: string, body: MutationRequest): Promise<MutationResponse> {
    return this.serial(() => this.idempotent(context, 'DELETE', `/api/queue/${entryId}`, body, 'any', (principal) => {
      this.checkExpected(body)
      const index = this.queue.findIndex((entry) => entry.entryId === entryId)
      const entry = this.queue[index]
      if (!entry) return fail('NOT_FOUND')
      if (principal.user.role === 'user' && entry.requester.id !== principal.user.id) return fail('FORBIDDEN')
      this.queue.splice(index, 1)
      return this.accepted(body.requestId)
    }))
  }

  control(context: MutationContext, command: PlayerCommandName, body: PlayerInput): Promise<MutationResponse> {
    return this.serial(() => this.idempotent(context, 'POST', `/api/player/${command}`, body, 'control', async () => {
      this.checkExpected(body, { playbackId: body.targetPlaybackId })
      try {
        await this.command(command, body)
      } catch (error) {
        if (error instanceof DriverError || error instanceof AppError && error.code === 'TRACK_UNAVAILABLE') {
          await this.markFailure(error instanceof DriverError ? error.code as 'PLAYER_UNAVAILABLE' | 'PLAYBACK_FAILED' : 'PLAYBACK_FAILED')
          this.increment('revision')
          this.persist()
          this.publish()
        }
        throw error
      }
      return this.accepted(body.requestId)
    }))
  }

  private async command(command: PlayerCommandName, body: PlayerInput): Promise<void> {
    switch (command) {
      case 'play': {
        if (this.player.status === 'playing') return
        // A paused entry the driver still holds is a plain unpause. A restored entry has nothing
        // loaded yet, so it falls through to a load that resumes at the saved position.
        if (this.player.status === 'paused' && this.loaded) {
          await this.driver.pause(false)
          this.player.status = 'playing'
          return
        }
        // A dead mpv is the one failure a retry can fix: rebuild it once, then resume.
        let repaired = false
        if (this.player.status === 'error' && this.player.error?.code === 'PLAYER_UNAVAILABLE') {
          await this.rebuildDriver()
          repaired = true
        }
        if (this.player.current) {
          await this.load(this.player.current, this.resumeAt ?? 0)
          return
        }
        const entry = this.queue.shift()
        if (entry) {
          await this.load(entry)
          return
        }
        // A rebuild that already succeeded has changed the player. Reporting "nothing to play"
        // without publishing would leave that repair in memory only: the durable state would still
        // say the player is broken, and the next restart would bring the error straight back.
        if (repaired) {
          this.increment('revision')
          this.persist()
          this.publish()
        }
        return fail('NOT_FOUND')
      }
      case 'pause':
        if (!this.player.current || this.player.status === 'paused') return
        if (this.player.status !== 'playing') return fail('PLAYBACK_CONFLICT')
        await this.driver.pause(true)
        this.player.status = 'paused'
        return
      case 'next':
        await this.next()
        return
      case 'previous': {
        const previous = this.history[this.history.length - 1]
        if (!previous) {
          if (!this.player.current) return fail('NOT_FOUND')
          if (this.player.status === 'error') return fail('PLAYBACK_CONFLICT')
          // Rewinding a restored entry is the same deferred seek as any other position.
          if (!this.loaded) {
            this.resumeAt = 0
            this.player.positionSeconds = 0
            return
          }
          await this.driver.seek(0)
          this.player.positionSeconds = 0
          return
        }
        if (this.player.current && this.queue.length >= LIMITS.queueEntries) return fail('QUEUE_FULL')
        this.history.pop()
        if (this.player.current) this.queue.unshift(this.player.current)
        await this.load(previous)
        return
      }
      case 'seek':
        if (!this.player.current || this.player.status === 'error') return fail('PLAYBACK_CONFLICT')
        if (body.positionSeconds === undefined) return fail('VALIDATION_ERROR')
        if (this.player.durationSeconds !== null && body.positionSeconds > this.player.durationSeconds) return fail('VALIDATION_ERROR')
        // A restored entry has no file in the driver yet, so seeking would fail there. Record the
        // offset the first play will seek to instead of losing the entry to a driver error.
        if (!this.loaded) {
          this.resumeAt = body.positionSeconds
          this.player.positionSeconds = body.positionSeconds
          return
        }
        await this.driver.seek(body.positionSeconds)
        this.player.positionSeconds = body.positionSeconds
        return
      case 'volume':
        if (body.volume === undefined) return fail('VALIDATION_ERROR')
        await this.driver.volume(body.volume)
        this.player.volume = body.volume
        return
      case 'mute':
        if (body.muted === undefined) return fail('VALIDATION_ERROR')
        await this.driver.mute(body.muted)
        this.player.muted = body.muted
    }
  }

  private remember(): void {
    if (this.currentStarted && this.player.current) {
      this.history = this.history.filter((entry) => entry.entryId !== this.player.current!.entryId)
      this.history.push(this.player.current)
      if (this.history.length > LIMITS.historyEntries) this.history.shift()
    }
  }

  private async next(): Promise<void> {
    if (!this.player.current && !this.queue.length) return
    const entry = this.queue.shift()
    if (entry) {
      this.remember()
      await this.load(entry)
    } else {
      await this.driver.stop()
      this.remember()
      await this.releaseLease()
      this.currentStarted = false
      this.loaded = false
      this.resumeAt = null
      this.player = { ...this.player, status: 'idle', current: null, playbackId: null, positionSeconds: 0, durationSeconds: null, error: null, warning: null }
    }
  }

  private async load(entry: QueueEntry, startAt = 0): Promise<void> {
    // A retried entry cannot simultaneously remain an addressable historical entry.
    this.history = this.history.filter((historical) => historical.entryId !== entry.entryId)
    this.currentStarted = false
    this.loaded = false
    // Hold the pending offset until the seek actually succeeds. A transient failure must not
    // silently drop the position the user was at, and a crash mid-load must restore it again.
    this.resumeAt = startAt > 0 ? startAt : null
    this.player = {
      ...this.player,
      status: 'loading',
      current: entry,
      playbackId: randomUUID(),
      positionSeconds: startAt,
      durationSeconds: null,
      error: null,
      warning: null
    }
    // Persist consumption before audio starts. A crash cannot put a started entry back in WAITING.
    this.persist()
    await this.driver.stop()
    await this.releaseLease()
    this.lease = await this.catalog.acquire(entry.track.id)
    // The driver starts the file paused and seeks before it plays, so a resumed entry never plays
    // the opening of the track on its way to the saved position.
    await this.driver.load(this.lease.path, this.player.playbackId!, startAt)
    this.resumeAt = null
    this.currentStarted = true
    this.loaded = true
    this.player.status = 'playing'
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease
    this.lease = undefined
    await lease?.close()
  }

  // One rebuild attempt per play command. A failed rebuild keeps the explicit error state.
  private async rebuildDriver(): Promise<void> {
    try {
      await this.driver.restart()
    } catch {
      await this.markFailure('PLAYER_UNAVAILABLE')
      return fail('PLAYER_UNAVAILABLE')
    }
    await this.driver.volume(this.player.volume)
    await this.driver.mute(this.player.muted)
    this.loaded = false
    // A restarted player holds no file; an entry that is still current stays paused, never idle.
    this.player = { ...this.player, status: this.player.current ? 'paused' : 'idle', error: null, warning: null }
    this.announceRecovery()
  }

  private async markFailure(code: 'PLAYER_UNAVAILABLE' | 'PLAYBACK_FAILED'): Promise<void> {
    // Best-effort silence only. Never close(): closing is terminal by design, so using it as the
    // fallback here permanently disabled the rebuild that is the only way back from a dead mpv.
    // restart() already discards the dead child through reset(), so nothing leaks by giving up here.
    await this.driver.stop().catch(() => undefined)
    await this.releaseLease()
    this.loaded = false
    this.player.status = 'error'
    this.player.warning = null
    this.player.error = { code, message: code === 'PLAYER_UNAVAILABLE' ? 'The physical player is unavailable' : 'The local file could not be played' }
  }

  private async onDriverEvent(event: DriverEvent): Promise<void> {
    if (event.type === 'unavailable') {
      if (this.player.status === 'error' && this.player.error?.code === 'PLAYER_UNAVAILABLE') return
      await this.markFailure('PLAYER_UNAVAILABLE')
      this.increment('revision')
      this.persist()
      this.publish()
      return
    }
    if (event.playbackId !== this.player.playbackId || this.player.status === 'error') return
    if (event.type === 'sample') {
      if (event.positionSeconds !== null) this.player.positionSeconds = event.positionSeconds
      this.player.durationSeconds = event.durationSeconds
      this.sampleDirty = true
      return
    }
    if (event.type === 'device') {
      const warning = event.mismatch
        ? { code: 'AUDIO_DEVICE_FALLBACK' as const, message: 'The player is using a different audio output device than configured' }
        : null
      if (this.player.warning?.code === warning?.code) return
      this.player.warning = warning
      this.increment('revision')
      this.persist()
      this.publish()
      return
    }
    if (event.type === 'pause') {
      const status = event.paused ? 'paused' : 'playing'
      if (this.player.status === status || this.player.status === 'loading') return
      this.player.status = status
    } else if (event.reason === 'error') {
      await this.markFailure('PLAYBACK_FAILED')
    } else {
      try {
        await this.next()
      } catch (error) {
        await this.markFailure(error instanceof DriverError && error.code === 'PLAYER_UNAVAILABLE' ? 'PLAYER_UNAVAILABLE' : 'PLAYBACK_FAILED')
      }
    }
    this.increment('revision')
    this.persist()
    this.publish()
  }

  createUser(context: MutationContext, body: CreateUserRequest): Promise<UserMutationResponse> {
    return this.serial(() => this.idempotent(context, 'POST', '/api/admin/users', body, 'admin', async () => {
      const hash = await hashPassword(body.password)
      this.principal(context, 'admin')
      const user = this.store.createAccount(body.username, hash, body.role)
      return { requestId: body.requestId, user }
    }))
  }

  changeRole(context: MutationContext, userId: string, body: UpdateUserRoleRequest): Promise<UserMutationResponse> {
    return this.serial(() => this.idempotent(context, 'PATCH', `/api/admin/users/${userId}/role`, body, 'admin', () => {
      const changed = this.store.changeRole(userId, body.role)
      this.auth.revoke(changed.revoked, 'role_changed')
      return { requestId: body.requestId, user: changed.user }
    }))
  }

  users(principal: Principal): PublicUser[] {
    if (this.auth.byDigest(principal.digest).user.role !== 'admin') return fail('FORBIDDEN')
    return this.store.users()
  }

  private fatalState(): void {
    if (this.closing) return
    // Database/invariant failure is fail-closed: stop producing audio or accepting writes.
    this.closing = true
    clearInterval(this.sampleTimer)
    this.player.status = 'error'
    this.player.error = { code: 'PLAYER_UNAVAILABLE', message: 'The server must be restarted before playback can continue' }
    try {
      this.increment('revision')
      this.publish()
    } catch {
      this.subscribers.clear()
    }
    void this.driver.close().catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closing = true
    clearInterval(this.sampleTimer)
    await this.chain
    this.subscribers.clear()
    this.cache.clear()
    this.cacheBytes = 0
    await this.driver.close()
    await this.releaseLease()
    this.persist()
  }
}
