import { describe, expect, it } from 'vitest'
import {
  API_PATHS,
  CreateUserRequestSchema,
  CsrfTokenSchema,
  EnqueueRequestSchema,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  ErrorResponseSchema,
  LIMITS,
  MuteRequestSchema,
  PasswordSchema,
  PlayerSchema,
  PlayRequestSchema,
  PublicUserSchema,
  QueueStateSchema,
  RoleSchema,
  SeekRequestSchema,
  ServerEventSchema,
  SessionResponseSchema,
  SnapshotSchema,
  TrackListQuerySchema,
  TrackSchema,
  UsernameSchema,
  VolumeRequestSchema,
  canControlPlayback,
  canManageUsers,
  canRemoveWaitingEntry,
  playerCommandPath,
  queueEntryPath,
  userRolePath
} from '../src/index.js'
import type { Player, PublicUser, QueueEntry, Snapshot, Track } from '../src/index.js'

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const user: PublicUser = { id: id(1), username: 'listener', role: 'user' }
const track: Track = {
  id: id(2),
  title: 'Local recording',
  artist: null,
  album: null,
  durationSeconds: null
}
const entry: QueueEntry = {
  entryId: id(3),
  track,
  requester: { id: user.id, username: user.username },
  addedAt: '2026-01-01T00:00:00.000Z'
}
const player: Player = {
  status: 'idle',
  current: null,
  playbackId: null,
  positionSeconds: 0,
  durationSeconds: null,
  volume: 50,
  muted: false,
  error: null,
  warning: null
}
const snapshot: Snapshot = {
  serverInstanceId: id(4),
  eventSeq: 0,
  simulation: false,
  player,
  queue: { revision: 0, entries: [entry] }
}
const mutation = { requestId: id(5), serverInstanceId: snapshot.serverInstanceId, expectedRevision: 0 }
const playbackRequest = { ...mutation, targetPlaybackId: null }

describe('public domain boundary', () => {
  it('accepts only the three application roles', () => {
    expect(RoleSchema.options).toEqual(['admin', 'dj', 'user'])
    expect(RoleSchema.safeParse('root').success).toBe(false)
  })

  it('rejects private identity and filesystem fields instead of silently dropping them', () => {
    expect(PublicUserSchema.safeParse({ ...user, passwordHash: 'private' }).success).toBe(false)
    expect(TrackSchema.safeParse({ ...track, path: '/music/private.flac' }).success).toBe(false)
    expect(TrackSchema.safeParse({ ...track, url: 'file:///music/private.flac' }).success).toBe(false)
    expect(TrackSchema.parse(track)).toEqual(track)
  })

  it('uses stable lowercase usernames and never trims passwords', () => {
    expect(UsernameSchema.safeParse('Bad Name').success).toBe(false)
    expect(UsernameSchema.safeParse('ab').success).toBe(false)
    expect(UsernameSchema.parse('a.b-c_d')).toBe('a.b-c_d')
    expect(PasswordSchema.parse(' password123 ')).toBe(' password123 ')
    expect(PasswordSchema.safeParse('short').success).toBe(false)
    expect(PasswordSchema.safeParse('x'.repeat(129)).success).toBe(false)
  })

  it('returns a CSRF token but never the session cookie or password', () => {
    const session = { user, csrfToken: 'a'.repeat(43), expiresAt: '2026-01-01T12:00:00.000Z' }
    expect(SessionResponseSchema.parse(session)).toEqual(session)
    expect(CsrfTokenSchema.safeParse('short').success).toBe(false)
    expect(SessionResponseSchema.safeParse({ ...session, sessionToken: 'secret' }).success).toBe(false)
    expect(CreateUserRequestSchema.safeParse({
      requestId: id(5), username: 'new-user', password: 'short', role: 'admin'
    }).success).toBe(false)
  })
})

describe('authoritative queue and player invariants', () => {
  it('validates an idle snapshot and requires an explicit simulation flag', () => {
    expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot)
    const { simulation, ...missingFlag } = snapshot
    expect(simulation).toBe(false)
    expect(SnapshotSchema.safeParse(missingFlag).success).toBe(false)
  })

  it('requires a matched current entry/playback ID pair for active playback', () => {
    expect(PlayerSchema.safeParse({ ...player, status: 'playing' }).success).toBe(false)
    expect(PlayerSchema.safeParse({ ...player, playbackId: id(6) }).success).toBe(false)
    expect(PlayerSchema.safeParse({ ...player, positionSeconds: 2 }).success).toBe(false)
    expect(PlayerSchema.safeParse({
      ...player, status: 'playing', current: entry, playbackId: id(6), positionSeconds: 2
    }).success).toBe(true)
  })

  it('never places the current entry in the waiting list', () => {
    expect(SnapshotSchema.safeParse({
      ...snapshot,
      player: { ...player, status: 'playing', current: entry, playbackId: id(6) }
    }).success).toBe(false)
  })

  it('allows duplicate tracks but not duplicate queue entry IDs', () => {
    expect(QueueStateSchema.safeParse({ revision: 0, entries: [entry, entry] }).success).toBe(false)
    expect(QueueStateSchema.safeParse({
      revision: 0, entries: [entry, { ...entry, entryId: id(7) }]
    }).success).toBe(true)
  })

  it('caps queue size and requires safe integer revisions', () => {
    const entries = Array.from({ length: LIMITS.queueEntries + 1 }, (_, index) => ({
      ...entry, entryId: id(index + 1)
    }))
    expect(QueueStateSchema.safeParse({ revision: 0, entries }).success).toBe(false)
    expect(QueueStateSchema.safeParse({ revision: 0.5, entries: [] }).success).toBe(false)
    expect(QueueStateSchema.safeParse({ revision: Number.MAX_SAFE_INTEGER + 1, entries: [] }).success).toBe(false)
  })

  it('makes physical driver failures visible', () => {
    expect(PlayerSchema.safeParse({ ...player, status: 'error' }).success).toBe(false)
    expect(PlayerSchema.safeParse({
      ...player, status: 'error', error: { code: 'PLAYER_UNAVAILABLE', message: 'Player unavailable' }
    }).success).toBe(true)
  })
})

describe('request validation', () => {
  it('requires server instance, revision and request ID on queue writes', () => {
    expect(EnqueueRequestSchema.parse({ ...mutation, trackId: track.id }).trackId).toBe(track.id)
    expect(EnqueueRequestSchema.safeParse({ requestId: id(5), trackId: track.id }).success).toBe(false)
    expect(EnqueueRequestSchema.safeParse({ ...mutation, trackId: '../../private' }).success).toBe(false)
  })

  it('requires an explicit playback target, including null for an idle observation', () => {
    expect(PlayRequestSchema.safeParse(mutation).success).toBe(false)
    expect(PlayRequestSchema.parse(playbackRequest).targetPlaybackId).toBeNull()
    expect(SeekRequestSchema.safeParse({ ...playbackRequest, positionSeconds: -1 }).success).toBe(false)
    expect(SeekRequestSchema.safeParse({ ...playbackRequest, positionSeconds: Infinity }).success).toBe(false)
  })

  it('uses bounded integer volume and a boolean mute flag without coercion', () => {
    for (const volume of [-1, 101, 1.5, '50']) {
      expect(VolumeRequestSchema.safeParse({ ...playbackRequest, volume }).success).toBe(false)
    }
    expect(VolumeRequestSchema.parse({ ...playbackRequest, volume: 0 }).volume).toBe(0)
    expect(MuteRequestSchema.safeParse({ ...playbackRequest, muted: 'true' }).success).toBe(false)
  })

  it('parses only bounded scalar pagination parameters', () => {
    expect(TrackListQuerySchema.parse({})).toEqual({ q: '', offset: 0, limit: 50 })
    expect(TrackListQuerySchema.parse({ offset: '10', limit: '20', q: 'Live' })).toEqual({
      offset: 10, limit: 20, q: 'Live'
    })
    for (const limit of ['-1', '1.5', '101', ['10'], true, '']) {
      expect(TrackListQuerySchema.safeParse({ limit }).success).toBe(false)
    }
  })
})

describe('permissions and transport', () => {
  it('restricts controls to admin/dj and user management to admin', () => {
    expect(canControlPlayback('user')).toBe(false)
    expect(canControlPlayback('dj')).toBe(true)
    expect(canControlPlayback('admin')).toBe(true)
    expect(canManageUsers('dj')).toBe(false)
    expect(canManageUsers('admin')).toBe(true)
    expect(canRemoveWaitingEntry(user, entry)).toBe(true)
    expect(canRemoveWaitingEntry({ ...user, id: id(8) }, entry)).toBe(false)
    expect(canRemoveWaitingEntry({ ...user, id: id(8), role: 'dj' }, entry)).toBe(true)
  })

  it('provides same-origin endpoint paths and encodes path parameters', () => {
    expect(playerCommandPath('seek')).toBe('/api/player/seek')
    expect(queueEntryPath('../other')).toBe(`${API_PATHS.queue}/..%2Fother`)
    expect(userRolePath('a/b')).toBe('/api/admin/users/a%2Fb/role')
  })

  it('validates snapshots and private session revocations as distinct events', () => {
    expect(ServerEventSchema.parse({ type: 'snapshot', snapshot }).type).toBe('snapshot')
    expect(ServerEventSchema.safeParse({
      type: 'session.revoked', serverInstanceId: id(4), eventSeq: 1, reason: 'role_changed'
    }).success).toBe(true)
    expect(ServerEventSchema.safeParse({ type: 'audio', bytes: 'forbidden' }).success).toBe(false)
  })

  it('has a status mapping for each safe error code and rejects stack leaks', () => {
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ErrorCodeSchema.options].sort())
    expect(ErrorResponseSchema.safeParse({
      error: { code: 'INTERNAL_ERROR', message: 'Operation failed', stack: '/private/server.ts' }
    }).success).toBe(false)
  })
})
