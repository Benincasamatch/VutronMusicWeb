import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const SHELL = process.env.SHELL_EXE
const PORT = Number(process.env.CDP_PORT || 9333)
const BASE = 'http://localhost:5174'
const OUT = new URL('./', import.meta.url)

const chrome = spawn(SHELL, [
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--user-data-dir=${join(tmpdir(), 'lan-shot-profile')}`,
  '--window-size=1280,860',
  'about:blank'
], { stdio: 'ignore' })

async function waitVersion() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('CDP page target not ready')
}

const version = await waitVersion()
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 })
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
let seq = 0
const pending = new Map()
ws.on('message', (data) => {
  const msg = JSON.parse(data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL(name, OUT), Buffer.from(r.data, 'base64'))
  console.log('wrote', name)
}
async function goto(url) { await send('Page.navigate', { url }); await wait(2600) }

await goto(BASE)
await shot('shot-login.png')

const access = JSON.parse(await readFile(new URL('./access.json', import.meta.url), 'utf8'))
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: access.username, password: access.password })
})
if (login.status !== 200) throw new Error(`login failed: ${login.status}`)
const pair = login.headers.getSetCookie()[0].split(';')[0]
await send('Network.setCookie', {
  name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1),
  url: BASE, httpOnly: true, sameSite: 'Strict', path: '/'
})

await goto(BASE)
await wait(1500)
await shot('shot-session.png')

await send('Page.navigate', { url: `${BASE}/#queue` })
await wait(1600)
await shot('shot-queue.png')

await send('Page.navigate', { url: `${BASE}/#accounts` })
await wait(1600)
await shot('shot-accounts.png')

ws.close()
chrome.kill()
console.log('done')
