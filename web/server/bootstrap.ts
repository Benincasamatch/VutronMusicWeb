/**
 * 首次启动引导：users 表为空时创建初始管理员。
 * 口令来源优先级：VW_ADMIN_PASSWORD → 随机生成并写入 data/INITIAL_ADMIN.txt。
 * 两种情况都要求首次登录后修改口令（must_change_password=1）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { countUsers, insertUser } from './db/users.ts'
import { generatePassword, hashPassword } from './auth/password.ts'

export interface BootstrapResult {
  created: boolean
  username?: string
  /** 只有在自动生成口令时才返回，用于写入提示文件 */
  generatedPassword?: string
}

export async function ensureBootstrapAdmin(): Promise<BootstrapResult> {
  if (countUsers() > 0) return { created: false }

  const username = config.admin.username
  const generated = config.admin.password === ''
  const password = generated ? generatePassword(16) : config.admin.password
  const passwordHash = await hashPassword(password)

  insertUser({ username, passwordHash, role: 'admin', displayName: '管理员', mustChangePassword: true })

  if (!generated) return { created: true, username }

  const file = path.join(config.dataDir, 'INITIAL_ADMIN.txt')
  fs.writeFileSync(
    file,
    [
      `用户名: ${username}`,
      `初始口令: ${password}`,
      '',
      '首次登录后必须修改口令；修改成功后本文件会自动删除。',
      new Date().toISOString()
    ].join('\n'),
    { mode: 0o600 }
  )
  return { created: true, username, generatedPassword: password }
}

/** 口令修改后清理初始口令提示文件 */
export function removeBootstrapCredentialFile(): void {
  const file = path.join(config.dataDir, 'INITIAL_ADMIN.txt')
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
}
