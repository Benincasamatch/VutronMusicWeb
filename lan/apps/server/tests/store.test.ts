// Migration and persistence tests use isolated node:sqlite fixtures only.
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Player, QueueEntry } from '@lan/shared'
import { openStore, Store } from '../src/store.js'

const idle: Player = {
  status: 'idle',
  current: null,
  playbackId: null,
  positionSeconds: 0,
  durationSeconds: null,
  volume: 35,
  muted: false,
  error: null,
  warning: null
}

function entry(): QueueEntry {
  return {
    entryId: randomUUID(),
    track: { id: randomUUID(), title: 'Persisted song', artist: null, album: null, durationSeconds: null },
    requester: { id: randomUUID(), username: 'requester' },
    addedAt: new Date().toISOString()
  }
}

describe('private data directory paths', () => {
  it.skipIf(process.platform !== 'win32')('accepts Windows path casing aliases without creating accounts', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'lan-store-path-'))
    try {
      const canonical = await realpath(temporary)
      const alias = canonical.replace(/^[A-Z]:/i, (drive) => drive.toLowerCase())
      const opened = await openStore(join(alias, 'data'))
      try {
        expect(opened.store.users()).toEqual([])
      } finally {
        await opened.close()
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('rejects linked ancestors, including Windows junctions', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'lan-store-link-'))
    try {
      const canonical = await realpath(temporary)
      const target = join(canonical, 'target')
      const link = join(canonical, 'linked')
      await mkdir(join(target, 'data'), { recursive: true })
      await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(openStore(join(link, 'data'))).rejects.toThrow('without symlink ancestors')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})

describe('versioned SQLite state', () => {
  it('migrates once, preserves waiting order and stores a checkpoint separately from the queue', () => {
    const db = new DatabaseSync(':memory:')
    const store = new Store(db)
    try {
      const waiting = [entry(), entry()]
      const playing: Player = {
        ...idle,
        status: 'paused',
        current: entry(),
        playbackId: randomUUID(),
        positionSeconds: 23,
        durationSeconds: 200
      }
      store.saveState(waiting, playing)
      const reopened = new Store(db)
      expect(reopened.waiting()).toEqual(waiting)
      expect(reopened.checkpoint()).toEqual(playing)
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      expect(reopened.waiting().some((queued) => queued.entryId === playing.current?.entryId)).toBe(false)
    } finally {
      store.close()
    }
  })

  it('refuses an unknown newer schema rather than resetting user data', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA user_version = 2')
    try {
      expect(() => new Store(db)).toThrow('newer application version')
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    } finally {
      db.close()
    }
  })

  it('rolls back a failed write transaction without partially replacing waiting entries', () => {
    const store = new Store(new DatabaseSync(':memory:'))
    const waiting = [entry()]
    try {
      store.saveState(waiting, idle)
      expect(() => store.transaction(() => {
        store.db.prepare('DELETE FROM waiting').run()
        throw new Error('injected transaction failure')
      })).toThrow()
      expect(store.waiting()).toEqual(waiting)
    } finally {
      store.close()
    }
  })
})
