/**
 * 数据访问层：使用 Node 内置 node:sqlite（DatabaseSync），避免原生模块跨 Electron/Node ABI 冲突。
 * 表结构围绕 Web 版新增的域：用户、会话、个人收藏/歌单、插件实例与凭据、服务器播放状态、媒体令牌。
 * 注意：在线浏览/搜索结果不落库；track payload 以 JSON 原样保存，框架层不解析其字段。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { config, ensureDirs } from '../config.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'user',
  display_name         TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled             INTEGER NOT NULL DEFAULT 0,
  can_control          INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT NOT NULL,
  track_key  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_key)
);

CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_key   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  position    INTEGER NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_key)
);

CREATE TABLE IF NOT EXISTS plugin_instances (
  id            TEXT PRIMARY KEY,
  plugin_id     TEXT NOT NULL,
  owner_user_id TEXT,
  name          TEXT,
  type          TEXT,
  built_in      INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_state (
  instance_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (instance_id, key)
);

CREATE TABLE IF NOT EXISTS playback_state (
  scope      TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tokens (
  token      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  user_id    TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_tracks (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL UNIQUE,
  title       TEXT,
  artist      TEXT,
  album       TEXT,
  album_artist TEXT,
  duration    REAL,
  track_no    INTEGER,
  disc_no     INTEGER,
  size        INTEGER,
  mtime       INTEGER,
  has_cover   INTEGER NOT NULL DEFAULT 0,
  scanned_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_tracks_album ON local_tracks(album);
CREATE INDEX IF NOT EXISTS idx_local_tracks_artist ON local_tracks(artist);
`

let database: DatabaseSync | null = null

export function initDatabase(file: string = config.dbFile): DatabaseSync {
  if (database) return database
  ensureDirs()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  ensureColumns(db)
  database = db
  return db
}

/** 已存在的库补齐后续新增列（SQLite 不支持 ADD COLUMN IF NOT EXISTS） */
function ensureColumns(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(users)').all() as unknown as { name: string }[]
  const names = new Set(columns.map((c) => c.name))
  if (!names.has('can_control')) {
    db.exec('ALTER TABLE users ADD COLUMN can_control INTEGER NOT NULL DEFAULT 0')
  }
}

export function getDb(): DatabaseSync {
  if (!database) throw new Error('数据库未初始化，先调用 initDatabase()')
  return database
}

export function closeDatabase(): void {
  database?.close()
  database = null
}

/** 同步事务包装：node:sqlite 为同步 API，回调内必须全部同步执行 */
export function transaction<T>(fn: () => T): T {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
