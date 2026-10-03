// Production static/auth integration uses temporary files, Fastify.inject
// and an injected driver only. It does not listen, start mpv or execute built assets.
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { addSession, FakeCatalog, FakeDriver, memoryStore } from './helpers.js'

let directory: string
let store: ReturnType<typeof memoryStore>
let identity: ReturnType<typeof addSession>
let service: Awaited<ReturnType<typeof createApp>> | undefined
const origin = 'https://music.example.test'
const headers = { host: 'music.example.test', origin }

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'lan-static-test-')))
  const webDist = join(directory, 'public')
  await mkdir(join(webDist, 'assets'), { recursive: true })
  await mkdir(join(webDist, 'api'))
  await writeFile(join(webDist, 'index.html'), '<!doctype html><title>Test control UI</title>')
  await writeFile(join(webDist, 'assets', 'control.js'), '/* test asset, never executed */')
  await writeFile(join(webDist, '.env'), 'DO_NOT_SERVE_PRIVATE_ENV')
  await writeFile(join(webDist, 'api', 'accidental.mp3'), 'DO_NOT_SERVE_API_ASSET')
  await writeFile(join(directory, 'outside.txt'), 'DO_NOT_SERVE_OUTSIDE_ROOT')
  store = memoryStore()
  identity = addSession(store, 'user')
  service = await createApp({
    config: {
      ...loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin, MUSIC_ROOT: './music' }),
      webDist
    },
    store,
    catalog: new FakeCatalog(),
    driver: new FakeDriver()
  })
})

afterEach(async () => {
  await service?.app.close()
  service = undefined
  store?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('production static files never replace the authenticated API', () => {
  it('serves the login shell and compiled assets without granting an API session', async () => {
    const shell = await service!.app.inject({ method: 'GET', url: '/', headers })
    expect(shell.statusCode).toBe(200)
    expect(shell.body).toContain('Test control UI')
    expect(shell.headers['content-security-policy']).toContain("media-src 'none'")
    expect(shell.headers['content-security-policy']).toContain("connect-src 'self' wss://music.example.test")
    const asset = await service!.app.inject({ method: 'GET', url: '/assets/control.js', headers })
    expect(asset.statusCode).toBe(200)
    const state = await service!.app.inject({ method: 'GET', url: '/api/state', headers })
    expect(state.statusCode).toBe(401)
    expect(state.json().error.code).toBe('UNAUTHENTICATED')
    expect(state.headers['cache-control']).toBe('no-store')
  })

  it('reserves unknown /api routes even if a matching file was packaged in dist', async () => {
    for (const url of ['/api', '/api/missing', '/api/accidental.mp3']) {
      const anonymous = await service!.app.inject({ method: 'GET', url, headers })
      expect(anonymous.statusCode).toBe(401)
      const authenticated = await service!.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, cookie: `lan_session=${identity.token}` }
      })
      expect(authenticated.statusCode).toBe(404)
      expect(authenticated.json().error.code).toBe('NOT_FOUND')
      expect(authenticated.headers['cache-control']).toBe('no-store')
      expect(authenticated.body).not.toContain('DO_NOT_SERVE_API_ASSET')
      expect(authenticated.body).not.toContain('<!doctype')
    }
  })

  it('rejects encoded and normalized path aliases before static routing can bypass API guards', async () => {
    for (const url of ['/api%2faccidental.mp3', '/%61pi/accidental.mp3', '/%2561pi/accidental.mp3', '//api/accidental.mp3', '/api/../api/accidental.mp3']) {
      const response = await service!.app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).not.toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.body).not.toContain('DO_NOT_SERVE_API_ASSET')
    }
  })

  it('does not publish dotfiles, parent-directory files or a private data route', async () => {
    for (const url of ['/.env', '/%2e%2e/outside.txt', '/data/lan.sqlite']) {
      const response = await service!.app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).not.toBe(200)
      expect(response.body).not.toContain('DO_NOT_SERVE_')
    }
  })

  it('refuses an empty output directory rather than starting production without its UI', async () => {
    const webDist = join(directory, 'empty-build')
    await mkdir(webDist)
    const isolated = memoryStore()
    try {
      await expect(createApp({
        config: {
          ...loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin, MUSIC_ROOT: './music' }),
          webDist
        },
        store: isolated,
        catalog: new FakeCatalog(),
        driver: new FakeDriver()
      })).rejects.toThrow('Production web assets are missing')
    } finally {
      isolated.close()
    }
  })

  it('enforces Host on the public shell and still denies revoked API cookies', async () => {
    const wrongHost = await service!.app.inject({ method: 'GET', url: '/', headers: { host: 'evil.invalid' } })
    expect(wrongHost.statusCode).toBe(403)
    expect(wrongHost.json().error.code).toBe('ORIGIN_REJECTED')
    service!.auth.revoke([identity.digest], 'logout')
    const revoked = await service!.app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { ...headers, cookie: `lan_session=${identity.token}` }
    })
    expect(revoked.statusCode).toBe(401)
  })
})
