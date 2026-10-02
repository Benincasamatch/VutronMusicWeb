/**
 * 密码哈希：使用 Node 内置 scrypt，避免引入原生依赖。
 * 存储格式：scrypt$N$r$p$<saltBase64>$<hashBase64>
 */
import crypto from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

function scrypt(password: string, salt: Buffer, keylen: number, cost = { N, r: R, p: P }): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  crypto.scrypt(
    password,
    salt,
    keylen,
    { ...cost, maxmem: 256 * 1024 * 1024 },
    (err, key) => (err ? reject(err) : resolve(key))
  )
  return promise
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const key = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  })
  return key.length === expected.length && crypto.timingSafeEqual(key, expected)
}

/** 生成可读性较好的随机密码（用于首次启动的初始管理员） */
export function generatePassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}
