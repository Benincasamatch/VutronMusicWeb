import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  API_PATHS,
  CSRF_HEADER_NAME,
  CreateUserRequestSchema,
  EnqueueRequestSchema,
  ErrorResponseSchema,
  IdSchema,
  LIMITS,
  LoginRequestSchema,
  LogoutRequestSchema,
  MutationResponseSchema,
  PlayerCommandSchemas,
  RemoveQueueEntryRequestSchema,
  SESSION_COOKIE_NAME,
  SessionResponseSchema,
  SnapshotSchema,
  TrackListQuerySchema,
  TrackListResponseSchema,
  UpdateUserRoleRequestSchema,
  UserListResponseSchema,
  UserMutationResponseSchema,
  WS_CSRF_PROTOCOL_PREFIX,
  WS_PROTOCOL,
  type PlayerCommandName,
  type TrackListQuery,
  type TrackListResponse
} from '@lan/shared'
import { Auth, RateLimiter, type Principal } from './auth.js'
import type { PlayableCatalog } from './catalog.js'
import type { Config } from './config.js'
import { Coordinator, type MutationContext } from './coordinator.js'
import { AppError, fail } from './errors.js'
import { EventHub } from './events.js'
import type { PlayerDriver } from './player/driver.js'
import type { Store } from './store.js'

const emptyQuery = z.object({}).strict()
const entryParams = z.object({ entryId: IdSchema }).strict()
const userParams = z.object({ userId: IdSchema }).strict()

function requestPath(request: FastifyRequest): string {
  const path = request.url.split('?')[0] ?? ''
  // Public route names, UUID parameters and emitted asset names need no encoded
  // path characters. Reject aliases before a router/static plugin can decode or
  // normalize them differently from the authentication hook. Queries remain encoded.
  if (!path.startsWith('/') || path.includes('%') || path.includes('\\') || path.includes('//') ||
    path.split('/').some((part) => part === '.' || part === '..')) fail('VALIDATION_ERROR')
  return path
}

export interface AppDependencies {
  config: Config
  store: Store
  catalog: PlayableCatalog & { list: (query: TrackListQuery) => TrackListResponse }
  driver: PlayerDriver
  now?: () => number
}

export function assertOrigin(config: Config, origin: string | undefined): void {
  if (origin !== config.publicOrigin) fail('ORIGIN_REJECTED')
}

export function assertHost(config: Config, host: string | undefined): void {
  if (host !== config.publicHost) fail('ORIGIN_REJECTED')
}

export function verifyWebSocketProtocols(header: string | string[] | undefined, principal: Principal, auth: Auth): void {
  const protocols = typeof header === 'string' ? header.split(',').map((part) => part.trim()) : []
  if (protocols.length !== 2 || !protocols.includes(WS_PROTOCOL)) return fail('CSRF_INVALID')
  const csrf = protocols.find((protocol) => protocol.startsWith(WS_CSRF_PROTOCOL_PREFIX))
  auth.checkCsrf(principal, csrf?.slice(WS_CSRF_PROTOCOL_PREFIX.length))
}

// Static serving resolves links below its root, so a link anywhere in the built assets can reach
// outside the public directory. Walking the tree is cheap because the built assets are small.
async function containsLink(root: string): Promise<boolean> {
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return true
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
    }
  }
  return false
}

export async function createApp(dependencies: AppDependencies) {
  const { config, store, catalog, driver } = dependencies
  const now = dependencies.now ?? Date.now
  const socketOrigin = config.publicOrigin.replace(/^http/, 'ws')
  const auth = new Auth(store, now)
  const coordinator = new Coordinator(store, catalog, driver, auth, now)
  const hub = new EventHub(coordinator, auth, now)
  const limiter = new RateLimiter(now)
  const principals = new WeakMap<FastifyRequest, Principal>()
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: LIMITS.httpBodyBytes,
    requestTimeout: 20000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    routerOptions: { maxParamLength: 128 }
  })

  const principal = (request: FastifyRequest): Principal => {
    const cached = principals.get(request)
    if (!cached) return fail('UNAUTHENTICATED')
    return auth.byDigest(cached.digest)
  }
  const context = (request: FastifyRequest): MutationContext => ({
    digest: principal(request).digest,
    csrf: typeof request.headers[CSRF_HEADER_NAME] === 'string' ? request.headers[CSRF_HEADER_NAME] : undefined
  })

  await app.register(cookie)
  await app.register(websocket, {
    options: {
      maxPayload: LIMITS.socketClientPayloadBytes,
      perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false
    }
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    // Spell out the same-origin WS scheme: not all browsers match ws(s) with CSP 'self'.
    reply.header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${socketOrigin}; media-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`)
    assertHost(config, request.headers.host)
    const path = requestPath(request)
    if (!path.startsWith('/api/') && path !== '/api') return
    reply.header('Cache-Control', 'no-store')
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    if (unsafe || path === API_PATHS.events) assertOrigin(config, request.headers.origin)
    let identity: Principal | undefined
    try {
      identity = auth.authenticate(request.cookies[SESSION_COOKIE_NAME])
      principals.set(request, identity)
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'UNAUTHENTICATED') throw error
    }
    limiter.take(`http:${identity?.digest ?? request.ip}`, LIMITS.httpRequestsPerMinute)
    if (path === API_PATHS.login && request.method === 'POST') {
      limiter.take(`login:${request.ip}`, LIMITS.loginAttemptsPerMinute)
      return
    }
    if (!identity) return fail('UNAUTHENTICATED')
    if (unsafe) {
      auth.checkCsrf(identity, context(request).csrf)
      limiter.take(`write:${identity.digest}`, LIMITS.mutationsPerMinute)
    }
  })

  app.addHook('preValidation', async (request) => {
    const path = requestPath(request)
    if (!path.startsWith('/api/') && path !== '/api') return
    if (path !== API_PATHS.tracks) emptyQuery.parse(request.query)
    // Fastify dispatches GET and HEAD as bodyless methods, so it never populates request.body and
    // the parsed body cannot prove absence. A declared length or a chunked encoding is what has to
    // be rejected, and it is also what would otherwise slip past the configured body limit.
    if (['GET', 'HEAD'].includes(request.method) &&
      (Number(request.headers['content-length']) > 0 || request.headers['transfer-encoding'] !== undefined)) {
      fail('VALIDATION_ERROR')
    }
  })

  app.setErrorHandler((error, request, reply) => {
    let safe: AppError
    if (error instanceof AppError) safe = error
    else if (error instanceof z.ZodError) {
      safe = new AppError('VALIDATION_ERROR')
    } else {
      // Static-file failures such as a denied dotfile, a failed precondition or an unsatisfiable
      // range are ordinary client errors. Reporting them as 500 misleads clients and operators.
      const status = Number((error as { statusCode?: number }).statusCode)
      if (status === 404) safe = new AppError('NOT_FOUND')
      else if (status === 403) safe = new AppError('FORBIDDEN')
      else if (status >= 400 && status < 500) safe = new AppError('VALIDATION_ERROR')
      else safe = new AppError('INTERNAL_ERROR')
    }
    if (safe.code === 'RATE_LIMITED') reply.header('Retry-After', '60')
    const input = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>).requestId : undefined
    const parsedId = IdSchema.safeParse(input)
    const envelope = ErrorResponseSchema.parse({
      error: { code: safe.code, message: safe.message, ...(parsedId.success ? { requestId: parsedId.data } : {}) }
    })
    return reply.code(safe.statusCode).header('Cache-Control', 'no-store').send(envelope)
  })

  const cookieOptions = {
    path: '/api',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.secureCookie
  }

  app.post(API_PATHS.login, async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body)
    const result = await coordinator.serial(() => auth.login(body.username, body.password, request.cookies[SESSION_COOKIE_NAME]))
    reply.setCookie(SESSION_COOKIE_NAME, result.token, {
      ...cookieOptions,
      maxAge: Math.floor(LIMITS.sessionTtlMs / 1000),
      expires: new Date(result.response.expiresAt)
    })
    return SessionResponseSchema.parse(result.response)
  })

  app.post(API_PATHS.logout, async (request, reply) => {
    LogoutRequestSchema.parse(request.body)
    const current = context(request)
    await coordinator.serial(() => {
      auth.checkCsrf(auth.byDigest(current.digest), current.csrf)
      auth.revoke([current.digest], 'logout')
    })
    reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions)
    return reply.code(204).send()
  })

  app.get(API_PATHS.me, async (request) => SessionResponseSchema.parse(auth.response(principal(request))))
  app.get(API_PATHS.state, async (request) => coordinator.serial(() => {
    principal(request)
    return SnapshotSchema.parse(coordinator.snapshot())
  }))
  app.get(API_PATHS.tracks, async (request) => {
    principal(request)
    return TrackListResponseSchema.parse(catalog.list(TrackListQuerySchema.parse(request.query)))
  })
  app.post(API_PATHS.queue, async (request) => MutationResponseSchema.parse(
    await coordinator.enqueue(context(request), EnqueueRequestSchema.parse(request.body))
  ))
  app.delete(`${API_PATHS.queue}/:entryId`, async (request) => {
    const { entryId } = entryParams.parse(request.params)
    return MutationResponseSchema.parse(await coordinator.remove(context(request), entryId, RemoveQueueEntryRequestSchema.parse(request.body)))
  })
  for (const command of Object.keys(PlayerCommandSchemas) as PlayerCommandName[]) {
    app.post(`${API_PATHS.player}/${command}`, async (request) => {
      const body = PlayerCommandSchemas[command].parse(request.body)
      return MutationResponseSchema.parse(await coordinator.control(context(request), command, body))
    })
  }
  app.get(API_PATHS.users, async (request) => UserListResponseSchema.parse({ users: coordinator.users(principal(request)) }))
  app.post(API_PATHS.users, async (request, reply) => {
    const response = await coordinator.createUser(context(request), CreateUserRequestSchema.parse(request.body))
    return reply.code(201).send(UserMutationResponseSchema.parse(response))
  })
  app.patch(`${API_PATHS.users}/:userId/role`, async (request) => {
    const { userId } = userParams.parse(request.params)
    return UserMutationResponseSchema.parse(await coordinator.changeRole(context(request), userId, UpdateUserRoleRequestSchema.parse(request.body)))
  })

  app.get(API_PATHS.events, {
    websocket: true,
    preValidation: async (request) => {
      assertOrigin(config, request.headers.origin)
      const current = principal(request)
      verifyWebSocketProtocols(request.headers['sec-websocket-protocol'], current, auth)
      if (hub.count(current.digest) >= LIMITS.socketsPerSession) fail('RATE_LIMITED')
    }
  }, (socket, request) => {
    // Attach synchronous listeners before awaiting the coordinator, so early client messages cannot escape enforcement.
    socket.on('message', () => socket.close(1008))
    socket.on('error', () => undefined)
    const current = principals.get(request)
    if (!current) {
      socket.close(4001)
      return
    }
    void coordinator.serial(() => {
      auth.byDigest(current.digest)
      hub.attach(socket, current.digest)
    }).catch((error: unknown) => {
      socket.close(error instanceof AppError && error.code === 'RATE_LIMITED' ? 1013 : 4001)
    })
  })

  // Reserve the API namespace before the static wildcard. Even an accidentally
  // packaged dist/api/* file must never become an API response or an audio route.
  const notFound = (_request: FastifyRequest, reply: FastifyReply) => reply.code(404).header('Cache-Control', 'no-store').send(
    ErrorResponseSchema.parse({ error: { code: 'NOT_FOUND', message: 'Requested endpoint not found' } })
  )
  app.all('/api', notFound)
  app.all('/api/*', notFound)
  app.setNotFoundHandler(notFound)

  if (config.environment === 'production') {
    const assets = await lstat(config.webDist).catch(() => null)
    const entry = await lstat(join(config.webDist, 'index.html')).catch(() => null)
    const usable = !!assets?.isDirectory() && !assets.isSymbolicLink() &&
      await realpath(config.webDist) === config.webDist &&
      !!entry?.isFile() && !entry.isSymbolicLink()
    // Static serving follows links below the root, so one linked component inside the built assets
    // would publish anything the service account can read. Refuse the whole tree instead of trusting
    // every future rebuild to be link-free. This shares the cleanup path below so a refusal cannot
    // leave the event hub or coordinator running.
    if (!usable || await containsLink(config.webDist)) {
      hub.close()
      await coordinator.close()
      await app.close()
      throw new Error('Production web assets are missing or contain a symlink. Build the independent LAN web application first')
    }
    await app.register(staticFiles, {
      root: config.webDist,
      prefix: '/',
      dotfiles: 'deny',
      index: ['index.html'],
      redirect: false,
      setHeaders: (reply) => { reply.header('Cache-Control', 'no-cache') }
    })
  }

  app.addHook('preClose', async () => { hub.close() })
  app.addHook('onClose', async () => { await coordinator.close() })
  try {
    await coordinator.initialize()
    await app.ready()
  } catch (error) {
    hub.close()
    await coordinator.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    throw error
  }
  return { app, coordinator, auth, hub }
}
