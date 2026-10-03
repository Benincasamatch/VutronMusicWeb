export const LIMITS = {
  usernameMinLength: 3,
  usernameMaxLength: 32,
  passwordMinLength: 12,
  passwordMaxLength: 128,
  displayTextMaxLength: 256,
  queueEntries: 500,
  tracks: 10000,
  users: 500,
  trackPageSize: 50,
  trackPageMaxSize: 100,
  searchMaxLength: 128,
  maxDurationSeconds: 604800,
  historyEntries: 50,
  httpBodyBytes: 16384,
  sessionTtlMs: 43200000,
  sessionsPerUser: 10,
  socketsPerSession: 3,
  socketClientPayloadBytes: 1024,
  socketBufferedBytes: 4194304,
  socketHeartbeatMs: 30000,
  socketTimeoutMs: 60000,
  idempotencyTtlMs: 60000,
  idempotencyEntriesPerSession: 100,
  httpRequestsPerMinute: 120,
  loginAttemptsPerMinute: 10,
  mutationsPerMinute: 30
} as const

export const SESSION_COOKIE_NAME = 'lan_session'
export const CSRF_HEADER_NAME = 'x-csrf-token'
export const WS_PROTOCOL = 'lan.v1'
export const WS_CSRF_PROTOCOL_PREFIX = 'csrf.'
export const WS_SESSION_REVOKED_CLOSE_CODE = 4001

export const API_PATHS = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  me: '/api/auth/me',
  tracks: '/api/tracks',
  state: '/api/state',
  queue: '/api/queue',
  player: '/api/player',
  users: '/api/admin/users',
  events: '/api/events'
} as const

export const queueEntryPath = (entryId: string) => `${API_PATHS.queue}/${encodeURIComponent(entryId)}`
export const userRolePath = (userId: string) => `${API_PATHS.users}/${encodeURIComponent(userId)}/role`
