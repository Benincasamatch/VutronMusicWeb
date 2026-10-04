import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { loadConfig, workspaceRoot } from '../apps/server/src/config.ts'
import { hashPassword, verifyPassword } from '../apps/server/src/auth.ts'
import { openStore } from '../apps/server/src/store.ts'

const config = loadConfig()
const preview = join(workspaceRoot, '.preview')
if (!config.simulation || config.environment !== 'development' ||
  relative(join(preview, 'data'), config.dataDir) !== '' ||
  relative(join(preview, 'music'), config.musicRoot) !== '' ||
  config.publicOrigin !== 'http://localhost:5174') {
  throw new Error('This initializer only accepts the isolated local simulation configuration')
}

await mkdir(config.musicRoot, { recursive: true, mode: 0o700 })
const samples = 4000
const wav = Buffer.alloc(44 + samples * 2)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(8000, 24)
wav.writeUInt32LE(16000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(samples * 2, 40)
for (const name of ['Preview Silence One.wav', 'Preview Silence Two.wav']) {
  const path = join(config.musicRoot, name)
  try {
    await writeFile(path, wav, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing an unsafe fixture path')
  }
}

const accessPath = join(preview, 'access.json')
const opened = await openStore(config.dataDir)
try {
  if (opened.store.users().length === 0) {
    const password = randomBytes(24).toString('base64url')
    const encoded = await hashPassword(password)
    await writeFile(accessPath, JSON.stringify({
      username: 'preview-admin',
      password,
      url: config.publicOrigin,
      purpose: 'Local development simulation only. Never use this account for deployment.'
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    try {
      opened.store.createAccount('preview-admin', encoded, 'admin', true)
    } catch (error) {
      await unlink(accessPath)
      throw error
    }
  } else {
    const access = JSON.parse(await readFile(accessPath, 'utf8'))
    const account = opened.store.accountByName('preview-admin')
    if (!account || account.role !== 'admin' || access.username !== account.username ||
      typeof access.password !== 'string' || !await verifyPassword(access.password, account.password_hash)) {
      throw new Error('Existing preview accounts were preserved; credentials were not replaced')
    }
  }
} finally {
  await opened.close()
}
console.log('Prepared two silent WAV fixtures and preview-admin in isolated simulation data.')
console.log('The random password is in lan/.preview/access.json; it has not been printed.')
