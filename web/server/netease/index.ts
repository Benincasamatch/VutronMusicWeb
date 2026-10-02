/**
 * 网易云 API 代理（移植自桌面版 src/main/appServer/netease.ts）。
 *
 * 内置的 netease 插件通过 `apis.http` 请求 `${baseUrl}/<api>`，桌面版把该基址指向内嵌 Fastify 的
 * `http://localhost:41830/netease`。Web 版在启动时把插件的 baseUrl 改写为本服务的同源地址
 * （见 seedNeteaseBaseUrl），因此这里只需提供相同的路由形状。
 *
 * Cookie 处理与桌面版一致：优先请求 query 里的 cookie，其次请求头 Cookie。
 * 桌面版的 electron-store 配置项（解灰音源、代理、QQ/Joox Cookie）在 Web 版没有对应设置界面，
 * 解灰走默认来源列表，不读取代理配置。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createRequire } from 'node:module'
import { pathCase } from 'change-case'
import { getDb } from '../db/index.ts'

const require = createRequire(import.meta.url)

type NeteaseApi = (params: Record<string, unknown>) => Promise<{ body: unknown; status?: number }>

interface NeteaseError extends Error {
  status?: number
  body?: unknown
}

export function registerNeteaseRoutes(app: FastifyInstance): void {
  const NeteaseCloudMusicApi = require('@neteasecloudmusicapienhanced/api') as Record<string, NeteaseApi>

  const buildHandler = (name: string, api: NeteaseApi) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const params: Record<string, unknown> = {
          ...(req.query as Record<string, unknown>),
          ...((req.body as Record<string, unknown> | undefined) ?? {})
        }
        const headerCookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined
        if (!params.cookie) {
          if (headerCookie) params.cookie = headerCookie
          else {
            const cookies = (req.cookies as Record<string, string> | undefined) ?? {}
            const cookie = Object.entries(cookies)
              .map(([key, value]) => `${key}=${value}`)
              .join('; ')
            if (cookie) params.cookie = cookie
          }
        }
        const result = await api(params)
        return reply.send(result.body)
      } catch (error) {
        const err = error as NeteaseError
        req.log.error({ err, name }, 'Netease API 调用失败')
        const status = err?.status
        if (status && [400, 301, 250].includes(status)) {
          return reply.status(status).send(err.body ?? { code: status })
        }
        return reply.status(500).send({ code: 500, message: err?.message ?? '上游接口失败' })
      }
    }
  }

  for (const [nameInSnakeCase, api] of Object.entries(NeteaseCloudMusicApi)) {
    if (['serveNcmApi', 'getModulesDefinitions'].includes(nameInSnakeCase)) continue
    if (typeof api !== 'function') continue
    const name = pathCase(nameInSnakeCase)
    const handler = buildHandler(name, api)
    app.get(`/netease/${name}`, handler)
    app.post(`/netease/${name}`, handler)
  }

  // 解灰：桌面版读取 electron-store 的音源顺序/代理；Web 版使用默认来源列表
  app.get('/netease/unblock/song/url', async (req, reply) => {
    const { id } = req.query as { id?: string }
    if (!id) return reply.status(400).send({ code: 400, message: '缺少 id' })
    try {
      process.env.ENABLE_LOCAL_VIP = 'true'
      const matcher = require('@unblockneteasemusic/server') as (
        id: string,
        sources: string[]
      ) => Promise<unknown>
      const sources = ['bodian', 'kuwo', 'kugou', 'qq', 'bilibili', 'migu']
      const result = await matcher(id, sources).catch(() => null)
      return reply.send(result)
    } catch (error) {
      req.log.error({ err: error }, '解灰调用失败')
      return reply.send(null)
    }
  })

  app.get('/netease', async () => 'NeteaseCloudMusicApi')
}

/**
 * 把内置 netease 插件的 baseUrl 指向本服务。
 * 仅在插件未配置、或仍指向桌面版默认地址时改写，避免覆盖用户自定义的上游地址。
 */
export function seedNeteaseBaseUrl(origin: string): boolean {
  const instanceId = 'netease'
  const db = getDb()
  const row = db
    .prepare('SELECT value FROM plugin_state WHERE instance_id = ? AND key = ?')
    .get(instanceId, 'baseUrl') as { value: string } | undefined

  const current = row ? (JSON.parse(row.value) as string) : ''
  const isDesktopDefault = current === 'http://localhost:41830/netease' || current === ''
  if (!isDesktopDefault) return false

  const target = `${origin}/netease`
  db.prepare(
    `INSERT INTO plugin_state (instance_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value`
  ).run(instanceId, 'baseUrl', JSON.stringify(target))
  return true
}
