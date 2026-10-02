/**
 * 认证路由：登录、登出、当前用户、修改口令、修改昵称。
 * 口令使用 scrypt 校验；登录失败统一返回 401，不区分用户名是否存在。
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { config } from '../config.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  deleteSessionsForUser
} from '../db/sessions.ts'
import {
  findUserByUsername,
  toPublicUser,
  updateUserPassword,
  updateUserProfile
} from '../db/users.ts'
import { readSessionToken, requireAuth } from '../auth/guards.ts'
import { removeBootstrapCredentialFile } from '../bootstrap.ts'

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256)
})

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256)
})

const profileSchema = z.object({
  displayName: z.string().min(1).max(64)
})

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: Math.floor(config.sessionTtlMs / 1000)
  })
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '用户名或口令格式不正确' })
    }
    const user = findUserByUsername(parsed.data.username)
    const ok = user ? await verifyPassword(parsed.data.password, user.password_hash) : false
    if (!user || !ok) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '用户名或口令错误' })
    }
    if (user.disabled === 1) {
      return reply.code(403).send({ error: 'ACCOUNT_DISABLED', message: '账号已被禁用' })
    }
    const session = createSession(user.id, req.headers['user-agent'])
    setSessionCookie(reply, session.token)
    return { user: toPublicUser(user), token: session.token, expiresAt: session.expires_at }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readSessionToken(req)
    if (token) deleteSession(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    return { user: req.publicUser }
  })

  app.post('/api/auth/password', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = passwordSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '新口令至少 8 位' })
    }
    const user = req.user!
    const ok = await verifyPassword(parsed.data.currentPassword, user.password_hash)
    if (!ok) {
      return reply.code(400).send({ error: 'INVALID_CREDENTIALS', message: '当前口令错误' })
    }
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '新口令不能与当前口令相同' })
    }
    updateUserPassword(user.id, await hashPassword(parsed.data.newPassword), false)
    deleteSessionsForUser(user.id, readSessionToken(req) ?? undefined)
    removeBootstrapCredentialFile()
    return { ok: true }
  })

  app.patch('/api/auth/profile', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = profileSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '昵称格式不正确' })
    }
    updateUserProfile(req.user!.id, { displayName: parsed.data.displayName })
    return { ok: true }
  })
}
