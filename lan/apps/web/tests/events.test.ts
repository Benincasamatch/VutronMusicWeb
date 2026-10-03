import { afterEach, describe, expect, it, vi } from 'vitest'
import { WS_PROTOCOL } from '@lan/shared'
import { eventSocketUrl, openEvents } from '../src/api/events'

class SocketStub {
  static instances: SocketStub[] = []
  protocol: string = WS_PROTOCOL
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(public url: string, public protocols: string[]) {
    SocketStub.instances.push(this)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  SocketStub.instances = []
})

describe('same-origin event connection', () => {
  it('uses same-origin ws/wss, never a token-bearing URL', () => {
    expect(eventSocketUrl('http://localhost:5174')).toBe('ws://localhost:5174/api/events')
    expect(eventSocketUrl('https://music.example')).toBe('wss://music.example/api/events')
    expect(() => eventSocketUrl('file:///tmp/index.html')).toThrow()
  })

  it('offers the exact protocol and CSRF token, then detaches handlers on close', () => {
    vi.stubGlobal('WebSocket', SocketStub)
    vi.stubGlobal('window', { location: { origin: 'https://music.example' } })
    const handlers = { message: vi.fn(), closed: vi.fn(), failed: vi.fn() }
    const connection = openEvents('a'.repeat(43), handlers)
    const socket = SocketStub.instances[0]!
    expect(socket.url).toBe('wss://music.example/api/events')
    expect(socket.protocols).toEqual(['lan.v1', `csrf.${'a'.repeat(43)}`])
    socket.onopen?.()
    socket.onmessage?.({ data: '{"type":"snapshot"}' })
    expect(handlers.message).toHaveBeenCalledWith('{"type":"snapshot"}')
    expect(handlers.failed).not.toHaveBeenCalled()
    connection.close()
    expect(socket.onmessage).toBeNull()
    expect(socket.onclose).toBeNull()
    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('rejects an unrecognized negotiated subprotocol', () => {
    vi.stubGlobal('WebSocket', SocketStub)
    vi.stubGlobal('window', { location: { origin: 'https://music.example' } })
    const handlers = { message: vi.fn(), closed: vi.fn(), failed: vi.fn() }
    openEvents('a'.repeat(43), handlers)
    const socket = SocketStub.instances[0]!
    socket.protocol = 'unexpected'
    socket.onopen?.()
    expect(handlers.failed).toHaveBeenCalledTimes(1)
    expect(socket.close).toHaveBeenCalledWith(1002)
  })
})
