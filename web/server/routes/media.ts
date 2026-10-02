/**
 * 媒体路由：GET/HEAD /api/media/:token。
 *
 * 令牌由 registerMediaSource 登记（本机文件路径或带凭据的上游 URL），16 字节随机、默认 12 小时过期，
 * 只发给已登录客户端，相当于一次性预签名地址：
 * - <audio> 元素与服务器音频输出进程都能直接抓取，不需要额外 Cookie/头；
 * - 上游凭据与服务器绝对路径永不出现在 URL 或响应里；
 * - URL 中不携带会话令牌（避免把用户会话写进日志/referrer）。
 * 令牌无效或已过期统一返回 404。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveMediaToken } from '../media/tokens.ts'
import { streamMedia } from '../media/stream.ts'

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const { token } = req.params as { token: string }
    const record = resolveMediaToken(token)
    if (!record) {
      await reply.code(404).send({ error: 'NOT_FOUND' })
      return
    }
    return streamMedia(req, reply, record)
  }

  app.route({ method: ['GET', 'HEAD'], url: '/api/media/:token', handler })
}
