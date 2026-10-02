/**
 * 本地音乐库路由。所有读写均需登录；目录配置与扫描触发仅限管理员。
 * 播放链路：/api/library/tracks/:id/stream 通过媒体令牌登记真实文件路径，只回传 /api/media/<token>。
 */
import fs from 'node:fs'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { requireAdmin, requireAuth } from '../auth/guards.ts'
import { registerMediaSource } from '../media/tokens.ts'
import {
  assertPathSafe,
  cancelScan,
  getMusicRoots,
  getScanStatus,
  isScanRunning,
  scanLibrary,
  setMusicRoots
} from '../library/scanner.ts'
import {
  getAlbumDetail,
  getArtistDetail,
  getTrackById,
  getTrackCover,
  getTrackRow,
  listAlbums,
  listArtists,
  listTracks,
  readTrackLyric
} from '../library/query.ts'

const rootsSchema = z.object({
  roots: z.array(z.string().min(1).max(1024)).max(64),
  mode: z.enum(['replace', 'append']).optional()
})

const scanSchema = z.object({
  roots: z.array(z.string().min(1).max(1024)).max(64).optional(),
  mode: z.enum(['replace', 'append']).optional(),
  force: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(16).optional()
})

const notFound = (reply: FastifyReply, message: string) =>
  reply.code(404).send({ error: 'NOT_FOUND', message })

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/library/roots', { preHandler: requireAuth }, async () => {
    return { roots: getMusicRoots() }
  })

  app.put('/api/library/roots', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = rootsSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '请求体格式不正确，需要 { roots: string[], mode? }' })
    }
    try {
      const roots = setMusicRoots(parsed.data.roots, parsed.data.mode ?? 'replace')
      return { roots }
    } catch (err) {
      return reply.code(400).send({
        error: 'INVALID_ROOT',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

  app.post('/api/library/scan', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = scanSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '请求体格式不正确' })
    }
    if (isScanRunning()) {
      return reply.code(409).send({ error: 'SCAN_RUNNING', message: '已有扫描正在进行中', status: getScanStatus() })
    }
    let roots: string[] | undefined
    if (parsed.data.roots !== undefined) {
      try {
        roots = setMusicRoots(parsed.data.roots, parsed.data.mode ?? 'replace')
      } catch (err) {
        return reply.code(400).send({
          error: 'INVALID_ROOT',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
    // 后台执行，立即返回初始状态；进度经 GET /api/library/scan/status 轮询
    void scanLibrary({ roots, force: parsed.data.force, concurrency: parsed.data.concurrency }).catch(() => {
      /* 失败状态已记录在 getScanStatus() 中 */
    })
    return reply.code(202).send({ started: true, status: getScanStatus() })
  })

  app.get('/api/library/scan/status', { preHandler: requireAuth }, async () => {
    return getScanStatus()
  })

  app.post('/api/library/scan/cancel', { preHandler: requireAdmin }, async () => {
    const cancelled = cancelScan()
    return { cancelled, status: getScanStatus() }
  })

  app.get('/api/library/tracks', { preHandler: requireAuth }, async (req) => {
    const query = req.query as Record<string, string | undefined>
    return listTracks({
      q: query.q,
      page: Number(query.page ?? '1'),
      pageSize: Number(query.pageSize ?? query.page_size ?? '50'),
      sort: query.sort,
      order: query.order === 'desc' ? 'desc' : query.order === 'asc' ? 'asc' : undefined
    })
  })

  app.get('/api/library/tracks/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const track = getTrackById(id)
    if (!track) return notFound(reply, '曲目不存在')
    return track
  })

  app.get('/api/library/tracks/:id/cover', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const query = req.query as Record<string, string | undefined>
    const cover = await getTrackCover(id, query.size)
    if (!cover) return notFound(reply, '该曲目没有内嵌封面')
    return reply
      .header('cache-control', 'private, max-age=86400')
      .header('etag', `"${cover.etag}"`)
      .type(cover.mime)
      .send(cover.data)
  })

  app.get('/api/library/tracks/:id/lyric', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const lyric = readTrackLyric(id)
    if (!lyric) return notFound(reply, '未找到歌词文件')
    return { lyric: lyric.lyric, encoding: lyric.encoding, source: lyric.source }
  })

  app.get('/api/library/tracks/:id/stream', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = getTrackRow(id)
    if (!row) return notFound(reply, '曲目不存在')
    let filePath: string
    try {
      filePath = assertPathSafe(row.file_path)
    } catch {
      return reply.code(403).send({ error: 'FORBIDDEN_PATH', message: '文件不在已授权的音乐目录中' })
    }
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'FILE_MISSING', message: '服务器上的音频文件已不存在' })
    }
    const mediaUrl = registerMediaSource({ kind: 'local', filePath }, req.user?.id ?? null)
    return { mediaUrl }
  })

  app.get('/api/library/albums', { preHandler: requireAuth }, async () => {
    return { albums: listAlbums() }
  })

  app.get('/api/library/albums/:name', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = req.params as { name: string }
    const album = getAlbumDetail(name)
    if (!album) return notFound(reply, '专辑不存在')
    return album
  })

  app.get('/api/library/artists', { preHandler: requireAuth }, async () => {
    return { artists: listArtists() }
  })

  app.get('/api/library/artists/:name', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = req.params as { name: string }
    const artist = getArtistDetail(name)
    if (!artist) return notFound(reply, '艺人不存在')
    return artist
  })
}
