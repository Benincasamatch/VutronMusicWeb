import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutationResponse, SessionResponse, TrackListResponse } from '@lan/shared'
import { ApiError } from '../src/api/client'
import type { ApiClient } from '../src/api/client'
import type { EventHandlers } from '../src/api/events'
import { createRoomStore } from '../src/stores/room'
import { NOW, deferred, entry, instanceA, instanceB, playing, session, snapshot, track, uuid } from './fixtures'

const stops: Array<() => void> = []

async function settle() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

function harness(initial = snapshot(), identity = session()) {
  const api: ApiClient = {
    me: vi.fn<ApiClient['me']>(async () => identity),
    login: vi.fn<ApiClient['login']>(async () => identity),
    logout: vi.fn<ApiClient['logout']>(async () => undefined),
    state: vi.fn<ApiClient['state']>(async () => initial),
    tracks: vi.fn<ApiClient['tracks']>(async () => ({ tracks: [track], total: 1, offset: 0, limit: 50 })),
    enqueue: vi.fn<ApiClient['enqueue']>(async (input) => ({ requestId: input.requestId, snapshot: initial })),
    remove: vi.fn<ApiClient['remove']>(async (_id, input) => ({ requestId: input.requestId, snapshot: initial })),
    command: vi.fn<ApiClient['command']>(async (_intent, input) => ({ requestId: input.requestId, snapshot: initial })),
    users: vi.fn<ApiClient['users']>(async () => ({ users: [identity.user] })),
    createUser: vi.fn<ApiClient['createUser']>(async (input) => ({ requestId: input.requestId, user: { id: uuid(60), username: input.username, role: input.role } })),
    updateRole: vi.fn<ApiClient['updateRole']>(async (id, input) => ({ requestId: input.requestId, user: { ...identity.user, id, role: input.role } }))
  }
  const sockets: Array<{ handlers: EventHandlers, close: ReturnType<typeof vi.fn> }> = []
  let id = 100
  const store = createRoomStore({
    api,
    openEvents: (_token, handlers) => {
      const socket = { handlers, close: vi.fn() }
      sockets.push(socket)
      return socket
    },
    requestId: () => uuid(++id),
    now: () => Date.now(),
    monotonicNow: () => Date.now(),
    random: () => 0.5
  })(createPinia())
  stops.push(() => store.stop())
  const emit = (value = initial, index = sockets.length - 1) => {
    sockets[index]!.handlers.message(JSON.stringify({ type: 'snapshot', snapshot: value }))
  }
  const connect = async () => {
    store.start()
    await settle()
    emit()
    await settle()
  }
  return { store, api, sockets, emit, connect }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('authoritative listening-room state', () => {
  it('requires session, HTTP state and the first WS snapshot before enabling controls', async () => {
    const h = harness()
    h.store.start()
    await settle()
    expect(h.api.me).toHaveBeenCalledTimes(1)
    expect(h.api.state).toHaveBeenCalledTimes(1)
    expect(h.store.snapshot).toEqual(snapshot())
    expect(h.store.canWrite).toBe(false)
    expect(h.store.connection).toBe('connecting')
    h.emit(snapshot({ eventSeq: 30, queue: { revision: 3, entries: [] }, simulation: true }))
    await settle()
    expect(h.store.canWrite).toBe(true)
    expect(h.store.snapshot?.simulation).toBe(true)
    expect(h.store.snapshot?.eventSeq).toBe(30)
    expect(h.api.state).toHaveBeenCalledTimes(1)
    h.emit(snapshot({ eventSeq: 29 }))
    expect(h.store.snapshot?.eventSeq).toBe(30)
  })

  it('orders HTTP acknowledgements against newer full WS snapshots and sends real revision metadata', async () => {
    const h = harness()
    await h.connect()
    const pending = deferred<MutationResponse>()
    vi.mocked(h.api.enqueue).mockReturnValueOnce(pending.promise)
    const mutation = h.store.enqueue(track.id)
    const [body, csrf] = vi.mocked(h.api.enqueue).mock.calls[0]!
    expect(body).toEqual({ requestId: uuid(101), serverInstanceId: instanceA, expectedRevision: 1, trackId: track.id })
    expect(csrf).toBe(session().csrfToken)
    expect(h.store.canWrite).toBe(false)
    h.emit(snapshot({ eventSeq: 20, queue: { revision: 4, entries: [] } }))
    pending.resolve({ requestId: body.requestId, snapshot: snapshot({ eventSeq: 2, queue: { revision: 2, entries: [entry] } }) })
    await mutation
    expect(h.store.snapshot?.eventSeq).toBe(20)
    expect(h.store.snapshot?.queue.entries).toEqual([])
    await h.store.enqueue(track.id)
    expect(vi.mocked(h.api.enqueue).mock.calls[1]![0]).toMatchObject({ requestId: uuid(102), expectedRevision: 4 })
  })

  it('does not reset progress sampling on an equal sequence', async () => {
    const h = harness(playing())
    await h.connect()
    const sampledAt = h.store.sampledAt
    vi.setSystemTime(NOW + 1000)
    h.emit(playing())
    expect(h.store.sampledAt).toBe(sampledAt)
    h.emit(playing({ eventSeq: 3 }))
    expect(h.store.sampledAt).toBe(NOW + 1000)
  })

  it('disables actions on disconnect and never resends pending or offline writes', async () => {
    const h = harness()
    await h.connect()
    const pending = deferred<MutationResponse>()
    vi.mocked(h.api.enqueue).mockReturnValueOnce(pending.promise)
    const mutation = h.store.enqueue(track.id)
    const [body, , requestSignal] = vi.mocked(h.api.enqueue).mock.calls[0]!
    h.sockets[0]!.handlers.closed(1006)
    expect(h.store.connected).toBe(false)
    expect(h.store.busy).toBeNull()
    expect(requestSignal.aborted).toBe(true)
    expect(await h.store.enqueue(track.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    h.emit(snapshot({ eventSeq: 5 }))
    pending.resolve({ requestId: body.requestId, snapshot: snapshot({ eventSeq: 100 }) })
    await mutation
    expect(h.store.snapshot?.eventSeq).toBe(5)
    expect(h.api.enqueue).toHaveBeenCalledTimes(1)
    expect(h.api.me).toHaveBeenCalledTimes(2)
  })

  it('retires old epochs and late requests before accepting a server restart', async () => {
    const h = harness()
    await h.connect()
    const pending = deferred<MutationResponse>()
    vi.mocked(h.api.enqueue).mockReturnValueOnce(pending.promise)
    const mutation = h.store.enqueue(track.id)
    const body = vi.mocked(h.api.enqueue).mock.calls[0]![0]
    const recheck = deferred<SessionResponse>()
    vi.mocked(h.api.me).mockReturnValueOnce(recheck.promise)
    vi.mocked(h.api.state).mockResolvedValue(snapshot({ serverInstanceId: instanceB, eventSeq: 0 }))
    h.emit(snapshot({ serverInstanceId: instanceB, eventSeq: 1 }))
    expect(h.store.session).toBeNull()
    expect(h.store.snapshot).toBeNull()
    expect(h.store.canWrite).toBe(false)
    recheck.resolve(session())
    await settle()
    h.emit(snapshot({ serverInstanceId: instanceB, eventSeq: 2 }))
    pending.resolve({ requestId: body.requestId, snapshot: snapshot({ eventSeq: 999 }) })
    await mutation
    h.emit(snapshot({ eventSeq: 1000 }), 0)
    expect(h.store.snapshot?.serverInstanceId).toBe(instanceB)
    expect(h.store.snapshot?.eventSeq).toBe(2)
    expect(h.api.enqueue).toHaveBeenCalledTimes(1)
  })

  it('honors low-sequence revocation, clears protected data, and ignores stale socket revocations after login', async () => {
    const h = harness(snapshot({ eventSeq: 90 }))
    await h.connect()
    await h.store.loadUsers()
    vi.mocked(h.api.me).mockRejectedValueOnce(new ApiError('UNAUTHENTICATED', 401))
    h.sockets[0]!.handlers.message(JSON.stringify({ type: 'session.revoked', serverInstanceId: instanceA, eventSeq: 2, reason: 'role_changed' }))
    expect(h.store.session).toBeNull()
    expect(h.store.snapshot).toBeNull()
    expect(h.store.tracks).toEqual([])
    expect(h.store.users).toEqual([])
    await settle()
    expect(h.store.connection).toBe('signed-out')
    await h.store.login({ username: 'listener', password: 'valid-password' })
    h.emit(snapshot({ eventSeq: 91 }))
    expect(h.store.session).not.toBeNull()
    h.sockets[0]!.handlers.message(JSON.stringify({ type: 'session.revoked', serverInstanceId: instanceA, eventSeq: 99, reason: 'logout' }))
    h.sockets[0]!.handlers.closed(4001)
    expect(h.store.session).not.toBeNull()
    expect(h.store.connected).toBe(true)
  })

  it('recovers authentication from a bare 4001 close even without a revocation frame', async () => {
    const h = harness()
    await h.connect()
    vi.mocked(h.api.me).mockRejectedValueOnce(new ApiError('UNAUTHENTICATED', 401))
    h.sockets[0]!.handlers.closed(4001)
    expect(h.store.session).toBeNull()
    await settle()
    expect(h.api.me).toHaveBeenCalledTimes(2)
    expect(h.store.connection).toBe('signed-out')
  })

  it('expires the local session even if the socket never delivers an expiry event', async () => {
    const h = harness(snapshot(), { ...session(), expiresAt: new Date(NOW + 2000).toISOString() })
    await h.connect()
    vi.mocked(h.api.me).mockRejectedValueOnce(new ApiError('UNAUTHENTICATED', 401))
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.store.session).toBeNull()
    expect(h.store.snapshot).toBeNull()
    expect(h.store.connection).toBe('signed-out')
  })

  it.each(['UNAUTHENTICATED', 'CSRF_INVALID'] as const)('rechecks /me after %s without replaying the failed write', async (code) => {
    const h = harness()
    await h.connect()
    vi.mocked(h.api.enqueue).mockRejectedValueOnce(new ApiError(code))
    await h.store.enqueue(track.id)
    await settle()
    expect(h.api.me).toHaveBeenCalledTimes(2)
    expect(h.api.enqueue).toHaveBeenCalledTimes(1)
    expect(h.store.canWrite).toBe(false)
    h.emit()
    expect(h.store.canWrite).toBe(true)
  })

  it('refreshes after revision conflict, requiring a new explicit user intent', async () => {
    const h = harness()
    await h.connect()
    vi.mocked(h.api.enqueue).mockRejectedValueOnce(new ApiError('REVISION_CONFLICT', 409))
    vi.mocked(h.api.state).mockResolvedValueOnce(snapshot({ eventSeq: 7, queue: { revision: 3, entries: [] } }))
    await h.store.enqueue(track.id)
    await settle()
    expect(h.api.enqueue).toHaveBeenCalledTimes(1)
    expect(h.store.canWrite).toBe(false)
    h.emit(snapshot({ eventSeq: 8, queue: { revision: 3, entries: [] } }))
    await h.store.enqueue(track.id)
    expect(vi.mocked(h.api.enqueue).mock.calls[1]![0]).toMatchObject({ expectedRevision: 3, requestId: uuid(102) })
  })

  it('uses role and ownership for presentation, never removes current playback through the queue API', async () => {
    const other = { ...entry, entryId: uuid(21), requester: { id: uuid(31), username: 'someone' } }
    const h = harness(snapshot({ queue: { revision: 1, entries: [entry, other] } }), session('user'))
    await h.connect()
    expect(await h.store.command({ command: 'play' }, null)).toBe(false)
    expect(await h.store.remove(other.entryId)).toBe(false)
    expect(await h.store.remove(uuid(999))).toBe(false)
    expect(h.api.command).not.toHaveBeenCalled()
    expect(h.api.remove).not.toHaveBeenCalled()
    await h.store.remove(entry.entryId)
    expect(h.api.remove).toHaveBeenCalledTimes(1)
    expect(await h.store.createUser({ username: 'new-account', password: 'long-password', role: 'user' })).toBe(false)
    expect(h.api.createUser).not.toHaveBeenCalled()
  })

  it('does not retarget a seek after the playback identity changes', async () => {
    const h = harness(playing())
    await h.connect()
    expect(await h.store.command({ command: 'seek', positionSeconds: 50 }, uuid(41))).toBe(false)
    expect(h.api.command).not.toHaveBeenCalled()
    await h.store.command({ command: 'seek', positionSeconds: 50 }, uuid(40))
    expect(vi.mocked(h.api.command).mock.calls[0]![1]).toMatchObject({ targetPlaybackId: uuid(40), expectedRevision: 1 })
  })

  it('clears the acting admin session after a self role change', async () => {
    const h = harness()
    await h.connect()
    vi.mocked(h.api.me).mockRejectedValueOnce(new ApiError('UNAUTHENTICATED', 401))
    await h.store.updateRole(session().user.id, 'dj')
    await settle()
    expect(h.store.admin).toBe(false)
    expect(h.store.session).toBeNull()
    expect(h.store.users).toEqual([])
    expect(h.api.updateRole).toHaveBeenCalledTimes(1)
  })

  it('does not let a late search overwrite a newer query', async () => {
    const h = harness()
    await h.connect()
    const first = deferred<TrackListResponse>()
    const second = deferred<TrackListResponse>()
    vi.mocked(h.api.tracks).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = h.store.loadCatalog('first')
    const b = h.store.loadCatalog('second')
    second.resolve({ tracks: [], total: 0, offset: 0, limit: 50 })
    await b
    first.resolve({ tracks: [track], total: 1, offset: 0, limit: 50 })
    await a
    expect(h.store.search).toBe('second')
    expect(h.store.tracks).toEqual([])
    expect(h.store.totalTracks).toBe(0)
  })

  it('clears protected state after confirmed logout without changing the physical player', async () => {
    const h = harness(playing())
    await h.connect()
    await h.store.logout()
    expect(h.store.session).toBeNull()
    expect(h.store.snapshot).toBeNull()
    expect(h.store.tracks).toEqual([])
    expect(h.store.connection).toBe('signed-out')
    expect(h.api.command).not.toHaveBeenCalled()
    expect(h.api.logout).toHaveBeenCalledTimes(1)
  })

  it('rechecks an uncertain login without repeating credentials', async () => {
    const h = harness()
    vi.mocked(h.api.me).mockRejectedValueOnce(new ApiError('UNAUTHENTICATED', 401))
    h.store.start()
    await settle()
    vi.mocked(h.api.login).mockRejectedValueOnce(new ApiError('NETWORK_ERROR'))
    await h.store.login({ username: 'listener', password: 'valid-password' })
    await settle()
    expect(h.api.login).toHaveBeenCalledTimes(1)
    expect(h.api.me).toHaveBeenCalledTimes(2)
    expect(h.store.connection).toBe('connecting')
    h.emit()
    expect(h.store.connected).toBe(true)
  })

  it('does not enable controls when an open socket never sends its initial snapshot', async () => {
    const h = harness()
    h.store.start()
    await settle()
    expect(h.store.canWrite).toBe(false)
    await vi.advanceTimersByTimeAsync(12000)
    expect(h.store.canWrite).toBe(false)
    expect(h.store.connection).toBe('reconnecting')
    expect(h.sockets[0]!.close).toHaveBeenCalledTimes(1)
  })

  it('disables controls when a live message fails the shared schema', async () => {
    const h = harness()
    await h.connect()
    h.sockets[0]!.handlers.message(JSON.stringify({ type: 'snapshot', snapshot: { ...snapshot(), unsafe: true } }))
    expect(h.store.connected).toBe(false)
    expect(h.store.notice?.kind).toBe('error')
  })

  it('surfaces an explicit notice when the server reports a rebuilt player', async () => {
    const h = harness()
    await h.connect()
    h.sockets[0]!.handlers.message(JSON.stringify({ type: 'player.recovered', serverInstanceId: instanceA, eventSeq: 99, reason: 'driver_rebuilt' }))
    expect(h.store.notice?.kind).toBe('info')
    expect(h.store.notice?.text).toContain('实体播放器已重新连接')
    expect(h.store.connected).toBe(true)
  })
})
