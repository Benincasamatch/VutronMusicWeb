import { WebSocket } from 'ws'
import {
  LIMITS,
  ServerEventSchema,
  WS_SESSION_REVOKED_CLOSE_CODE,
  type ServerEvent,
  type SessionRevokedReason
} from '@lan/shared'
import type { Auth } from './auth.js'
import type { Coordinator } from './coordinator.js'
import { fail } from './errors.js'

interface Client {
  socket: WebSocket
  digest: string
  lastPong: number
}

export class EventHub {
  private readonly clients = new Set<Client>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly unsubscribe: () => void
  private closed = false
  private tickPending = false

  constructor(private readonly coordinator: Coordinator, private readonly auth: Auth, private readonly now: () => number = Date.now) {
    this.unsubscribe = coordinator.subscribe((event) => {
      for (const client of this.clients) {
        try {
          auth.byDigest(client.digest)
          this.send(client, event)
        } catch {
          this.remove(client, WS_SESSION_REVOKED_CLOSE_CODE)
        }
      }
    })
    auth.onRevoked = (digests, reason) => {
      coordinator.forgetSessions(digests)
      this.revoke(digests, reason)
    }
    // Check expiry every second, separately from the 30-second heartbeat.
    this.heartbeat = setInterval(() => {
      if (this.closed || this.tickPending) return
      this.tickPending = true
      void coordinator.serialInternal(() => this.tick())
        .catch(() => this.close())
        .finally(() => { this.tickPending = false })
    }, 1000)
    this.heartbeat.unref()
  }

  count(digest: string): number {
    return [...this.clients].filter((client) => client.digest === digest).length
  }

  // Call under the same coordinator that protects the initial snapshot.
  attach(socket: WebSocket, digest: string): void {
    if (this.closed) {
      socket.close(1012)
      return
    }
    this.auth.byDigest(digest)
    if (socket.readyState !== WebSocket.OPEN) return
    if (this.count(digest) >= LIMITS.socketsPerSession) return fail('RATE_LIMITED')
    const client: Client = { socket, digest, lastPong: this.now() }
    this.clients.add(client)
    socket.on('pong', () => { client.lastPong = this.now() })
    socket.on('close', () => { this.clients.delete(client) })
    socket.on('error', () => { this.clients.delete(client) })
    this.send(client, { type: 'snapshot', snapshot: this.coordinator.snapshot() })
  }

  private send(client: Client, event: ServerEvent): void {
    if (!this.clients.has(client) || client.socket.readyState !== WebSocket.OPEN) return
    const json = JSON.stringify(ServerEventSchema.parse(event))
    if (client.socket.bufferedAmount + Buffer.byteLength(json) > LIMITS.socketBufferedBytes) {
      this.remove(client, 1013)
      return
    }
    client.socket.send(json, (error) => {
      if (error) this.remove(client, 1011)
    })
  }

  private revoke(digests: string[], reason: SessionRevokedReason): void {
    const targets = new Set(digests)
    for (const client of [...this.clients]) {
      if (!targets.has(client.digest)) continue
      this.send(client, this.coordinator.revocation(reason))
      this.remove(client, WS_SESSION_REVOKED_CLOSE_CODE)
    }
  }

  private remove(client: Client, code: number): void {
    this.clients.delete(client)
    client.socket.close(code)
    const timer = setTimeout(() => {
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate()
    }, 1000)
    timer.unref()
    client.socket.once('close', () => clearTimeout(timer))
  }

  private lastPing = 0

  private tick(): void {
    if (this.closed) return
    this.auth.expire()
    const now = this.now()
    for (const client of [...this.clients]) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        this.clients.delete(client)
        continue
      }
      try {
        this.auth.byDigest(client.digest)
      } catch {
        this.remove(client, WS_SESSION_REVOKED_CLOSE_CODE)
        continue
      }
      if (now - client.lastPong >= LIMITS.socketTimeoutMs) {
        this.clients.delete(client)
        client.socket.terminate()
      } else if (now - this.lastPing >= LIMITS.socketHeartbeatMs) {
        client.socket.ping()
      }
    }
    if (now - this.lastPing >= LIMITS.socketHeartbeatMs) this.lastPing = now
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    this.unsubscribe()
    for (const client of [...this.clients]) this.remove(client, 1001)
  }
}
