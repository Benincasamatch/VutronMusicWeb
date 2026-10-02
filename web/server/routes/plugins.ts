/**
 * 插件路由：实例列表/管理、通用方法调用、歌词、播放地址、音源优先级。
 *
 * 安全约定：
 * - 插件凭据存放在 plugin_state（按实例隔离），本文件绝不下发凭据；getAccount 的 pwd 也会被抹掉。
 * - call / lyric / song-url / enable / delete 仅允许实例 owner 或 admin；全局内置实例（owner=null）只允许 admin。
 * - song-url 由服务器解析真实音源并登记 media token，前端只拿到 /api/media/<token>。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getDb, jsonParse } from '../db/index.ts'
import { requireAuth } from '../auth/guards.ts'
import {
  fetchInstanceSongUrl,
  getPluginHost,
  initPluginHost,
  validatePluginResult,
  type PluginInstance
} from '../plugins/host.ts'
import type { MusicType, PluginInstanceInfo } from '../plugins/types.ts'

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const paramsSchema = z.record(z.string(), z.unknown())
const callSchema = z.object({
  method: z.string().min(1).max(64).optional(),
  methodName: z.string().min(1).max(64).optional(),
  params: paramsSchema.nullish()
})

const lyricSchema = z.object({
  sourceContext: z.unknown().optional(),
  params: paramsSchema.nullish()
})

const songUrlSchema = z.object({
  sourceContext: z.unknown().optional(),
  params: paramsSchema.nullish(),
  cueOffset: z.number().optional(),
  cueDuration: z.number().optional()
})

const enableSchema = z.object({ enabled: z.boolean() })

const createInstanceSchema = z.object({
  pluginId: z.string().regex(PLUGIN_ID_PATTERN).optional(),
  basePluginId: z.string().regex(PLUGIN_ID_PATTERN).optional(),
  name: z.string().min(1).max(64).optional()
})

const prioritySchema = z.object({
  lyric: z.array(z.string()).optional(),
  comment: z.array(z.string()).optional(),
  trackInfoOrder: z.array(z.string()).optional()
})

const enableTypesSchema = z.object({
  enableLibrary: z.boolean().optional(),
  enableStream: z.boolean().optional(),
  enableLocal: z.boolean().optional()
})

const querySchema = z.object({ instanceId: z.string().min(1).max(64).optional() })

interface EnabledTypes {
  library: boolean
  stream: boolean
  local: boolean
}

/** 我们自己写入 user_settings 的 JSON 对象；非对象一律视为空 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function readUserSetting(userId: string, key: string): unknown {
  const row = getDb()
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined
  return row ? jsonParse<unknown>(row.value, null) : null
}

function writeUserSetting(userId: string, key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
    )
    .run(userId, key, JSON.stringify(value ?? null))
}

function readEnabledTypes(userId: string): EnabledTypes {
  const record = asRecord(readUserSetting(userId, 'plugin.enabledTypes'))
  return {
    library: record.library !== false,
    stream: record.stream !== false,
    local: record.local !== false
  }
}

/** 参数透传：对象原样展开，其它类型一律按空对象处理（不解析字段语义） */
function normalizeParams(value: unknown): Record<string, unknown> {
  const parsed = paramsSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

/** 兼容桌面版前端：sourceContext 可能被包成 { rawCtx: {...} }，解包后原样透传 */
function paramsFromRequest(
  params: Record<string, unknown> | null | undefined,
  sourceContext: unknown
): Record<string, unknown> {
  const direct = normalizeParams(params)
  if (Object.keys(direct).length > 0) return direct
  if (sourceContext && typeof sourceContext === 'object') {
    if ('rawCtx' in sourceContext) return normalizeParams(sourceContext.rawCtx)
    return normalizeParams(sourceContext)
  }
  return {}
}

function findInstance(reply: FastifyReply, instanceId: string): PluginInstance | null {
  const instance = getPluginHost().getInstance(instanceId)
  if (!instance) {
    void reply
      .code(404)
      .send({ error: 'PLUGIN_NOT_FOUND', message: `插件实例不存在: ${instanceId}` })
    return null
  }
  return instance
}

/** 仅实例 owner 或 admin 可操作；全局内置实例（owner 为 NULL）只有 admin 可操作 */
function authorizeInstance(
  req: FastifyRequest,
  reply: FastifyReply,
  instance: PluginInstance
): boolean {
  const user = req.user!
  if (user.role === 'admin') return true
  if (instance.ownerUserId && instance.ownerUserId === user.id) return true
  void reply.code(403).send({ error: 'FORBIDDEN', message: '只有实例所有者或管理员可以操作' })
  return false
}

function toServiceMeta(info: PluginInstanceInfo): {
  name: string
  icon: string
  type: MusicType | null
  capabilities: PluginInstanceInfo['capabilities']
  builtIn: boolean
} {
  return {
    name: info.name,
    icon: info.icon,
    type: info.type,
    capabilities: info.capabilities,
    builtIn: info.builtIn
  }
}

export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  await initPluginHost()

  app.get('/api/plugins', { preHandler: requireAuth }, async (req) => {
    const host = getPluginHost()
    const user = req.user!
    return {
      plugins: host.listInstancesFor({ id: user.id, role: user.role }),
      sources: host.listSources(),
      enabledTypes: readEnabledTypes(user.id)
    }
  })

  app.patch('/api/plugins', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = enableTypesSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '参数不合法' })
    }
    const user = req.user!
    const current = readEnabledTypes(user.id)
    const next: EnabledTypes = {
      library: parsed.data.enableLibrary ?? current.library,
      stream: parsed.data.enableStream ?? current.stream,
      local: parsed.data.enableLocal ?? current.local
    }
    writeUserSetting(user.id, 'plugin.enabledTypes', next)
    return { success: true, enabledTypes: next }
  })

  app.get('/api/plugins/source-priority', { preHandler: requireAuth }, async (req) => {
    return asRecord(readUserSetting(req.user!.id, 'plugin.sourcePriority'))
  })

  app.put('/api/plugins/source-priority', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = prioritySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '参数不合法' })
    }
    const user = req.user!
    const next = { ...asRecord(readUserSetting(user.id, 'plugin.sourcePriority')), ...parsed.data }
    writeUserSetting(user.id, 'plugin.sourcePriority', next)
    return next
  })

  app.post('/api/plugins/instances', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createInstanceSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '参数不合法' })
    }
    const pluginId = parsed.data.pluginId ?? parsed.data.basePluginId
    if (!pluginId) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '缺少 pluginId' })
    }
    try {
      const row = await getPluginHost().createInstance(req.user!.id, pluginId, parsed.data.name)
      const instance = getPluginHost().getInstance(row.id)
      if (!instance) {
        return reply.code(500).send({ error: 'INTERNAL', message: '实例创建后未找到' })
      }
      return { success: true, id: row.id, plugin: toServiceMeta(instance.info) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: 'PLUGIN_NOT_FOUND', message })
    }
  })

  async function removeInstance(
    req: FastifyRequest,
    reply: FastifyReply,
    instanceId: string | undefined
  ): Promise<unknown> {
    if (!instanceId) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '缺少 instanceId' })
    }
    const instance = findInstance(reply, instanceId)
    if (!instance) return reply
    if (!authorizeInstance(req, reply, instance)) return reply
    if (instance.builtIn) {
      return reply
        .code(403)
        .send({ error: 'FORBIDDEN', message: '内置全局实例不可删除，可停用后使用' })
    }
    return { success: getPluginHost().deleteInstance(instanceId) }
  }

  app.delete('/api/plugins/instances', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {})
    return removeInstance(req, reply, parsed.success ? parsed.data.instanceId : undefined)
  })

  app.delete<{ Params: { id: string } }>(
    '/api/plugins/instances/:id',
    { preHandler: requireAuth },
    async (req, reply) => removeInstance(req, reply, req.params.id)
  )

  app.patch<{ Params: { instanceId: string } }>(
    '/api/plugins/:instanceId/enable',
    { preHandler: requireAuth },
    async (req, reply) => {
      const instance = findInstance(reply, req.params.instanceId)
      if (!instance) return reply
      if (!authorizeInstance(req, reply, instance)) return reply
      const parsed = enableSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: '参数不合法' })
      }
      const updated = await getPluginHost().setEnabled(req.params.instanceId, parsed.data.enabled)
      return { success: true, plugin: updated.info }
    }
  )

  app.post<{ Params: { instanceId: string } }>(
    '/api/plugins/:instanceId/call',
    { preHandler: requireAuth },
    async (req, reply) => {
      const instance = findInstance(reply, req.params.instanceId)
      if (!instance) return reply
      if (!authorizeInstance(req, reply, instance)) return reply
      if (!instance.enabled) {
        return reply.code(409).send({ error: 'PLUGIN_DISABLED', message: '该插件实例已停用' })
      }
      const parsed = callSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: '参数不合法' })
      }
      const method = parsed.data.method ?? parsed.data.methodName
      if (!method) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: '缺少 method' })
      }
      try {
        const raw = await instance.call(method, normalizeParams(parsed.data.params))
        let value = validatePluginResult(method, raw, instance.id)
        if (value && typeof value === 'object' && 'status' in value) {
          const status = value.status
          if (
            method === 'systemPing' &&
            (status === 'login' || status === 'logout' || status === 'offline')
          ) {
            instance.loginStatus = status
          }
        }
        // 凭据绝不下发：getAccount 返回的密码一律抹掉
        if (method === 'getAccount' && value && typeof value === 'object' && 'pwd' in value) {
          value = { ...value, pwd: '' }
        }
        return value
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: 'PLUGIN_ERROR', message })
      }
    }
  )

  app.post<{ Params: { instanceId: string } }>(
    '/api/plugins/:instanceId/lyric',
    { preHandler: requireAuth },
    async (req, reply) => {
      const instance = findInstance(reply, req.params.instanceId)
      if (!instance) return reply
      if (!authorizeInstance(req, reply, instance)) return reply
      if (!instance.enabled) {
        return reply.code(409).send({ error: 'PLUGIN_DISABLED', message: '该插件实例已停用' })
      }
      const parsed = lyricSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: '参数不合法' })
      }
      try {
        return await instance.callValidated(
          'getLyric',
          paramsFromRequest(parsed.data.params, parsed.data.sourceContext)
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: 'PLUGIN_ERROR', message })
      }
    }
  )

  app.post<{ Params: { instanceId: string } }>(
    '/api/plugins/:instanceId/song-url',
    { preHandler: requireAuth },
    async (req, reply) => {
      const instance = findInstance(reply, req.params.instanceId)
      if (!instance) return reply
      if (!authorizeInstance(req, reply, instance)) return reply
      const parsed = songUrlSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_REQUEST', message: '参数不合法' })
      }
      const params = paramsFromRequest(parsed.data.params, parsed.data.sourceContext)
      if (parsed.data.cueOffset !== undefined) params.cueOffset = parsed.data.cueOffset
      if (parsed.data.cueDuration !== undefined) params.cueDuration = parsed.data.cueDuration

      try {
        const outcome = await fetchInstanceSongUrl(instance, params, req.user!.id)
        // 只暴露宿主签发的 mediaUrl；url 数组也回填该地址，便于沿用桌面版前端取值
        return {
          code: outcome.code,
          mediaUrl: outcome.mediaUrl,
          url: outcome.mediaUrl ? [outcome.mediaUrl] : [],
          replayGain: outcome.replayGain ?? 0,
          peak: outcome.peak ?? 1,
          cueOffset: outcome.cueOffset ?? 0,
          cueDuration: outcome.cueDuration ?? 0,
          ...(outcome.error ? { error: outcome.error } : {})
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: 'PLUGIN_ERROR', message })
      }
    }
  )
}
