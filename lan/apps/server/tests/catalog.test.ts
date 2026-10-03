// Temporary filesystem fixtures only; no project files or audio devices are used.
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_MAX_DEPTH, Catalog } from '../src/catalog.js'
import type { TrackRow } from '../src/store.js'
import { memoryStore } from './helpers.js'

let directory: string
let music: string
let store: ReturnType<typeof memoryStore>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lan-catalog-test-'))
  music = join(directory, 'music')
  await mkdir(music)
  store = memoryStore()
})
afterEach(async () => {
  store.close()
  await rm(directory, { recursive: true, force: true })
})

describe('bounded controlled-file catalog', () => {
  it('uses stable server IDs, filename-only titles, strict extensions and literal search', async () => {
    await mkdir(join(music, 'private-folder'))
    await writeFile(join(music, 'private-folder', '100% Sound.FLAC'), 'test audio placeholder bytes')
    await writeFile(join(music, 'list.m3u'), '#EXTM3U')
    await writeFile(join(music, 'script.js'), 'not audio')
    const catalog = new Catalog(store, music)
    await catalog.scan()
    const result = catalog.list({ q: '%', offset: 0, limit: 50 })
    expect(result.total).toBe(1)
    expect(result.tracks[0]?.title).toBe('100% Sound')
    expect(result.tracks[0]?.artist).toBeNull()
    expect(JSON.stringify(result)).not.toContain('private-folder')
    expect(JSON.stringify(result)).not.toContain(directory)
    const id = result.tracks[0]!.id
    const rescanned = new Catalog(store, music)
    await rescanned.scan()
    expect(rescanned.list({ q: '', offset: 0, limit: 50 }).tracks[0]?.id).toBe(id)
  })

  it.skipIf(process.platform !== 'win32')('accepts Windows path casing aliases without treating them as symlinks', async () => {
    await writeFile(join(music, 'song.mp3'), 'bytes')
    const catalog = new Catalog(store, music.toUpperCase())
    await catalog.scan()
    const track = catalog.list({ q: '', offset: 0, limit: 50 }).tracks[0]!
    const lease = await catalog.acquire(track.id)
    await lease.close()
    expect(track.title).toBe('song')
  })

  it('rejects an actual symlink or junction in a configured root ancestor', async () => {
    await mkdir(join(music, 'nested'))
    const alias = join(directory, 'alias')
    await symlink(music, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const catalog = new Catalog(store, join(alias, 'nested'))
    await expect(catalog.scan()).rejects.toThrow('MUSIC_ROOT may not have symlink ancestors')
  })

  it('rechecks identity at load and never accepts a replaced file under an old scan', async () => {
    const path = join(music, 'song.mp3')
    await writeFile(path, 'original')
    const catalog = new Catalog(store, music)
    await catalog.scan()
    const track = catalog.list({ q: '', offset: 0, limit: 50 }).tracks[0]!
    await unlink(path)
    await writeFile(path, 'different and longer')
    await expect(catalog.acquire(track.id)).rejects.toMatchObject({ code: 'TRACK_UNAVAILABLE' })
    await expect(catalog.acquire(randomUUID())).rejects.toMatchObject({ code: 'TRACK_UNAVAILABLE' })
    const rescanned = new Catalog(store, music)
    await rescanned.scan()
    expect(rescanned.list({ q: '', offset: 0, limit: 50 }).tracks[0]?.id).not.toBe(track.id)
    await expect(rescanned.acquire(track.id)).rejects.toMatchObject({ code: 'TRACK_UNAVAILABLE' })
  })

  it.skipIf(process.platform === 'win32')('skips symlink files/directories and rejects a post-scan symlink replacement', async () => {
    await writeFile(join(directory, 'outside.mp3'), 'outside')
    await symlink(join(directory, 'outside.mp3'), join(music, 'link.mp3'))
    await mkdir(join(directory, 'external'))
    await writeFile(join(directory, 'external', 'external.wav'), 'outside')
    await symlink(join(directory, 'external'), join(music, 'linked-folder'))
    await writeFile(join(music, 'inside.mp3'), 'inside')
    const catalog = new Catalog(store, music)
    await catalog.scan()
    const result = catalog.list({ q: '', offset: 0, limit: 50 })
    expect(result.total).toBe(1)
    const id = result.tracks[0]!.id
    await unlink(join(music, 'inside.mp3'))
    await symlink(join(directory, 'outside.mp3'), join(music, 'inside.mp3'))
    await expect(catalog.acquire(id)).rejects.toMatchObject({ code: 'TRACK_UNAVAILABLE' })
  })

  it.skipIf(process.platform !== 'linux')('pins the opened descriptor so a later path swap cannot redirect mpv', async () => {
    const path = join(music, 'song.mp3')
    await writeFile(path, 'pinned bytes')
    const catalog = new Catalog(store, music)
    await catalog.scan()
    const id = catalog.list({ q: '', offset: 0, limit: 50 }).tracks[0]!.id
    const lease = await catalog.acquire(id)
    try {
      expect(lease.path).toMatch(/^\/proc\/\d+\/fd\/\d+$/)
      await unlink(path)
      await writeFile(path, 'replacement')
      expect(await readFile(lease.path, 'utf8')).toBe('pinned bytes')
    } finally {
      await lease.close()
    }
  })

  it('rejects traversal even if a private catalog record is corrupted', async () => {
    const catalog = new Catalog(store, music)
    await catalog.scan()
    const id = randomUUID()
    const internals = catalog as unknown as { records: Map<string, TrackRow> }
    internals.records.set(id, { id, relative_path: '../outside.mp3', title: 'Outside', fingerprint: 'invalid', available: 1 })
    await expect(catalog.acquire(id)).rejects.toMatchObject({ code: 'TRACK_UNAVAILABLE' })
  })

  it('does not recurse beyond the fixed maximum depth', async () => {
    let path = music
    for (let depth = 0; depth < CATALOG_MAX_DEPTH + 1; depth += 1) {
      path = join(path, 'nested')
      await mkdir(path)
    }
    await writeFile(join(path, 'too-deep.mp3'), 'bytes')
    const catalog = new Catalog(store, music)
    await catalog.scan()
    expect(catalog.list({ q: '', offset: 0, limit: 50 }).total).toBe(0)
  })
})
