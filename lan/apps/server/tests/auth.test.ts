// Uses only in-memory SQLite and asynchronous node:crypto hashing.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '@lan/shared'
import { Auth, digestToken, hashPassword, RateLimiter, safeTokenEqual, verifyPassword } from '../src/auth.js'
import { verifyWebSocketProtocols } from '../src/app.js'
import { assertUnprivileged, loadConfig } from '../src/config.js'
import { addSession, memoryStore } from './helpers.js'

describe('passwords and opaque sessions', () => {
  it('uses independent salts, a fixed bounded scrypt format and exact untrimmed passwords', async () => {
    const password = '  long test password  '
    const first = await hashPassword(password)
    const second = await hashPassword(password)
    expect(first).not.toBe(second)
    expect(first).not.toContain(password)
    expect(await verifyPassword(password, first)).toBe(true)
    expect(await verifyPassword(password.trim(), first)).toBe(false)
    expect(await verifyPassword(password, 'scrypt$999999999999$8$1$invalid$invalid')).toBe(false)
  })

  it('expires absolutely, revokes replaced tokens and does not exceed ten sessions', async () => {
    const store = memoryStore()
    let now = Date.now()
    const auth = new Auth(store, () => now)
    const password = 'this password is test-only'
    store.createAccount('account', await hashPassword(password), 'admin')
    const revoked: string[] = []
    auth.onRevoked = (digests) => revoked.push(...digests)
    try {
      const first = await auth.login('account', password, undefined)
      const replaced = await auth.login('account', password, first.token)
      expect(replaced.token).not.toBe(first.token)
      expect(() => auth.authenticate(first.token)).toThrow()
      expect(revoked).toContain(digestToken(first.token))
      const principal = auth.authenticate(replaced.token)
      expect(principal.expiresAt).toBe(now + LIMITS.sessionTtlMs)
      // Seed nine additional sessions without spending test time on nine redundant scrypt jobs.
      for (let index = 0; index < 9; index += 1) {
        store.createSession({
          digest: digestToken(randomBytes(32).toString('base64url')),
          user_id: principal.user.id,
          csrf: randomBytes(32).toString('base64url'),
          created_at: now,
          expires_at: now + LIMITS.sessionTtlMs
        }, null, now)
      }
      await expect(auth.login('account', password, undefined)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
      now += LIMITS.sessionTtlMs
      expect(() => auth.authenticate(replaced.token)).toThrow()
      expect(store.session(principal.digest)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('verifies the exact WS subprotocol pair without echoing the CSRF-bearing protocol', () => {
    const store = memoryStore()
    const session = addSession(store, 'admin')
    const auth = new Auth(store)
    const principal = auth.authenticate(session.token)
    try {
      expect(() => verifyWebSocketProtocols(`lan.v1, csrf.${session.csrf}`, principal, auth)).not.toThrow()
      for (const offered of [undefined, 'lan.v1', 'lan.v1, csrf.wrong', `lan.v1, csrf.${session.csrf}, extra`, `lan.v2, csrf.${session.csrf}`]) {
        expect(() => verifyWebSocketProtocols(offered, principal, auth)).toThrow()
      }
      expect(safeTokenEqual(session.csrf, session.csrf)).toBe(true)
      expect(safeTokenEqual('short', session.csrf)).toBe(false)
    } finally {
      store.close()
    }
  })

  it('allows bootstrap only into an empty database and cannot remove the last admin', () => {
    const store = memoryStore()
    try {
      const first = store.createAccount('first-admin', 'test-only-hash', 'admin', true)
      expect(() => store.createAccount('second-admin', 'test-only-hash', 'admin', true)).toThrow()
      expect(() => store.changeRole(first.id, 'dj')).toThrow()
      const second = store.createAccount('second-admin', 'test-only-hash', 'admin')
      expect(store.changeRole(first.id, 'dj').user.role).toBe('dj')
      expect(() => store.changeRole(second.id, 'user')).toThrow()
    } finally {
      store.close()
    }
  })
})

describe('configuration and resource boundaries', () => {
  it('fails closed for public listeners, non-HTTPS production and implicit simulation', () => {
    const base = { MUSIC_ROOT: './music' }
    for (const env of [
      { ...base, HOST: '0.0.0.0' },
      { ...base, HOST: '::' },
      { ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://music.example' },
      { ...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://music.example', DEV_SIMULATION: 'true' },
      { ...base, PUBLIC_ORIGIN: 'http://localhost:5174/' },
      { ...base, PUBLIC_ORIGIN: 'http://name:password@localhost:5174' },
      { ...base, MUSIC_ROOT: './data' }
    ]) expect(() => loadConfig(env)).toThrow()
    expect(loadConfig({ ...base, NODE_ENV: 'development', DEV_SIMULATION: 'true' }).simulation).toBe(true)
    expect(loadConfig(base).simulation).toBe(false)
    expect(() => assertUnprivileged(0)).toThrow()
    expect(() => assertUnprivileged(1000)).not.toThrow()
  })

  it('enforces rate limits and expires bounded windows', () => {
    let now = 1000
    const limiter = new RateLimiter(() => now)
    limiter.take('session', 2)
    limiter.take('session', 2)
    expect(() => limiter.take('session', 2)).toThrow()
    now += 60000
    expect(() => limiter.take('session', 2)).not.toThrow()
  })
})
