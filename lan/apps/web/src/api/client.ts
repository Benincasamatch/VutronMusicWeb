import {
  API_PATHS,
  CSRF_HEADER_NAME,
  CreateUserRequestSchema,
  EnqueueRequestSchema,
  ErrorResponseSchema,
  IdSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  MutationResponseSchema,
  PlayerCommandSchemas,
  RemoveQueueEntryRequestSchema,
  SessionResponseSchema,
  SnapshotSchema,
  TrackListQuerySchema,
  TrackListResponseSchema,
  UpdateUserRoleRequestSchema,
  UserListResponseSchema,
  UserMutationResponseSchema,
  playerCommandPath,
  queueEntryPath,
  userRolePath
} from '@lan/shared'
import type {
  CreateUserRequest,
  EnqueueRequest,
  ErrorCode,
  LoginRequest,
  MutationRequest,
  PlaybackRequest,
  TrackListQuery,
  UpdateUserRoleRequest
} from '@lan/shared'

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'PROTOCOL_ERROR'

export class ApiError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    public readonly status = 0
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

export type PlayerIntent =
  | { command: 'play' | 'pause' | 'next' | 'previous' }
  | { command: 'seek', positionSeconds: number }
  | { command: 'volume', volume: number }
  | { command: 'mute', muted: boolean }

type Parser<T> = { parse: (value: unknown) => T }
type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH'
  body?: unknown
  csrfToken?: string
  signal: AbortSignal
}

export function createApiClient(fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {
  async function request<T>(path: string, schema: Parser<T>, options: RequestOptions): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (options.signal.aborted) abort()
    options.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 15000)

    try {
      const headers = new Headers({ Accept: 'application/json' })
      if (options.body !== undefined) headers.set('Content-Type', 'application/json')
      if (options.csrfToken) headers.set(CSRF_HEADER_NAME, options.csrfToken)
      const init: RequestInit = {
        method: options.method ?? 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal
      }
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
      const response = await fetcher(path, init)
      if (response.status === 204 && response.ok) {
        try {
          return schema.parse(undefined)
        } catch {
          throw new ApiError('PROTOCOL_ERROR', response.status)
        }
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        throw new ApiError(response.status === 401 ? 'UNAUTHENTICATED' : 'PROTOCOL_ERROR', response.status)
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new ApiError(response.status === 401 ? 'UNAUTHENTICATED' : 'PROTOCOL_ERROR', response.status)
      }
      if (!response.ok) {
        const parsed = ErrorResponseSchema.safeParse(data)
        if (!parsed.success) {
          throw new ApiError(response.status === 401 ? 'UNAUTHENTICATED' : 'PROTOCOL_ERROR', response.status)
        }
        throw new ApiError(response.status === 401 ? 'UNAUTHENTICATED' : parsed.data.error.code, response.status)
      }
      try {
        return schema.parse(data)
      } catch {
        throw new ApiError('PROTOCOL_ERROR', response.status)
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError('NETWORK_ERROR')
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
    }
  }

  async function mutate(path: string, body: MutationRequest, csrfToken: string, signal: AbortSignal, method: 'POST' | 'DELETE' = 'POST') {
    const response = await request(path, MutationResponseSchema, { method, body, csrfToken, signal })
    if (response.requestId !== body.requestId) throw new ApiError('PROTOCOL_ERROR')
    return response
  }

  async function mutateUser(path: string, body: CreateUserRequest | UpdateUserRoleRequest, csrfToken: string, signal: AbortSignal, method: 'POST' | 'PATCH') {
    const response = await request(path, UserMutationResponseSchema, { method, body, csrfToken, signal })
    if (response.requestId !== body.requestId) throw new ApiError('PROTOCOL_ERROR')
    return response
  }

  return {
    me: (signal: AbortSignal) => request(API_PATHS.me, SessionResponseSchema, { signal }),
    login: (input: LoginRequest, signal: AbortSignal) => request(API_PATHS.login, SessionResponseSchema, {
      method: 'POST',
      body: LoginRequestSchema.parse(input),
      signal
    }),
    logout: (csrfToken: string, signal: AbortSignal) => request(API_PATHS.logout, {
      parse: (value: unknown) => {
        if (value !== undefined) throw new ApiError('PROTOCOL_ERROR')
      }
    }, {
      method: 'POST',
      body: LogoutRequestSchema.parse({}),
      csrfToken,
      signal
    }),
    state: (signal: AbortSignal) => request(API_PATHS.state, SnapshotSchema, { signal }),
    tracks: (input: TrackListQuery, signal: AbortSignal) => {
      const query = TrackListQuerySchema.parse(input)
      const params = new URLSearchParams({
        q: query.q,
        offset: String(query.offset),
        limit: String(query.limit)
      })
      return request(`${API_PATHS.tracks}?${params}`, TrackListResponseSchema, { signal })
    },
    enqueue: (input: EnqueueRequest, csrfToken: string, signal: AbortSignal) => mutate(
      API_PATHS.queue, EnqueueRequestSchema.parse(input), csrfToken, signal
    ),
    remove: (entryId: string, input: MutationRequest, csrfToken: string, signal: AbortSignal) => mutate(
      queueEntryPath(IdSchema.parse(entryId)), RemoveQueueEntryRequestSchema.parse(input), csrfToken, signal, 'DELETE'
    ),
    command: (intent: PlayerIntent, input: PlaybackRequest, csrfToken: string, signal: AbortSignal) => {
      const { command, ...payload } = intent
      const body = PlayerCommandSchemas[command].parse({ ...input, ...payload })
      return mutate(playerCommandPath(command), body, csrfToken, signal)
    },
    users: (signal: AbortSignal) => request(API_PATHS.users, UserListResponseSchema, { signal }),
    createUser: (input: CreateUserRequest, csrfToken: string, signal: AbortSignal) => mutateUser(
      API_PATHS.users, CreateUserRequestSchema.parse(input), csrfToken, signal, 'POST'
    ),
    updateRole: (userId: string, input: UpdateUserRoleRequest, csrfToken: string, signal: AbortSignal) => mutateUser(
      userRolePath(IdSchema.parse(userId)), UpdateUserRoleRequestSchema.parse(input), csrfToken, signal, 'PATCH'
    )
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

export function createRequestId(): string {
  // No timestamp or Math.random IDs. The fallback also works on loopback HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
