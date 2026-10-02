/**
 * Web 版服务端入口：创建 Fastify 实例、初始化数据库与初始管理员、注册路由与实时通道。
 * 与桌面版不同：不依赖 Electron，监听地址可配置，生产模式下直接托管构建后的前端。
 */
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { config, ensureDirs, lanAddresses } from './config.ts'
import { initDatabase } from './db/index.ts'
import { ensureBootstrapAdmin } from './bootstrap.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerAdminRoutes } from './routes/admin.ts'
import { registerMeRoutes } from './routes/me.ts'
import { registerMediaRoutes } from './routes/media.ts'
import { registerLibraryRoutes } from './routes/library.ts'
import { registerPlaybackRoutes, initPlayback } from './routes/playback.ts'
import { registerPluginRoutes } from './routes/plugins.ts'
import { registerNeteaseRoutes, seedNeteaseBaseUrl } from './netease/index.ts'
import { seedLocalPluginScanDir } from './plugins/localSeed.ts'
import { registerRealtime } from './realtime.ts'
import { purgeExpiredSessions } from './db/sessions.ts'

export const CLIENT_DIST = path.join(config.webRoot, 'dist', 'client')

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.VW_LOG_LEVEL || 'info',
      transport: undefined
    },
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true
  })

  app.register(cookie)

  app.get('/api/health', async () => ({
    ok: true,
    name: 'vutronmusic-web',
    version: 1,
    time: Date.now()
  }))

  await registerAuthRoutes(app)
  await registerAdminRoutes(app)
  await registerMeRoutes(app)
  await registerMediaRoutes(app)
  await registerLibraryRoutes(app)
  await registerPlaybackRoutes(app)
  registerNeteaseRoutes(app)

  // 插件实例会读到自己的 store，必须在上线（initPluginHost 拉起 Worker）之前写好：
  // 网易云插件的 baseUrl 在模块加载时就读取；本地插件的 scanDir 由服务器目录决定。
  const selfOrigin = config.publicOrigin || `http://127.0.0.1:${config.port}`
  const seeded = seedNeteaseBaseUrl(selfOrigin)
  const localRoots = seedLocalPluginScanDir()
  if (seeded) app.log.info(`已把网易云插件 baseUrl 指向 ${selfOrigin}/netease`)
  if (localRoots.length > 0) app.log.info(`本地音乐根目录: ${localRoots.join(', ')}`)

  await registerPluginRoutes(app)
  registerRealtime(app)
  await initPlayback()

  // 生产模式托管前端构建产物；开发模式由 Vite 提供页面并代理 /api、/ws
  if (fs.existsSync(CLIENT_DIST)) {
    // wildcard: true（默认）才会为 /assets/* 注册路由；否则资源请求会落到下面的 SPA 回退，
    // 浏览器把 index.html 当模块执行 → 白屏。
    app.register(fastifyStatic, { root: CLIENT_DIST })
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && (req.raw.url.startsWith('/api/') || req.raw.url.startsWith('/ws'))) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '接口不存在' })
      }
      // 入口页必须每次回源：它引用的资源名带哈希，缓存入口会导致客户端一直用旧构建
      reply.header('cache-control', 'no-store')
      return reply.sendFile('index.html')
    })
  }

  return app
}

export async function start(): Promise<FastifyInstance> {
  ensureDirs()
  initDatabase()
  const bootstrap = await ensureBootstrapAdmin()
  const app = await buildApp()

  await app.listen({ host: config.host, port: config.port })

  const urls = lanAddresses().map((ip) => `http://${ip}:${config.port}`)
  app.log.info(`数据目录: ${config.dataDir}`)
  app.log.info(`本机访问: http://127.0.0.1:${config.port}`)
  for (const url of urls) app.log.info(`局域网访问: ${url}`)

  if (bootstrap.created) {
    if (bootstrap.generatedPassword) {
      app.log.warn(
        `已创建初始管理员「${bootstrap.username}」，随机口令见 ${path.join(
          config.dataDir,
          'INITIAL_ADMIN.txt'
        )}，首次登录后必须修改。`
      )
    } else {
      app.log.warn(`已创建初始管理员「${bootstrap.username}」，口令来自 VW_ADMIN_PASSWORD。`)
    }
  }

  // 定期清理过期会话
  const timer = setInterval(() => {
    try {
      purgeExpiredSessions()
    } catch (err) {
      app.log.error(err)
    }
  }, 6 * 60 * 60 * 1000)
  timer.unref?.()

  return app
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('index.ts')
if (isDirectRun) {
  start().catch((err) => {
    console.error('[vutronmusic-web] 启动失败:', err)
    process.exit(1)
  })
}
