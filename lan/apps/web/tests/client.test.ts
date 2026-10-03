import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_HEADER_NAME, IdSchema } from '@lan/shared'
import { ApiError, createApiClient, createRequestId } from '../src/api/client'
import { instanceA, session, snapshot, track, uuid } from './fixtures'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
})
const signal = () => new AbortController().signal
const meta = { requestId: uuid(50), serverInstanceId: instanceA, expectedRevision: 7 }

afterEach(() => vi.useRealTimers())

describe('same-origin API client', () => {
  it('uses cookies, no-store and CSRF, with the exact shared enqueue body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ requestId: meta.requestId, snapshot: snapshot() }))
    const api = createApiClient(fetcher)
    await api.enqueue({ ...meta, trackId: track.id }, session().csrfToken, signal())
    const [path, init] = fetcher.mock.calls[0]!
    expect(path).toBe('/api/queue')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    expect(new Headers(init?.headers).get(CSRF_HEADER_NAME)).toBe(session().csrfToken)
    expect(JSON.parse(String(init?.body))).toEqual({ ...meta, trackId: track.id })
    expect(new Headers(init?.headers).get('Origin')).toBeNull()
  })

  it('keeps passwords untouched, does not send CSRF at login and accepts 204 logout', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const api = createApiClient(fetcher)
    await api.login({ username: 'listener', password: '  twelve chars  ' }, signal())
    const login = fetcher.mock.calls[0]![1]
    expect(JSON.parse(String(login?.body)).password).toBe('  twelve chars  ')
    expect(new Headers(login?.headers).has(CSRF_HEADER_NAME)).toBe(false)
    await expect(api.logout(session().csrfToken, signal())).resolves.toBeUndefined()
    expect(fetcher.mock.calls[1]![0]).toBe('/api/auth/logout')
    expect(fetcher.mock.calls[1]![1]?.body).toBe('{}')
  })

  it('sends a playback identity even for idle volume and uses no command field', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ requestId: meta.requestId, snapshot: snapshot() }))
    const api = createApiClient(fetcher)
    await api.command({ command: 'volume', volume: 36 }, { ...meta, targetPlaybackId: null }, session().csrfToken, signal())
    expect(fetcher.mock.calls[0]![0]).toBe('/api/player/volume')
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ ...meta, targetPlaybackId: null, volume: 36 })
  })

  it('uses DELETE bodies and PATCH role bodies from the frozen contract', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestId: meta.requestId, snapshot: snapshot() }))
      .mockResolvedValueOnce(json({ requestId: meta.requestId, user: session('dj').user }))
    const api = createApiClient(fetcher)
    await api.remove(uuid(20), meta, session().csrfToken, signal())
    await api.updateRole(uuid(30), { requestId: meta.requestId, role: 'dj' }, session().csrfToken, signal())
    expect(fetcher.mock.calls[0]![1]?.method).toBe('DELETE')
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual(meta)
    expect(fetcher.mock.calls[1]![0]).toBe(`/api/admin/users/${uuid(30)}/role`)
    expect(fetcher.mock.calls[1]![1]?.method).toBe('PATCH')
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ requestId: meta.requestId, role: 'dj' })
  })

  it('encodes literal search input without leaking credentials into the URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ tracks: [], total: 0, offset: 50, limit: 50 }))
    await createApiClient(fetcher).tracks({ q: '100% & 中文', offset: 50, limit: 50 }, signal())
    const url = new URL(String(fetcher.mock.calls[0]![0]), 'https://room.example')
    expect(url.searchParams.get('q')).toBe('100% & 中文')
    expect([...url.searchParams.keys()]).toEqual(['q', 'offset', 'limit'])
    expect(fetcher.mock.calls[0]![1]?.body).toBeUndefined()
  })

  it('rejects extra private response fields and mismatched request acknowledgements', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...snapshot(), privatePath: '/private/music' }))
      .mockResolvedValueOnce(json({ requestId: uuid(51), snapshot: snapshot() }))
    const api = createApiClient(fetcher)
    await expect(api.state(signal())).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(api.enqueue({ ...meta, trackId: track.id }, session().csrfToken, signal())).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('parses safe contract errors, rejects HTML and recognizes a malformed 401 as session loss', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'REVISION_CONFLICT', message: 'Conflict' } }, 409))
      .mockResolvedValueOnce(new Response('<html>proxy</html>', { status: 502 }))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
    const api = createApiClient(fetcher)
    await expect(api.state(signal())).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 })
    await expect(api.state(signal())).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(api.me(signal())).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 })
  })

  it('bounds waiting requests and never automatically retries a mutation', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const pending = createApiClient(fetcher).enqueue({ ...meta, trackId: track.id }, session().csrfToken, signal())
    const assertion = expect(pending).rejects.toEqual(new ApiError('NETWORK_ERROR'))
    await vi.advanceTimersByTimeAsync(15000)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('creates fresh cryptographic UUIDs for user intents', () => {
    const ids = Array.from({ length: 64 }, () => createRequestId())
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(IdSchema.safeParse(id).success).toBe(true)
  })
})
