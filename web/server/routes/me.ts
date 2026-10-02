/**
 * 个人数据路由：收藏、歌单、设置。全部要求登录，且按 user_id 严格隔离。
 * 访问他人资源统一返回 404，避免泄露资源是否存在。
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth/guards.ts'
import {
  addPlaylistTracks,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getSettings,
  listFavorites,
  listPlaylists,
  putSettings,
  removeFavorite,
  removePlaylistTracks,
  reorderPlaylist,
  updatePlaylist,
  upsertFavorite
} from '../db/userdata.ts'

const favoriteSchema = z.object({
  trackKey: z.string().min(1).max(512),
  payload: z.unknown().optional()
})

const playlistCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).optional()
})

const playlistPatchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(1024).optional()
})

const tracksSchema = z.object({
  tracks: z
    .array(z.object({ trackKey: z.string().min(1).max(512), payload: z.unknown().optional() }))
    .min(1)
    .max(2000),
  position: z.number().int().min(0).optional()
})

const trackKeysSchema = z.object({
  trackKeys: z.array(z.string().min(1).max(512)).min(1).max(2000)
})

const settingsSchema = z.record(z.string().min(1).max(128), z.unknown())

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/favorites', { preHandler: requireAuth }, async (req) => ({ favorites: listFavorites(req.user!.id) }))

  app.post('/api/me/favorites', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = favoriteSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '参数不合法' })
    }
    upsertFavorite(req.user!.id, parsed.data.trackKey, parsed.data.payload ?? null)
    return reply.code(201).send({ ok: true })
  })

  app.delete('/api/me/favorites/:key', { preHandler: requireAuth }, async (req) => {
    const { key } = req.params as { key: string }
    return { removed: removeFavorite(req.user!.id, key) }
  })

  app.get('/api/me/playlists', { preHandler: requireAuth }, async (req) => ({ playlists: listPlaylists(req.user!.id) }))

  app.post('/api/me/playlists', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = playlistCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '歌单名称不合法' })
    }
    const id = createPlaylist(req.user!.id, parsed.data.name, parsed.data.description ?? '')
    return reply.code(201).send({ playlist: getPlaylist(req.user!.id, id) })
  })

  app.get('/api/me/playlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const playlist = getPlaylist(req.user!.id, id)
    if (!playlist) return reply.code(404).send({ error: 'NOT_FOUND', message: '歌单不存在' })
    return { playlist }
  })

  app.patch('/api/me/playlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = playlistPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '参数不合法' })
    }
    if (!updatePlaylist(req.user!.id, id, parsed.data)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '歌单不存在' })
    }
    return { playlist: getPlaylist(req.user!.id, id) }
  })

  app.delete('/api/me/playlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!deletePlaylist(req.user!.id, id)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '歌单不存在' })
    }
    return { ok: true }
  })

  app.post('/api/me/playlists/:id/tracks', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = tracksSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '曲目列表不合法' })
    }
    const tracks = parsed.data.tracks.map((t) => ({ trackKey: t.trackKey, payload: t.payload ?? null }))
    if (!addPlaylistTracks(req.user!.id, id, tracks, parsed.data.position)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '歌单不存在' })
    }
    return { playlist: getPlaylist(req.user!.id, id) }
  })

  app.delete('/api/me/playlists/:id/tracks', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = trackKeysSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '曲目列表不合法' })
    }
    if (!removePlaylistTracks(req.user!.id, id, parsed.data.trackKeys)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '歌单不存在' })
    }
    return { playlist: getPlaylist(req.user!.id, id) }
  })

  /** 重排：按传入顺序重写 position */
  app.put('/api/me/playlists/:id/tracks', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = trackKeysSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '曲目列表不合法' })
    }
    if (!reorderPlaylist(req.user!.id, id, parsed.data.trackKeys)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '歌单不存在' })
    }
    return { playlist: getPlaylist(req.user!.id, id) }
  })

  app.get('/api/me/settings', { preHandler: requireAuth }, async (req) => ({ settings: getSettings(req.user!.id) }))

  app.put('/api/me/settings', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '设置内容不合法' })
    }
    return { settings: putSettings(req.user!.id, parsed.data) }
  })
}
