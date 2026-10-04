import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'

const access = JSON.parse(await readFile(new URL('./access.json', import.meta.url), 'utf8'))
const base = 'http://localhost:5174'
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { Origin: base, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: access.username, password: access.password }),
  signal: AbortSignal.timeout(10000)
})
if (login.status !== 200) throw new Error(`Preview login failed: HTTP ${login.status}`)
const session = await login.json()
const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
if (!cookie || !session.csrfToken) throw new Error('Login did not return the expected session')
const headers = { Origin: base, Cookie: cookie, 'x-csrf-token': session.csrfToken, 'Content-Type': 'application/json' }
let socket
let loggedOut = false
const frames = []
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`)
  return response.status === 204 ? undefined : response.json()
}
async function mutate(path, payload = {}, playback = false) {
  const current = await request('/api/state')
  const body = {
    requestId: randomUUID(),
    serverInstanceId: current.serverInstanceId,
    expectedRevision: current.queue.revision,
    ...(playback ? { targetPlaybackId: current.player.playbackId } : {}),
    ...payload
  }
  return request(path, 'POST', body)
}
try {
  const initial = await request('/api/state')
  if (!initial.simulation) throw new Error('Refusing to exercise a physical player')
  const catalog = await request('/api/tracks')
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/events`, ['lan.v1', `csrf.${session.csrfToken}`], {
    headers: { Origin: base, Cookie: cookie }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket snapshot timeout')), 10000)
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data))
      frames.push(frame)
      if (frame.type === 'snapshot') {
        clearTimeout(timer)
        resolve()
      }
    })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
    socket.once('close', () => { clearTimeout(timer); reject(new Error('WebSocket closed before ready')) })
  })
  let exercised = false
  if (!initial.player.current && initial.queue.entries.length === 0) {
    const first = catalog.tracks.find((track) => track.title === 'Preview Silence One')
    const second = catalog.tracks.find((track) => track.title === 'Preview Silence Two')
    if (!first || !second) throw new Error('The synthetic preview tracks are missing')
    await mutate('/api/queue', { trackId: first.id })
    const playing = await mutate('/api/player/play', {}, true)
    if (playing.snapshot.player.status !== 'playing') throw new Error('Simulation did not enter playing state')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const paused = await mutate('/api/player/pause', {}, true)
    if (paused.snapshot.player.status !== 'paused') throw new Error('Simulation did not pause')
    await mutate('/api/queue', { trackId: second.id })
    exercised = true
  }
  const final = await request('/api/state')
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Session revocation timeout')), 10000)
    socket.once('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  await request('/api/auth/logout', 'POST', {})
  loggedOut = true
  const closeCode = await closed
  if (closeCode !== 4001) throw new Error('Logout did not revoke the live socket')
  console.log(JSON.stringify({
    login: 'passed',
    simulation: final.simulation,
    catalogTracks: catalog.total,
    websocketSnapshots: frames.filter((frame) => frame.type === 'snapshot').length,
    controlsExercised: exercised,
    playback: final.player.status,
    waitingTracks: final.queue.entries.length,
    logoutSocketCloseCode: closeCode,
    credentialsPrinted: false
  }, null, 2))
} finally {
  if (!loggedOut) await request('/api/auth/logout', 'POST', {}).catch(() => undefined)
  socket?.terminate()
}
