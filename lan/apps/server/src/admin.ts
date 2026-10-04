import { emitKeypressEvents } from 'node:readline'
import type { Key } from 'node:readline'
import { PasswordSchema, UsernameSchema } from '@lan/shared'
import { hashPassword } from './auth.js'
import { assertUnprivileged, loadConfig } from './config.js'
import { openStore } from './store.js'

export function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error('Bootstrap requires an interactive terminal; passwords are not accepted in argv, environment or redirected input'))
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const wasRaw = input.isRaw
    let value = ''
    emitKeypressEvents(input)
    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    const clean = () => {
      input.removeListener('keypress', onKey)
      input.setRawMode(wasRaw)
      input.pause()
      process.stdout.write('\n')
    }
    const onKey = (text: string | undefined, key: Key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        value = ''
        clean()
        reject(new Error('Bootstrap cancelled'))
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        clean()
        resolve(value)
        value = ''
        return
      }
      if (key.name === 'backspace') {
        value = [...value].slice(0, -1).join('')
        return
      }
      if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(text)) {
        // Never echo characters or silently truncate a password.
        value += text
        if (value.length > 128) {
          value = ''
          clean()
          reject(new Error('Password exceeds the allowed length'))
        }
      }
    }
    input.on('keypress', onKey)
  })
}

async function main(): Promise<void> {
  assertUnprivileged()
  process.umask(0o077)
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[0] !== 'bootstrap' || args[1] !== '--username') {
    throw new Error('Use: admin bootstrap --username <name>. Password input is hidden and interactive')
  }
  const username = UsernameSchema.parse(args[2])
  const config = loadConfig()
  const opened = await openStore(config.dataDir)
  try {
    if (opened.store.users().length !== 0) throw new Error('Bootstrap is allowed only for an empty accounts table')
    let password = PasswordSchema.parse(await hiddenPassword('New administrator password (12–128 characters): '))
    let confirmation = await hiddenPassword('Confirm password: ')
    if (password !== confirmation) throw new Error('Password confirmation did not match')
    const passwordHash = await hashPassword(password)
    password = ''
    confirmation = ''
    opened.store.createAccount(username, passwordHash, 'admin', true)
    process.stdout.write('Initial administrator created. Start the service separately.\n')
  } finally {
    await opened.close()
  }
}

void main().catch(() => {
  process.stderr.write('Bootstrap failed. Require a non-root interactive terminal, valid username, matching 12–128-character passwords, empty accounts table and stopped service. No password or internal error is logged.\n')
  process.exitCode = 1
})
