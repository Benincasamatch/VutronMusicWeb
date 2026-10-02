/**
 * 管理员路由：账号创建、角色调整、禁用、重置口令、删除。
 * 约束：不能删除自己；必须始终保留至少一个启用状态的管理员。
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashPassword } from '../auth/password.ts'
import { requireAdmin } from '../auth/guards.ts'
import { deleteSessionsForUser } from '../db/sessions.ts'
import {
  countAdmins,
  deleteUser,
  findUserById,
  findUserByUsername,
  insertUser,
  listUsers,
  toPublicUser,
  updateUserPassword,
  updateUserProfile
} from '../db/users.ts'

const createUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, '只允许字母、数字、下划线、点、连字符'),
  password: z.string().min(8).max(256),
  role: z.enum(['admin', 'user']).default('user'),
  displayName: z.string().min(1).max(64).optional(),
  canControl: z.boolean().optional()
})

const patchUserSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  displayName: z.string().min(1).max(64).optional(),
  disabled: z.boolean().optional(),
  canControl: z.boolean().optional()
})

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(256),
  mustChangePassword: z.boolean().default(true)
})

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    return { users: listUsers().map(toPublicUser) }
  })

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: parsed.error.issues[0]?.message ?? '参数不合法'
      })
    }
    if (findUserByUsername(parsed.data.username)) {
      return reply.code(409).send({ error: 'USERNAME_TAKEN', message: '用户名已存在' })
    }
    const user = insertUser({
      username: parsed.data.username,
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role,
      displayName: parsed.data.displayName ?? parsed.data.username,
      mustChangePassword: true,
      canControl: parsed.data.canControl ?? parsed.data.role === 'admin'
    })
    return reply.code(201).send({ user: toPublicUser(user) })
  })

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = patchUserSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '参数不合法' })
    }
    const target = findUserById(id)
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' })

    const demotingAdmin =
      (parsed.data.role && parsed.data.role !== 'admin') ||
      parsed.data.disabled === true
    if (target.role === 'admin' && demotingAdmin && countAdmins() <= 1) {
      return reply.code(409).send({ error: 'LAST_ADMIN', message: '必须保留至少一个启用的管理员' })
    }
    if (req.user!.id === id && parsed.data.disabled === true) {
      return reply.code(400).send({ error: 'CANNOT_DISABLE_SELF', message: '不能禁用自己' })
    }

    updateUserProfile(id, parsed.data)
    if (parsed.data.disabled === true) deleteSessionsForUser(id)
    return { user: toPublicUser(findUserById(id)!) }
  })

  app.post('/api/admin/users/:id/password', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = resetPasswordSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '口令至少 8 位' })
    }
    if (!findUserById(id)) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' })
    updateUserPassword(id, await hashPassword(parsed.data.password), parsed.data.mustChangePassword)
    deleteSessionsForUser(id)
    return { ok: true }
  })

  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (req.user!.id === id) {
      return reply.code(400).send({ error: 'CANNOT_DELETE_SELF', message: '不能删除自己' })
    }
    const target = findUserById(id)
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' })
    if (target.role === 'admin' && countAdmins() <= 1) {
      return reply.code(409).send({ error: 'LAST_ADMIN', message: '必须保留至少一个启用的管理员' })
    }
    deleteUser(id)
    return { ok: true }
  })
}
