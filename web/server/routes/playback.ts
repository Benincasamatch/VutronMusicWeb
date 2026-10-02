/**
 * 播放路由：读取服务器播放状态、提交控制命令、查询当前用户控制权限。
 *
 * - 控制命令走 HTTP（便于鉴权与错误反馈），状态变更通过 WebSocket `playback:state` 推送。
 * - 控制权限：admin，或 users.can_control=1；被授权用户共同控制同一个服务器播放会话。
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth/guards.ts'
import { getEngine, initPlayback, PlaybackError } from '../playback/engine.ts'
import type { PlaybackAction } from '../../shared/contract.ts'

export { initPlayback }

const trackInputSchema = z.object({
  key: z.string().min(1).max(512).optional(),
  pluginId: z.string().min(1).max(256),
  instanceId: z.string().max(256).optional(),
  title: z.string().min(1).max(1024),
  artist: z.string().max(1024).optional(),
  album: z.string().max(1024).optional(),
  durationMs: z.number().min(0).optional(),
  picUrl: z.string().max(4096).optional(),
  sourceContext: z.unknown().optional(),
  mediaUrl: z.string().max(4096).optional(),
  mediaError: z.string().max(1024).optional()
})

const repeatModeSchema = z.enum(['list', 'one', 'shuffle'])

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('toggle') }),
  z.object({ action: z.literal('next') }),
  z.object({ action: z.literal('previous') }),
  z.object({ action: z.literal('seek'), positionMs: z.number().min(0) }),
  z.object({ action: z.literal('volume'), volume: z.number().min(0).max(1) }),
  z.object({ action: z.literal('mute'), muted: z.boolean() }),
  z.object({ action: z.literal('repeat'), mode: repeatModeSchema }),
  z.object({ action: z.literal('play-now'), track: trackInputSchema }),
  z.object({
    action: z.literal('queue-add'),
    tracks: z.array(trackInputSchema).min(1).max(1000),
    next: z.boolean().optional(),
    position: z.number().int().min(0).optional()
  }),
  z.object({
    action: z.literal('queue-set'),
    tracks: z.array(trackInputSchema).max(5000),
    index: z.number().int().min(0),
    autoplay: z.boolean().optional()
  }),
  z.object({ action: z.literal('queue-remove'), index: z.number().int().min(0) }),
  z.object({ action: z.literal('queue-clear') }),
  z.object({ action: z.literal('queue-move'), from: z.number().int().min(0), to: z.number().int().min(0) })
])

/** 允许 body 直接是 PlaybackAction，或包一层 { action: <PlaybackAction> } */
const nestedActionSchema = z.object({ action: actionSchema })

function parseAction(body: unknown): PlaybackAction | null {
  const direct = actionSchema.safeParse(body)
  if (direct.success) return direct.data as PlaybackAction
  const nested = nestedActionSchema.safeParse(body)
  if (nested.success) return nested.data.action as PlaybackAction
  return null
}

export async function registerPlaybackRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/playback/state', { preHandler: requireAuth }, async () => {
    return { state: getEngine().getState() }
  })

  app.get('/api/playback/permission', { preHandler: requireAuth }, async (req) => {
    const user = req.user!
    return { canControl: user.role === 'admin' || user.can_control === 1 }
  })

  app.post('/api/playback/command', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!
    if (user.role !== 'admin' && user.can_control !== 1) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '当前账号没有控制播放的权限' })
    }

    const action = parseAction(req.body)
    if (!action) {
      return reply.code(400).send({ error: 'INVALID', message: '无法识别的播放命令' })
    }

    try {
      const engine = getEngine()
      const state = await engine.handleAction(action, {
        id: user.id,
        name: user.display_name || user.username
      })
      return { state }
    } catch (err) {
      if (err instanceof PlaybackError) {
        return reply.code(err.status).send({ error: err.code, message: err.message })
      }
      req.log.error(err, 'playback command failed')
      return reply.code(500).send({ error: 'INTERNAL', message: '播放命令执行失败' })
    }
  })
}
