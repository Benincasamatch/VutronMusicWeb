/**
 * 实时通道：WebSocket /ws 用于服务端 → 客户端的播放状态推送。
 * 控制命令一律走 HTTP（便于鉴权、幂等与错误反馈），此处只负责订阅与广播。
 * 连接鉴权复用会话 Cookie / Bearer 令牌；未认证连接会被直接关闭。
 */
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { resolveSessionUser } from './db/sessions.ts'
import { readSessionToken } from './auth/guards.ts'
import type { FastifyRequest } from 'fastify'

interface Client {
  id: number
  userId: string
  send: (payload: unknown) => void
  close: () => void
}

const clients = new Map<number, Client>()
let nextClientId = 1

export function registerRealtime(app: FastifyInstance): void {
  app.register(websocket)

  // 必须放进嵌套作用域：插件是异步 boot 的，同层同步注册路由会错过 onRoute 钩子，
  // 导致 { websocket: true } 失效、ws 升级被当作普通 GET 处理。
  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (connection, req: FastifyRequest) => {
      // @fastify/websocket v10：handler 第一参数即 socket
      const socket = connection as unknown as {
        send: (data: string) => void
        close: () => void
        on: (event: string, cb: (...args: unknown[]) => void) => void
      }
      const token = readSessionToken(req)
      const user = token ? resolveSessionUser(token) : null
      if (!user) {
        socket.send(JSON.stringify({ type: 'error', error: 'UNAUTHENTICATED' }))
        socket.close()
        return
      }

      const id = nextClientId++
      const client: Client = {
        id,
        userId: user.id,
        send: (payload) => {
          try {
            socket.send(JSON.stringify(payload))
          } catch {
            clients.delete(id)
          }
        },
        close: () => socket.close()
      }
      clients.set(id, client)

      socket.on('message', (raw: unknown) => {
        let msg: { type?: string } = {}
        try {
          msg = JSON.parse(String(raw)) as { type?: string }
        } catch {
          return
        }
        if (msg.type === 'ping') client.send({ type: 'pong', at: Date.now() })
      })
      socket.on('close', () => clients.delete(id))

      client.send({ type: 'hello', userId: user.id, clientId: id })
    })
  })
}

/** 向所有已认证连接广播；toUserId 为空表示广播给全部用户 */
export function broadcast(type: string, payload: unknown, toUserId?: string): void {
  for (const client of clients.values()) {
    if (toUserId && client.userId !== toUserId) continue
    client.send({ type, ...(payload as Record<string, unknown>) })
  }
}

export function connectionCount(): number {
  return clients.size
}
