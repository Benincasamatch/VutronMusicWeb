/**
 * 把 Web 版音乐根目录同步给内置 local 插件。
 *
 * 桌面版的 local 插件通过 IPC 目录选择器把 `scanDir` 存进自己的 store；
 * Web 版目录由服务器配置（VW_MUSIC_DIRS / PUT /api/library/roots），启动时把这批目录
 * 写入插件的 scanDir，插件即可正常返回登录态并列出曲目；已有用户配置则不覆盖。
 */
import { getDb } from '../db/index.ts'
import { getMusicRoots } from '../library/scanner.ts'

const LOCAL_INSTANCE = 'local'

export function seedLocalPluginScanDir(): string[] {
  const roots = getMusicRoots()
  if (roots.length === 0) return []

  const db = getDb()
  const row = db
    .prepare('SELECT value FROM plugin_state WHERE instance_id = ? AND key = ?')
    .get(LOCAL_INSTANCE, 'scanDir') as { value: string } | undefined
  if (row) {
    try {
      const current = JSON.parse(row.value) as unknown
      if (Array.isArray(current) && current.length > 0) return current as string[]
    } catch {
      /* 解析失败按未配置处理，下面覆盖写入合法值 */
    }
  }

  db.prepare(
    `INSERT INTO plugin_state (instance_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value`
  ).run(LOCAL_INSTANCE, 'scanDir', JSON.stringify(roots))
  return roots
}
