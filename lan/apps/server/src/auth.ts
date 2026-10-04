import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import {
  LIMITS,
  type PublicUser,
  type SessionResponse,
  type SessionRevokedReason
} from '@lan/shared'
import { fail } from './errors.js'
import type { SessionRow, Store } from './store.js'

const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_BYTES = 64
let activeHashes = 0

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound native worker/memory use. Never queue an unbounded number of password jobs.
  if (activeHashes >= 4) return fail('RATE_LIMITED')
  activeHashes += 1
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error)
        else resolve(key)
      })
    })
  } finally {
    activeHashes -= 1
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  const valid = parts.length === 6 && parts[0] === 'scrypt' && parts[1] === String(SCRYPT_N) &&
    parts[2] === String(SCRYPT_R) && parts[3] === String(SCRYPT_P) &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[4] ?? '') && /^[A-Za-z0-9_-]{86}$/.test(parts[5] ?? '')
  const salt = valid ? Buffer.from(parts[4]!, 'base64url') : Buffer.alloc(16)
  const expected = valid ? Buffer.from(parts[5]!, 'base64url') : Buffer.alloc(KEY_BYTES)
  const actual = await derive(password, salt)
  return timingSafeEqual(actual, expected) && valid
}

export function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function safeTokenEqual(left: string, right: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(left) || !/^[A-Za-z0-9_-]{43}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

export interface Principal {
  digest: string
  user: PublicUser
  csrf: string
  expiresAt: number
}

export class Auth {
  onRevoked: (digests: string[], reason: SessionRevokedReason) => void = () => undefined

  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  authenticate(token: string | undefined): Principal {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return fail('UNAUTHENTICATED')
    return this.byDigest(digestToken(token))
  }

  byDigest(digest: string): Principal {
    const row = this.store.session(digest)
    if (!row) return fail('UNAUTHENTICATED')
    if (row.expires_at <= this.now()) {
      this.revoke([digest], 'expired')
      return fail('UNAUTHENTICATED')
    }
    const account = this.store.account(row.user_id)
    if (!account) return fail('UNAUTHENTICATED')
    return {
      digest,
      user: { id: account.id, username: account.username, role: account.role },
      csrf: row.csrf,
      expiresAt: row.expires_at
    }
  }

  checkCsrf(principal: Principal, token: string | undefined): void {
    if (!token || !safeTokenEqual(principal.csrf, token)) fail('CSRF_INVALID')
  }

  response(principal: Principal): SessionResponse {
    return { user: principal.user, csrfToken: principal.csrf, expiresAt: new Date(principal.expiresAt).toISOString() }
  }

  async login(username: string, password: string, previousToken: string | undefined): Promise<{ token: string, response: SessionResponse }> {
    const account = this.store.accountByName(username)
    // An absent account still performs the same bounded scrypt work.
    const correct = await verifyPassword(password, account?.password_hash ?? '')
    if (!account || !correct) return fail('UNAUTHENTICATED')
    const live = this.store.account(account.id)
    if (!live || live.password_hash !== account.password_hash) return fail('UNAUTHENTICATED')
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    this.expire()
    const row: SessionRow = {
      digest: digestToken(token),
      user_id: live.id,
      csrf: randomBytes(32).toString('base64url'),
      expires_at: now + LIMITS.sessionTtlMs,
      created_at: now
    }
    const replaced = previousToken && /^[A-Za-z0-9_-]{43}$/.test(previousToken) ? digestToken(previousToken) : null
    this.store.createSession(row, replaced, now)
    if (replaced) this.onRevoked([replaced], 'logout')
    return { token, response: this.response(this.byDigest(row.digest)) }
  }

  revoke(digests: string[], reason: SessionRevokedReason): void {
    for (const digest of digests) this.store.deleteSession(digest)
    if (digests.length) this.onRevoked(digests, reason)
  }

  expire(): void {
    const digests = this.store.expireSessions(this.now())
    if (digests.length) this.onRevoked(digests, 'expired')
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number, until: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, limit: number): void {
    const now = this.now()
    for (const [id, bucket] of this.buckets) {
      if (bucket.until <= now) this.buckets.delete(id)
    }
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= 10000) fail('RATE_LIMITED')
      bucket = { count: 0, until: now + 60000 }
      this.buckets.set(key, bucket)
    }
    if (bucket.count >= limit) fail('RATE_LIMITED')
    bucket.count += 1
  }
}
