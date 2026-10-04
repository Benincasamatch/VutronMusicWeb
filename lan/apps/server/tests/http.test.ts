// HTTP checks use Fastify.inject only; no network listener or physical player is started.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionResponse, Snapshot } from '@lan/shared'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { addSession, FakeCatalog, FakeDriver, memoryStore } from './helpers.js'

const password = 'a test-only long password'
let passwordHash: string
let store: ReturnType<typeof memoryStore>
let service: Awaited<ReturnType<typeof createApp>>
let admin: ReturnType<typeof addSession>
let ordinary: ReturnType<typeof addSession>
let catalog: FakeCatalog
const origin = 'http://localhost:5174'
const baseHeaders = { host: 'localhost:5174', origin }
const authHeaders = (session: ReturnType<typeof addSession>) => ({
  ...baseHeaders,
  cookie: `lan_session=${session.token}`,
  'x-csrf-token': session.csrf
})

beforeAll(async () => { passwordHash = await hashPassword(password) })
beforeEach(async () => {
  store = memoryStore()
  admin = addSession(store, 'admin', 'administrator', passwordHash)
  ordinary = addSession(store, 'user', 'ordinary', passwordHash)
  catalog = new FakeCatalog()
  service = await createApp({
    config: loadConfig({ NODE_ENV: 'test', MUSIC_ROOT: './test-music' }),
    store,
    catalog,
    driver: new FakeDriver()
  })
})
afterEach(async () => {
  await service.app.close()
  store.close()
})

describe('exact HTTP contract and security boundary', () => {
  it('requires exact origin and host and never trusts forwarded hosts', async () => {
    for (const headers of [
      { host: 'localhost:5174' },
      { host: 'localhost:5174', origin: 'null' },
      { host: 'localhost:5174', origin: 'http://evil.invalid' },
      { host: 'evil.invalid', origin, 'x-forwarded-host': 'localhost:5174' }
    ]) {
      const response = await service.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'ordinary', password } })
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('ORIGIN_REJECTED')
    }
  })

  it('issues opaque scoped cookies, hashes stored sessions, and returns the same CSRF on reload', async () => {
    const response = await service.app.inject({ method: 'POST', url: '/api/auth/login', headers: baseHeaders, payload: { username: 'ordinary', password } })
    expect(response.statusCode).toBe(200)
    const body = response.json<SessionResponse>()
    const headerValue = response.headers['set-cookie']
    const header = Array.isArray(headerValue) ? headerValue[0]! : String(headerValue)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain('Path=/api')
    expect(header).not.toContain('Domain=')
    const cookie = header.split(';')[0]!
    const token = cookie.split('=')[1]!
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(store.session(token)).toBeUndefined()
    const reload = await service.app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...baseHeaders, cookie } })
    expect(reload.json()).toEqual(body)
    expect(reload.headers['cache-control']).toBe('no-store')
    expect(body.user).not.toHaveProperty('password_hash')
  })

  it('keeps incorrect and unknown credentials generic and throttles login attempts', async () => {
    for (const username of ['ordinary', 'unknown-user']) {
      const bad = await service.app.inject({ method: 'POST', url: '/api/auth/login', headers: baseHeaders, payload: { username, password: 'wrong' } })
      expect(bad.statusCode).toBe(401)
      expect(bad.json().error.code).toBe('UNAUTHENTICATED')
    }
    // Malformed bodies count toward the same attempt limit without additional scrypt work.
    for (let index = 0; index < 8; index += 1) {
      await service.app.inject({ method: 'POST', url: '/api/auth/login', headers: baseHeaders, payload: {} })
    }
    const limited = await service.app.inject({ method: 'POST', url: '/api/auth/login', headers: baseHeaders, payload: {} })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBe('60')
  })

  it('rejects missing CSRF and role escalation before accepting queue/player writes', async () => {
    const state = service.coordinator.snapshot()
    const body = { requestId: randomUUID(), serverInstanceId: state.serverInstanceId, expectedRevision: 0, trackId: catalog.track.id }
    const noCsrf = await service.app.inject({ method: 'POST', url: '/api/queue', headers: { ...baseHeaders, cookie: `lan_session=${ordinary.token}` }, payload: body })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json().error.code).toBe('CSRF_INVALID')
    const forged = await service.app.inject({ method: 'POST', url: '/api/queue', headers: authHeaders(ordinary), payload: { ...body, requester: admin.user } })
    expect(forged.statusCode).toBe(400)
    const player = await service.app.inject({ method: 'POST', url: '/api/player/play', headers: authHeaders(ordinary), payload: {
      requestId: randomUUID(), serverInstanceId: state.serverInstanceId, expectedRevision: 0, targetPlaybackId: null
    } })
    expect(player.statusCode).toBe(403)
    expect(service.coordinator.snapshot().queue.entries).toHaveLength(0)
  })

  it('parses literal search and strict decimal pagination, never accepts paths or audio endpoints', async () => {
    for (const url of ['/api/tracks?limit=1e2', '/api/tracks?limit=1.5', '/api/tracks?offset=-1', '/api/tracks?path=../../secret', '/api/tracks?limit=2&limit=3']) {
      const response = await service.app.inject({ method: 'GET', url, headers: authHeaders(ordinary) })
      expect(response.statusCode).toBe(400)
    }
    const literal = await service.app.inject({ method: 'GET', url: '/api/tracks?q=%25', headers: authHeaders(ordinary) })
    expect(literal.json().total).toBe(0)
    const tracks = await service.app.inject({ method: 'GET', url: '/api/tracks', headers: authHeaders(ordinary) })
    expect(tracks.json().tracks[0]).not.toHaveProperty('path')
    const missing = await service.app.inject({ method: 'GET', url: `/api/tracks/${catalog.track.id}/audio`, headers: authHeaders(ordinary) })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('NOT_FOUND')
  })

  it('normalizes invalid JSON, oversized bodies, unknown routes and untrusted request IDs', async () => {
    for (const payload of ['{', JSON.stringify({ password: 'x'.repeat(17000) })]) {
      const response = await service.app.inject({ method: 'POST', url: '/api/queue', headers: { ...authHeaders(ordinary), 'content-type': 'application/json' }, payload })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('VALIDATION_ERROR')
      expect(response.body).not.toContain('stack')
    }
    const response = await service.app.inject({ method: 'POST', url: '/api/queue', headers: authHeaders(ordinary), payload: { requestId: '<secret>' } })
    expect(response.json().error.requestId).toBeUndefined()
    const unknown = await service.app.inject({ method: 'GET', url: '/api/missing', headers: authHeaders(ordinary) })
    expect(unknown.headers['content-type']).toContain('application/json')
  })

  it('deduplicates queue requests at HTTP level without silently repairing revisions', async () => {
    const state = service.coordinator.snapshot()
    const payload = { requestId: randomUUID(), serverInstanceId: state.serverInstanceId, expectedRevision: 0, trackId: catalog.track.id }
    const first = await service.app.inject({ method: 'POST', url: '/api/queue', headers: authHeaders(ordinary), payload })
    const second = await service.app.inject({ method: 'POST', url: '/api/queue', headers: authHeaders(ordinary), payload })
    expect(second.json()).toEqual(first.json())
    const conflict = await service.app.inject({ method: 'POST', url: '/api/queue', headers: authHeaders(ordinary), payload: { ...payload, requestId: randomUUID() } })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('REVISION_CONFLICT')
    expect((first.json().snapshot as Snapshot).queue.entries).toHaveLength(1)
  })

  it('enforces last-admin protection, real role-change revocation and same-role no-op', async () => {
    const last = await service.app.inject({ method: 'PATCH', url: `/api/admin/users/${admin.user.id}/role`, headers: authHeaders(admin), payload: { requestId: randomUUID(), role: 'dj' } })
    expect(last.statusCode).toBe(409)
    expect(last.json().error.code).toBe('LAST_ADMIN')
    const unchanged = await service.app.inject({ method: 'PATCH', url: `/api/admin/users/${ordinary.user.id}/role`, headers: authHeaders(admin), payload: { requestId: randomUUID(), role: 'user' } })
    expect(unchanged.statusCode).toBe(200)
    expect(store.session(ordinary.digest)).toBeDefined()
    const changed = await service.app.inject({ method: 'PATCH', url: `/api/admin/users/${ordinary.user.id}/role`, headers: authHeaders(admin), payload: { requestId: randomUUID(), role: 'dj' } })
    expect(changed.statusCode).toBe(200)
    expect(store.session(ordinary.digest)).toBeUndefined()
    const me = await service.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(ordinary) })
    expect(me.statusCode).toBe(401)
  })

  it('protects user creation and never returns or caches plaintext password input', async () => {
    const payload = { requestId: randomUUID(), username: 'new-user', password, role: 'user' }
    const denied = await service.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(ordinary), payload })
    expect(denied.statusCode).toBe(403)
    const created = await service.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(admin), payload })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain(password)
    expect(store.accountByName('new-user')?.password_hash).toMatch(/^scrypt\$/)
    const repeat = await service.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(admin), payload })
    expect(repeat.statusCode).toBe(201)
    expect(repeat.json()).toEqual(created.json())
    const reused = await service.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(admin), payload: { ...payload, password: `${password}!` } })
    expect(reused.json().error.code).toBe('REQUEST_ID_REUSED')
  })

  it('revokes logout sessions and clears the scoped cookie', async () => {
    const response = await service.app.inject({ method: 'POST', url: '/api/auth/logout', headers: authHeaders(ordinary), payload: {} })
    expect(response.statusCode).toBe(204)
    expect(response.body).toBe('')
    expect(String(response.headers['set-cookie'])).toContain('Path=/api')
    expect(store.session(ordinary.digest)).toBeUndefined()
  })
})
