import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rm, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LIMITS,
  PlayerSchema,
  PublicUserSchema,
  QueueEntrySchema,
  type Player,
  type PublicUser,
  type QueueEntry,
  type Role
} from '@lan/shared'
import { fail, StartupError } from './errors.js'

export interface AccountRow extends PublicUser {
  password_hash: string
}

export interface SessionRow {
  digest: string
  user_id: string
  csrf: string
  expires_at: number
  created_at: number
}

export interface TrackRow {
  id: string
  relative_path: string
  title: string
  fingerprint: string
  available: number
}

export class Store {
  constructor(readonly db: DatabaseSync) {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
    this.migrate()
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > 1) throw new StartupError('This database requires a newer application version')
    if (version === 1) return
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE COLLATE BINARY,
          role TEXT NOT NULL CHECK (role IN ('admin', 'dj', 'user')),
          password_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE sessions (
          digest TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          csrf TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE TABLE tracks (
          id TEXT PRIMARY KEY,
          relative_path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          available INTEGER NOT NULL CHECK (available IN (0, 1))
        ) STRICT;
        CREATE TABLE waiting (
          ordinal INTEGER PRIMARY KEY,
          entry_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE checkpoint (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          player_json TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
      `)
    })
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  accountByName(username: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as unknown as AccountRow | undefined
  }

  account(id: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined
  }

  users(): PublicUser[] {
    return this.db.prepare('SELECT id, username, role FROM accounts ORDER BY username, id').all()
      .map((row) => PublicUserSchema.parse(row))
  }

  createAccount(username: string, passwordHash: string, role: Role, bootstrap = false): PublicUser {
    return this.transaction(() => {
      const count = (this.db.prepare('SELECT count(*) AS count FROM accounts').get() as { count: number }).count
      if (bootstrap && count !== 0) fail('FORBIDDEN')
      if (count >= LIMITS.users) fail('USER_LIMIT')
      if (this.accountByName(username)) fail('USERNAME_TAKEN')
      const user = PublicUserSchema.parse({ id: randomUUID(), username, role })
      this.db.prepare('INSERT INTO accounts (id, username, role, password_hash) VALUES (?, ?, ?, ?)')
        .run(user.id, username, role, passwordHash)
      return user
    })
  }

  changeRole(userId: string, role: Role): { user: PublicUser, revoked: string[] } {
    return this.transaction(() => {
      const account = this.account(userId)
      if (!account) return fail('NOT_FOUND')
      const user: PublicUser = { id: account.id, username: account.username, role }
      if (account.role === role) return { user, revoked: [] }
      if (account.role === 'admin' && role !== 'admin') {
        const admins = (this.db.prepare(`SELECT count(*) AS count FROM accounts WHERE role = 'admin'`)
          .get() as { count: number }).count
        if (admins <= 1) fail('LAST_ADMIN')
      }
      const revoked = this.db.prepare('SELECT digest FROM sessions WHERE user_id = ?').all(userId)
        .map((row) => String(row.digest))
      this.db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(role, userId)
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
      return { user, revoked }
    })
  }

  session(digest: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE digest = ?').get(digest) as unknown as SessionRow | undefined
  }

  createSession(row: SessionRow, replaced: string | null, now: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      if (replaced) this.db.prepare('DELETE FROM sessions WHERE digest = ?').run(replaced)
      const count = (this.db.prepare('SELECT count(*) AS count FROM sessions WHERE user_id = ?')
        .get(row.user_id) as { count: number }).count
      if (count >= LIMITS.sessionsPerUser) fail('RATE_LIMITED')
      this.db.prepare('INSERT INTO sessions (digest, user_id, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(row.digest, row.user_id, row.csrf, row.expires_at, row.created_at)
    })
  }

  deleteSession(digest: string): void {
    this.db.prepare('DELETE FROM sessions WHERE digest = ?').run(digest)
  }

  expireSessions(now: number): string[] {
    return this.transaction(() => {
      const digests = this.db.prepare('SELECT digest FROM sessions WHERE expires_at <= ?').all(now)
        .map((row) => String(row.digest))
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      return digests
    })
  }

  tracks(): TrackRow[] {
    return this.db.prepare('SELECT * FROM tracks').all() as unknown as TrackRow[]
  }

  replaceCatalog(records: TrackRow[]): void {
    this.transaction(() => {
      this.db.prepare('UPDATE tracks SET available = 0').run()
      const update = this.db.prepare(`
        INSERT INTO tracks (id, relative_path, title, fingerprint, available) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(relative_path) DO UPDATE SET id = excluded.id, title = excluded.title,
          fingerprint = excluded.fingerprint, available = 1
      `)
      for (const record of records) update.run(record.id, record.relative_path, record.title, record.fingerprint)
    })
  }

  waiting(): QueueEntry[] {
    const rows = this.db.prepare('SELECT entry_json FROM waiting ORDER BY ordinal').all()
    if (rows.length > LIMITS.queueEntries) throw new Error('Invalid persisted queue size')
    return rows.map((row) => QueueEntrySchema.parse(JSON.parse(String(row.entry_json)) as unknown))
  }

  checkpoint(): Player | null {
    const row = this.db.prepare('SELECT player_json FROM checkpoint WHERE singleton = 1').get()
    if (!row) return null
    // A row written before a nullable field existed must stay readable; fill it before strict validation.
    const stored = JSON.parse(String(row.player_json)) as Record<string, unknown>
    return PlayerSchema.parse({ warning: null, ...stored })
  }

  saveState(waiting: QueueEntry[], player: Player): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM waiting').run()
      const insert = this.db.prepare('INSERT INTO waiting (ordinal, entry_json) VALUES (?, ?)')
      for (const [index, entry] of waiting.entries()) insert.run(index, JSON.stringify(entry))
      this.db.prepare(`INSERT INTO checkpoint (singleton, player_json) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET player_json = excluded.player_json`).run(JSON.stringify(player))
    })
  }

  close(): void {
    this.db.close()
  }
}

export interface OpenStore {
  store: Store
  close: () => Promise<void>
}

export async function openStore(dataDir: string): Promise<OpenStore> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const info = await lstat(dataDir)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new StartupError('DATA_DIR must be a real directory without symlink ancestors')
  }
  // Windows realpath expands casing and short names; inspect ancestors rather
  // than mistaking those legitimate aliases for symlinks or junctions.
  let ancestor = resolve(dataDir)
  while (true) {
    if ((await lstat(ancestor)).isSymbolicLink()) {
      throw new StartupError('DATA_DIR must be a real directory without symlink ancestors')
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  dataDir = await realpath(dataDir)
  if (process.getuid && info.uid !== process.getuid()) throw new StartupError('DATA_DIR must belong to the service account')
  await chmod(dataDir, 0o700)
  const lockPath = resolve(dataDir, 'service.lock')
  const lock = await claimLock(lockPath)
  let store: Store | undefined
  let database: DatabaseSync | undefined
  try {
    await lock.writeFile(String(process.pid))
    const databasePath = resolve(dataDir, 'lan.sqlite')
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (existing && (!existing.isFile() || existing.isSymbolicLink() ||
        process.getuid && existing.uid !== process.getuid())) {
        throw new StartupError('Database and sidecars must be regular files owned by the service account')
      }
    }
    database = new DatabaseSync(databasePath)
    store = new Store(database)
    await chmod(databasePath, 0o600)
    let closed = false
    return {
      store,
      close: async () => {
        if (closed) return
        closed = true
        try {
          store?.close()
        } finally {
          await lock.close()
          await unlink(lockPath)
        }
      }
    }
  } catch (error) {
    if (store) store.close()
    else database?.close()
    await lock.close()
    await unlink(lockPath)
    throw error
  }
}

// A lock whose owner is provably gone is stale: take it over so a crash or SIGKILL does not need a
// manual step before a supervised restart can succeed. Anything ambiguous still fails closed.
async function claimLock(lockPath: string): Promise<FileHandle> {
  try {
    return await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new StartupError('DATA_DIR is locked and the lock file could not be inspected; inspect it manually')
    }
  }
  const first = await readLock(lockPath)
  const owner = Number(first?.text.trim())
  if (!first || !Number.isInteger(owner) || owner <= 0) {
    throw new StartupError('DATA_DIR is locked by an unreadable owner; inspect stale locks manually')
  }
  if (isRunning(owner)) {
    throw new StartupError(`DATA_DIR is locked by a running service (pid ${owner}); stop it before starting another instance`)
  }
  // Replacing the lock is a compare-and-swap, not a blind delete. Another process may have judged the
  // same lock stale and already installed its own; deleting that one would leave two live owners of one
  // data directory. Only the exact file we judged stale may be removed, and creating our own lock below
  // stays the atomic gate if the swap still loses a race. A residual window remains between the check
  // and the removal, which no amount of re-reading closes without an OS-level exclusive lock.
  const again = await readLock(lockPath)
  if (!again || again.text !== first.text || again.ino !== first.ino) {
    throw new StartupError('DATA_DIR lock changed while it was being inspected; start again')
  }
  await rm(lockPath, { force: true })
  try {
    return await open(lockPath, 'wx', 0o600)
  } catch {
    throw new StartupError('DATA_DIR is locked and the stale lock could not be replaced; inspect stale locks manually')
  }
}

// A lock that is not a plain file is never trusted, whatever it claims to contain.
async function readLock(lockPath: string): Promise<{ text: string, ino: number } | null> {
  try {
    const info = await lstat(lockPath)
    if (!info.isFile() || info.isSymbolicLink()) return null
    return { text: await readFile(lockPath, 'utf8'), ino: Number(info.ino) }
  } catch {
    return null
  }
}

// A recycled PID looks alive, which keeps the safe (fail-closed) direction.
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
