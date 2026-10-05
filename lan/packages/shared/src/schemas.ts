import { z } from 'zod'
import { API_PATHS, LIMITS } from './constants.js'

export const IdSchema = z.string().uuid()
export const RevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const TimestampSchema = z.string().datetime()
export const RoleSchema = z.enum(['admin', 'dj', 'user'])
export type Role = z.infer<typeof RoleSchema>

export const UsernameSchema = z.string()
  .min(LIMITS.usernameMinLength)
  .max(LIMITS.usernameMaxLength)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)

export const PasswordSchema = z.string()
  .min(LIMITS.passwordMinLength)
  .max(LIMITS.passwordMaxLength)

export const PublicUserSchema = z.object({
  id: IdSchema,
  username: UsernameSchema,
  role: RoleSchema
}).strict()
export type PublicUser = z.infer<typeof PublicUserSchema>

export const RequesterSchema = PublicUserSchema.pick({ id: true, username: true })
export type Requester = z.infer<typeof RequesterSchema>

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(1).max(LIMITS.passwordMaxLength)
}).strict()
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const CsrfTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const SessionResponseSchema = z.object({
  user: PublicUserSchema,
  csrfToken: CsrfTokenSchema,
  expiresAt: TimestampSchema
}).strict()
export type SessionResponse = z.infer<typeof SessionResponseSchema>

export const LogoutRequestSchema = z.object({}).strict()
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>

export const DurationSchema = z.number().finite().min(0).max(LIMITS.maxDurationSeconds)
const DisplayTextSchema = z.string().min(1).max(LIMITS.displayTextMaxLength)

// No filesystem paths, URLs, media bytes or private source descriptors cross this boundary.
export const TrackSchema = z.object({
  id: IdSchema,
  title: DisplayTextSchema,
  artist: DisplayTextSchema.nullable(),
  album: DisplayTextSchema.nullable(),
  durationSeconds: DurationSchema.nullable()
}).strict()
export type Track = z.infer<typeof TrackSchema>

export const QueueEntrySchema = z.object({
  entryId: IdSchema,
  track: TrackSchema,
  requester: RequesterSchema,
  addedAt: TimestampSchema
}).strict()
export type QueueEntry = z.infer<typeof QueueEntrySchema>

export const QueueStateSchema = z.object({
  revision: RevisionSchema,
  entries: z.array(QueueEntrySchema).max(LIMITS.queueEntries)
}).strict().superRefine((queue, context) => {
  const ids = new Set<string>()
  for (const [index, entry] of queue.entries.entries()) {
    if (ids.has(entry.entryId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index, 'entryId'],
        message: 'Queue entry IDs must be unique'
      })
    }
    ids.add(entry.entryId)
  }
})
export type QueueState = z.infer<typeof QueueStateSchema>

export const PlayerStatusSchema = z.enum(['idle', 'loading', 'playing', 'paused', 'error'])
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>

export const PlayerErrorSchema = z.object({
  code: z.enum(['PLAYER_UNAVAILABLE', 'PLAYBACK_FAILED']),
  message: DisplayTextSchema
}).strict()
export type PlayerError = z.infer<typeof PlayerErrorSchema>

// A persistent, non-fatal condition: playback continues, but not where it was configured to.
export const PlayerWarningSchema = z.object({
  code: z.literal('AUDIO_DEVICE_FALLBACK'),
  message: z.string()
}).strict()
export type PlayerWarning = z.infer<typeof PlayerWarningSchema>

export const PlayerSchema = z.object({
  status: PlayerStatusSchema,
  current: QueueEntrySchema.nullable(),
  playbackId: IdSchema.nullable(),
  positionSeconds: DurationSchema,
  durationSeconds: DurationSchema.nullable(),
  volume: z.number().int().min(0).max(100),
  muted: z.boolean(),
  error: PlayerErrorSchema.nullable(),
  warning: PlayerWarningSchema.nullable()
}).strict().superRefine((player, context) => {
  const issue = (path: string, message: string) => {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })
  }
  if ((player.current === null) !== (player.playbackId === null)) {
    issue('playbackId', 'Current entry and playback ID must both be null or both be set')
  }
  if (player.current === null && (player.positionSeconds !== 0 || player.durationSeconds !== null)) {
    issue('positionSeconds', 'A player without a current entry has no position or duration')
  }
  if (['loading', 'playing', 'paused'].includes(player.status) && player.current === null) {
    issue('current', 'An active player requires a current entry')
  }
  if (player.status === 'idle' && player.current !== null) {
    issue('current', 'An idle player cannot have a current entry')
  }
  if ((player.status === 'error') !== (player.error !== null)) {
    issue('error', 'Only an error status carries a player error')
  }
  if (player.warning !== null && player.current === null) {
    issue('warning', 'A player warning requires a current entry')
  }
})
export type Player = z.infer<typeof PlayerSchema>

export const SnapshotSchema = z.object({
  serverInstanceId: IdSchema,
  eventSeq: RevisionSchema,
  simulation: z.boolean(),
  player: PlayerSchema,
  queue: QueueStateSchema
}).strict().superRefine((snapshot, context) => {
  if (snapshot.player.current && snapshot.queue.entries.some(
    (entry) => entry.entryId === snapshot.player.current?.entryId
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['queue', 'entries'],
      message: 'The current entry is not a waiting entry'
    })
  }
})
export type Snapshot = z.infer<typeof SnapshotSchema>

const queryInteger = (min: number, max: number, fallback: number) => z.preprocess(
  (value) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(min).max(max).default(fallback)
)

export const TrackListQuerySchema = z.object({
  q: z.string().max(LIMITS.searchMaxLength).default(''),
  offset: queryInteger(0, LIMITS.tracks, 0),
  limit: queryInteger(1, LIMITS.trackPageMaxSize, LIMITS.trackPageSize)
}).strict()
export type TrackListQuery = z.infer<typeof TrackListQuerySchema>

export const TrackListResponseSchema = z.object({
  tracks: z.array(TrackSchema).max(LIMITS.trackPageMaxSize),
  total: z.number().int().min(0).max(LIMITS.tracks),
  offset: z.number().int().min(0).max(LIMITS.tracks),
  limit: z.number().int().min(1).max(LIMITS.trackPageMaxSize)
}).strict()
export type TrackListResponse = z.infer<typeof TrackListResponseSchema>

// All shared-player writes are conditional on one observed server instance/revision.
export const MutationRequestSchema = z.object({
  requestId: IdSchema,
  serverInstanceId: IdSchema,
  expectedRevision: RevisionSchema
}).strict()
export type MutationRequest = z.infer<typeof MutationRequestSchema>

export const EnqueueRequestSchema = MutationRequestSchema.extend({ trackId: IdSchema })
export type EnqueueRequest = z.infer<typeof EnqueueRequestSchema>

export const RemoveQueueEntryRequestSchema = MutationRequestSchema
export type RemoveQueueEntryRequest = z.infer<typeof RemoveQueueEntryRequestSchema>

// Null is meaningful: the caller observed no current playback, not "any playback".
export const PlaybackRequestSchema = MutationRequestSchema.extend({
  targetPlaybackId: IdSchema.nullable()
})
export type PlaybackRequest = z.infer<typeof PlaybackRequestSchema>

export const PlayRequestSchema = PlaybackRequestSchema
export const PauseRequestSchema = PlaybackRequestSchema
export const NextRequestSchema = PlaybackRequestSchema
export const PreviousRequestSchema = PlaybackRequestSchema
export const SeekRequestSchema = PlaybackRequestSchema.extend({ positionSeconds: DurationSchema })
export const VolumeRequestSchema = PlaybackRequestSchema.extend({ volume: z.number().int().min(0).max(100) })
export const MuteRequestSchema = PlaybackRequestSchema.extend({ muted: z.boolean() })
export type PlayRequest = z.infer<typeof PlayRequestSchema>
export type PauseRequest = z.infer<typeof PauseRequestSchema>
export type NextRequest = z.infer<typeof NextRequestSchema>
export type PreviousRequest = z.infer<typeof PreviousRequestSchema>
export type SeekRequest = z.infer<typeof SeekRequestSchema>
export type VolumeRequest = z.infer<typeof VolumeRequestSchema>
export type MuteRequest = z.infer<typeof MuteRequestSchema>

export const PlayerCommandNameSchema = z.enum(['play', 'pause', 'next', 'previous', 'seek', 'volume', 'mute'])
export type PlayerCommandName = z.infer<typeof PlayerCommandNameSchema>
export const PlayerCommandSchemas = {
  play: PlayRequestSchema,
  pause: PauseRequestSchema,
  next: NextRequestSchema,
  previous: PreviousRequestSchema,
  seek: SeekRequestSchema,
  volume: VolumeRequestSchema,
  mute: MuteRequestSchema
} as const
export const playerCommandPath = (command: PlayerCommandName) => `${API_PATHS.player}/${command}`

export const MutationResponseSchema = z.object({
  requestId: IdSchema,
  snapshot: SnapshotSchema
}).strict()
export type MutationResponse = z.infer<typeof MutationResponseSchema>

export const CreateUserRequestSchema = z.object({
  requestId: IdSchema,
  username: UsernameSchema,
  password: PasswordSchema,
  role: RoleSchema
}).strict()
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>

export const UpdateUserRoleRequestSchema = z.object({
  requestId: IdSchema,
  role: RoleSchema
}).strict()
export type UpdateUserRoleRequest = z.infer<typeof UpdateUserRoleRequestSchema>

export const UserListResponseSchema = z.object({
  users: z.array(PublicUserSchema).max(LIMITS.users)
}).strict()
export type UserListResponse = z.infer<typeof UserListResponseSchema>

export const UserMutationResponseSchema = z.object({
  requestId: IdSchema,
  user: PublicUserSchema
}).strict()
export type UserMutationResponse = z.infer<typeof UserMutationResponseSchema>

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_REJECTED',
  'CSRF_INVALID',
  'RATE_LIMITED',
  'NOT_FOUND',
  'INSTANCE_CONFLICT',
  'REVISION_CONFLICT',
  'PLAYBACK_CONFLICT',
  'REQUEST_ID_REUSED',
  'QUEUE_FULL',
  'TRACK_UNAVAILABLE',
  'PLAYER_UNAVAILABLE',
  'PLAYBACK_FAILED',
  'USERNAME_TAKEN',
  'LAST_ADMIN',
  'USER_LIMIT',
  'INTERNAL_ERROR'
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: DisplayTextSchema,
    requestId: IdSchema.optional()
  }).strict()
}).strict()
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ORIGIN_REJECTED: 403,
  CSRF_INVALID: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  INSTANCE_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  PLAYBACK_CONFLICT: 409,
  REQUEST_ID_REUSED: 409,
  QUEUE_FULL: 409,
  TRACK_UNAVAILABLE: 409,
  PLAYER_UNAVAILABLE: 503,
  PLAYBACK_FAILED: 502,
  USERNAME_TAKEN: 409,
  LAST_ADMIN: 409,
  USER_LIMIT: 409,
  INTERNAL_ERROR: 500
} as const satisfies Record<ErrorCode, number>

export const SnapshotEventSchema = z.object({
  type: z.literal('snapshot'),
  snapshot: SnapshotSchema
}).strict()
export type SnapshotEvent = z.infer<typeof SnapshotEventSchema>

export const SessionRevokedReasonSchema = z.enum(['logout', 'expired', 'role_changed'])
export type SessionRevokedReason = z.infer<typeof SessionRevokedReasonSchema>
export const SessionRevokedEventSchema = z.object({
  type: z.literal('session.revoked'),
  serverInstanceId: IdSchema,
  eventSeq: RevisionSchema,
  reason: SessionRevokedReasonSchema
}).strict()
export type SessionRevokedEvent = z.infer<typeof SessionRevokedEventSchema>

// A rebuilt player is announced explicitly so clients never resume silently.
export const PlayerRecoveredEventSchema = z.object({
  type: z.literal('player.recovered'),
  serverInstanceId: IdSchema,
  eventSeq: RevisionSchema,
  reason: z.literal('driver_rebuilt')
}).strict()
export type PlayerRecoveredEvent = z.infer<typeof PlayerRecoveredEventSchema>

export const ServerEventSchema = z.discriminatedUnion('type', [
  SnapshotEventSchema,
  SessionRevokedEventSchema,
  PlayerRecoveredEventSchema
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
