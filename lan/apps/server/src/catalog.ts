import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats, Dirent } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { LIMITS, TrackSchema, type Track, type TrackListQuery, type TrackListResponse } from '@lan/shared'
import { isWithin } from './config.js'
import { fail } from './errors.js'
import type { Store, TrackRow } from './store.js'

const extensions = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aif', '.aiff'])
export const CATALOG_MAX_DEPTH = 12
const MAX_VISITED_ITEMS = 50000

const fingerprint = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

export interface FileLease {
  // Private, pinned descriptor name. This never crosses the public API boundary.
  path: string
  close: () => Promise<void>
}

export interface PlayableCatalog {
  get: (id: string) => Track | undefined
  acquire: (id: string) => Promise<FileLease>
}

export class Catalog implements PlayableCatalog {
  private records = new Map<string, TrackRow>()
  private root = ''

  constructor(private readonly store: Store, private readonly configuredRoot: string) {}

  async scan(): Promise<void> {
    const rootInfo = await lstat(this.configuredRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('MUSIC_ROOT must be a real directory')
    // realpath also expands Windows short names and casing; those are not symlinks.
    let ancestor = resolve(this.configuredRoot)
    while (true) {
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('MUSIC_ROOT may not have symlink ancestors')
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    this.root = await realpath(this.configuredRoot)
    const previous = new Map(this.store.tracks().map((track) => [track.relative_path, track]))
    const records: TrackRow[] = []
    let visited = 0
    const walk = async (directory: string, depth: number): Promise<void> => {
      const directoryInfo = await lstat(directory)
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(directory) !== directory) {
        throw new Error('Music scan encountered a changed directory')
      }
      const items: Dirent[] = []
      for await (const item of await opendir(directory)) {
        visited += 1
        if (visited > MAX_VISITED_ITEMS) throw new Error('Music scan exceeds the directory-entry limit')
        items.push(item)
      }
      items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      for (const item of items) {
        if (item.isSymbolicLink()) continue
        const path = join(directory, item.name)
        const info = await lstat(path, { bigint: true })
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) {
          if (depth < CATALOG_MAX_DEPTH) await walk(path, depth + 1)
          continue
        }
        if (!info.isFile() || !extensions.has(extname(item.name).toLowerCase())) continue
        if (records.length >= LIMITS.tracks) throw new Error('Music catalog exceeds 10000 audio files')
        if (!isWithin(this.root, await realpath(path))) throw new Error('Music scan escaped its configured root')
        const local = relative(this.root, path)
        const title = basename(item.name, extname(item.name)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
          .slice(0, LIMITS.displayTextMaxLength) || 'Untitled'
        const identity = fingerprint(info)
        const prior = previous.get(local)
        records.push({
          id: prior && prior.fingerprint === identity ? prior.id : randomUUID(),
          relative_path: local,
          title,
          fingerprint: identity,
          available: 1
        })
      }
    }
    await walk(this.root, 0)
    this.store.replaceCatalog(records)
    this.records = new Map(records.map((record) => [record.id, record]))
  }

  get(id: string): Track | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    return TrackSchema.parse({
      id: record.id,
      title: record.title,
      artist: null,
      album: null,
      durationSeconds: null
    })
  }

  list(query: TrackListQuery): TrackListResponse {
    const search = query.q.toLowerCase()
    const records = [...this.records.values()].filter((record) => record.title.toLowerCase().includes(search))
      .sort((a, b) => a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1)
    return {
      tracks: records.slice(query.offset, query.offset + query.limit).map((record) => this.get(record.id)!),
      total: records.length,
      offset: query.offset,
      limit: query.limit
    }
  }

  async acquire(id: string): Promise<FileLease> {
    const record = this.records.get(id)
    if (!record) return fail('TRACK_UNAVAILABLE')
    let handle: FileHandle | undefined
    try {
      const path = resolve(this.root, record.relative_path)
      if (!isWithin(this.root, path) || !extensions.has(extname(path).toLowerCase())) return fail('TRACK_UNAVAILABLE')
      // Check every component, not just the final file. Recheck after opening as well.
      await this.checkComponents(record.relative_path)
      if (!isWithin(this.root, await realpath(path))) return fail('TRACK_UNAVAILABLE')
      // O_NONBLOCK matters for safety, not speed: opening a FIFO read-only blocks until a writer
      // appears, so a file swapped for a FIFO after the scan would hang the coordinator's FIFO chain
      // forever. On a regular file the flag has no effect on reads, and non-regular files are rejected
      // by the stat below.
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || fingerprint(stat) !== record.fingerprint) return fail('TRACK_UNAVAILABLE')
      await this.checkComponents(record.relative_path)
      if (await realpath(path) !== path) return fail('TRACK_UNAVAILABLE')
      const pinned = handle
      handle = undefined
      let closed = false
      return {
        // mpv opens this descriptor through procfs; a rename/symlink swap after this point cannot redirect it.
        path: process.platform === 'linux' ? `/proc/${process.pid}/fd/${pinned.fd}` : path,
        close: async () => {
          if (closed) return
          closed = true
          await pinned.close()
        }
      }
    } catch {
      return fail('TRACK_UNAVAILABLE')
    } finally {
      await handle?.close()
    }
  }

  private async checkComponents(local: string): Promise<void> {
    let path = this.root
    const rootInfo = await lstat(path)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(path) !== this.root) fail('TRACK_UNAVAILABLE')
    for (const component of local.split(sep)) {
      if (!component || component === '.' || component === '..') fail('TRACK_UNAVAILABLE')
      path = join(path, component)
      if ((await lstat(path)).isSymbolicLink()) fail('TRACK_UNAVAILABLE')
    }
  }
}
