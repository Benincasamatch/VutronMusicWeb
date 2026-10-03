// Socket doubles test delivery and revocation without opening network connections.
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@lan/shared'
import { EventHub } from '../src/events.js'
import { fixture } from './helpers.js'

class SocketDouble extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  frames: ServerEvent[] = []
  closeCode: number | undefined
  send(message: string, callback: (error?: Error) => void): void {
    this.frames.push(JSON.parse(message) as ServerEvent)
    callback()
  }
  close(code: number): void {
    this.closeCode = code
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
  terminate(): void { this.close(1006) }
  ping(): void { this.emit('pong') }
  asSocket(): WebSocket { return this as unknown as WebSocket }
}

let f: Awaited<ReturnType<typeof fixture>>
let hub: EventHub
beforeEach(async () => {
  vi.useFakeTimers()
  f = await fixture()
  hub = new EventHub(f.coordinator, f.auth)
})
afterEach(async () => {
  try {
    hub.close()
    await f.close()
  } finally {
    vi.useRealTimers()
  }
})

describe('session-bound full-snapshot events', () => {
  it('subscribes and snapshots under one coordinator without leaking private credentials', async () => {
    const socket = new SocketDouble()
    await f.coordinator.serial(() => hub.attach(socket.asSocket(), f.user.digest))
    expect(socket.frames[0]?.type).toBe('snapshot')
    await f.enqueue()
    const frame = socket.frames.at(-1)
    expect(frame?.type).toBe('snapshot')
    if (frame?.type === 'snapshot') {
      expect(frame.snapshot.queue.entries).toHaveLength(1)
      expect(frame.snapshot.eventSeq).toBeGreaterThan(0)
    }
    const serialized = JSON.stringify(socket.frames)
    expect(serialized).not.toContain(f.user.token)
    expect(serialized).not.toContain(f.user.csrf)
    expect(serialized).not.toContain('password_hash')
    expect(serialized).not.toContain('/private/')
  })

  it('privately revokes logout and expiry sockets and does not broadcast revocation to others', async () => {
    const userSocket = new SocketDouble()
    const adminSocket = new SocketDouble()
    await f.coordinator.serial(() => {
      hub.attach(userSocket.asSocket(), f.user.digest)
      hub.attach(adminSocket.asSocket(), f.admin.digest)
      f.auth.revoke([f.user.digest], 'logout')
    })
    expect(userSocket.frames.at(-1)).toMatchObject({ type: 'session.revoked', reason: 'logout' })
    expect(userSocket.closeCode).toBe(4001)
    expect(adminSocket.frames.some((frame) => frame.type === 'session.revoked')).toBe(false)
    f.store.db.prepare('UPDATE sessions SET expires_at = 0 WHERE digest = ?').run(f.admin.digest)
    f.auth.expire()
    expect(adminSocket.frames.at(-1)).toMatchObject({ type: 'session.revoked', reason: 'expired' })
    expect(adminSocket.closeCode).toBe(4001)
  })

  it('closes all sessions for a changed role, including a self-demoting admin', async () => {
    f.store.createAccount('remaining-admin', 'test-only-hash', 'admin')
    const socket = new SocketDouble()
    await f.coordinator.serial(() => hub.attach(socket.asSocket(), f.admin.digest))
    await f.coordinator.changeRole(f.admin.context, f.admin.user.id, { requestId: f.mutation().requestId, role: 'dj' })
    expect(socket.frames.at(-1)).toMatchObject({ type: 'session.revoked', reason: 'role_changed' })
    expect(socket.closeCode).toBe(4001)
    expect(() => f.auth.authenticate(f.admin.token)).toThrow()
  })

  it('survives saturated reads and still expires and revokes sessions after draining', async () => {
    const userSocket = new SocketDouble()
    const adminSocket = new SocketDouble()
    await f.coordinator.serial(() => {
      hub.attach(userSocket.asSocket(), f.user.digest)
      hub.attach(adminSocket.asSocket(), f.admin.digest)
    })
    f.store.db.prepare('UPDATE sessions SET expires_at = ? WHERE digest = ?').run(Date.now() + 1000, f.user.digest)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const blocked = f.coordinator.serial(() => gate)
    const reads = Array.from({ length: 511 }, () => f.coordinator.serial(() => {
      f.auth.byDigest(f.other.digest)
      return f.coordinator.snapshot()
    }))
    const internal = vi.spyOn(f.coordinator, 'serialInternal')
    try {
      await expect(f.coordinator.serial(() => undefined)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
      await vi.advanceTimersByTimeAsync(30000)
      expect(internal).toHaveBeenCalledTimes(1)
      expect(adminSocket.readyState).toBe(WebSocket.OPEN)
      release()
      await blocked
      await Promise.all(reads)
      await f.coordinator.serial(() => undefined)
      expect(userSocket.frames.at(-1)).toMatchObject({ type: 'session.revoked', reason: 'expired' })
      expect(userSocket.closeCode).toBe(4001)
      expect(() => f.auth.byDigest(f.user.digest)).toThrow()
      expect(adminSocket.readyState).toBe(WebSocket.OPEN)
      const reconnected = new SocketDouble()
      await f.coordinator.serial(() => hub.attach(reconnected.asSocket(), f.other.digest))
      expect(reconnected.frames[0]?.type).toBe('snapshot')
      await f.coordinator.control(f.admin.context, 'volume', { ...f.playback(), volume: 20 })
      expect(reconnected.frames.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { player: { volume: 20 } } })
      await vi.advanceTimersByTimeAsync(1000)
      expect(internal).toHaveBeenCalledTimes(2)
      await f.coordinator.serial(() => f.auth.revoke([f.other.digest], 'logout'))
      expect(reconnected.frames.at(-1)).toMatchObject({ type: 'session.revoked', reason: 'logout' })
      expect(reconnected.closeCode).toBe(4001)
      expect(adminSocket.readyState).toBe(WebSocket.OPEN)
    } finally {
      release()
      await Promise.allSettled([blocked, ...reads])
    }
  })

  it('caps session sockets and rejects slow consumers rather than accumulating history', async () => {
    const sockets = [new SocketDouble(), new SocketDouble(), new SocketDouble()]
    await f.coordinator.serial(() => {
      for (const socket of sockets) hub.attach(socket.asSocket(), f.user.digest)
    })
    await expect(f.coordinator.serial(() => hub.attach(new SocketDouble().asSocket(), f.user.digest)))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' })
    sockets[0]!.bufferedAmount = 4194304
    await f.enqueue()
    expect(sockets[0]!.closeCode).toBe(1013)
    expect(hub.count(f.user.digest)).toBe(2)
  })
})
