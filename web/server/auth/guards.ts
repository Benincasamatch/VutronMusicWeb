/**
 * 认证守卫：从 Cookie 或 Bearer 头解析会话，附加到 request.user。
 * 所有受保护路由都必须显式声明 requireAuth / requireAdmin，不做全局默认放行。
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { SESSION_COOKIE, resolveSessionUser } from '../db/sessions.ts'
import { toPublicUser, type PublicUser, type UserRow } from '../db/users.ts'

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow
    publicUser?: PublicUser
  }
}

export function readSessionToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]
  return cookie ?? null
}

/** 解析会话并挂载用户；失败时直接发送错误响应并返回 false */
async function attachUser(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const token = readSessionToken(req)
  const user = token ? resolveSessionUser(token) : null
  if (!user) {
    await reply.code(401).send({ error: 'UNAUTHENTICATED', message: '请先登录' })
    return false
  }
  req.user = user
  req.publicUser = toPublicUser(user)
  return true
}

export const requireAuth: preHandlerHookHandler = async (req, reply) => {
  await attachUser(req, reply)
}

export const requireAdmin: preHandlerHookHandler = async (req, reply) => {
  if (!(await attachUser(req, reply))) return
  if (req.user!.role !== 'admin') {
    await reply.code(403).send({ error: 'FORBIDDEN', message: '需要管理员权限' })
  }
}
