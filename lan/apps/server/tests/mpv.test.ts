// IPC doubles only: these tests do not spawn mpv or execute any external program.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverEvent } from '../src/player/driver.js'
import { MpvDriver } from '../src/player/mpv.js'

interface Internals {
  socket: unknown
  ready: boolean
  consume: (chunk: string) => void
  command: (command: unknown[]) => Promise<unknown>
  collectStderr: (chunk: string) => void
  observations: Map<number, { playbackId: string, property: string }>
}

function ipcFixture(options: { acknowledge?: boolean, load?: boolean, device?: string } = {}) {
  const logs: string[] = []
  const driver = new MpvDriver('/never-executed/mpv', options.device ?? 'auto', (message) => logs.push(message))
  const internals = driver as unknown as Internals
  const events: DriverEvent[] = []
  const commands: Array<{ command: unknown[], request_id: number }> = []
  let playlistId = 0
  let destroyed = false
  internals.ready = true
  internals.socket = {
    write: (line: string, callback: (error?: Error) => void) => {
      const message = JSON.parse(line) as { command: unknown[], request_id: number }
      commands.push(message)
      callback()
      if (options.acknowledge === false) return
      internals.consume(`${JSON.stringify({ request_id: message.request_id, error: 'success' })}\n`)
      if (message.command[0] === 'loadfile' && options.load !== false) {
        playlistId += 1
        internals.consume(`${JSON.stringify({ event: 'start-file', playlist_entry_id: playlistId })}\n`)
        internals.consume(`${JSON.stringify({ event: 'file-loaded' })}\n`)
      }
    },
    destroy: () => { destroyed = true }
  }
  driver.setEventSink((event) => events.push(event))
  return { driver, internals, commands, events, logs, destroyed: () => destroyed }
}

afterEach(() => { vi.useRealTimers() })

describe('private mpv JSON IPC', () => {
  it('correlates responses by request ID, including out-of-order and fragmented replies', async () => {
    const f = ipcFixture({ acknowledge: false })
    try {
      const first = f.internals.command(['get_property', 'duration'])
      const second = f.internals.command(['get_property', 'time-pos'])
      const firstId = f.commands[0]!.request_id
      const secondId = f.commands[1]!.request_id
      const line = JSON.stringify({ request_id: secondId, error: 'success', data: 12 })
      f.internals.consume(line.slice(0, 10))
      f.internals.consume(`${line.slice(10)}\n`)
      f.internals.consume(`${JSON.stringify({ request_id: firstId, error: 'success', data: 60 })}\n`)
      expect(await first).toBe(60)
      expect(await second).toBe(12)
      expect(f.logs).toEqual([])
    } finally {
      await f.driver.close()
    }
  })

  it('times out commands, cancels all pending work and marks the driver unavailable', async () => {
    vi.useFakeTimers()
    const f = ipcFixture({ acknowledge: false })
    const first = f.internals.command(['get_property', 'duration'])
    const rejected = expect(first).rejects.toMatchObject({ code: 'PLAYER_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(5001)
    await rejected
    expect(f.destroyed()).toBe(true)
    expect(f.events).toContainEqual({ type: 'unavailable', playbackId: null })
    expect(f.logs).toContainEqual(expect.stringContaining('an IPC command timed out after 5 seconds'))
    await f.driver.close()
  })

  it('uses a bounded load deadline even when loadfile was acknowledged', async () => {
    vi.useFakeTimers()
    const f = ipcFixture({ load: false })
    const result = f.driver.load('/private/pinned-descriptor', randomUUID())
    const rejected = expect(result).rejects.toMatchObject({ code: 'PLAYER_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(15001)
    await rejected
    expect(f.destroyed()).toBe(true)
    expect(f.logs).toContainEqual(expect.stringContaining('did not load the file within 15 seconds'))
    await f.driver.close()
  })

  it('does not interpret stopped/replaced entries or old observer events as a new EOF/sample', async () => {
    const f = ipcFixture()
    try {
      const first = randomUUID()
      const second = randomUUID()
      await f.driver.load('/private/first', first)
      const oldObserver = [...f.internals.observations.keys()][0]!
      await f.driver.load('/private/second', second)
      f.internals.consume(`${JSON.stringify({ event: 'end-file', playlist_entry_id: 1, reason: 'eof' })}\n`)
      f.internals.consume(`${JSON.stringify({ event: 'property-change', id: oldObserver, data: 90 })}\n`)
      expect(f.events).toEqual([])
      f.internals.consume(`${JSON.stringify({ event: 'end-file', playlist_entry_id: 2, reason: 'eof' })}\n`)
      expect(f.events).toEqual([{ type: 'ended', playbackId: second, reason: 'eof' }])
      await f.driver.stop()
      f.internals.consume(`${JSON.stringify({ event: 'end-file', playlist_entry_id: 2, reason: 'stop' })}\n`)
      expect(f.events).toHaveLength(1)
    } finally {
      await f.driver.close()
    }
  })

  it('rejects oversized or malformed IPC without leaking the raw message', async () => {
    const f = ipcFixture()
    f.internals.consume('x'.repeat(262145))
    expect(f.destroyed()).toBe(true)
    expect(f.events).toEqual([{ type: 'unavailable', playbackId: null }])
    expect(f.logs).toContainEqual(expect.stringContaining('exceeded the size limit'))
    await f.driver.close()
  })

  it('reports the failure cause with the last mpv output redacted', async () => {
    const f = ipcFixture()
    f.internals.collectStderr('Failed to open /srv/lan-music/music/private track.flac\n')
    f.internals.consume('this is not JSON\n')
    const joined = f.logs.join('\n')
    expect(joined).toContain('an IPC message was not valid JSON')
    expect(joined).toContain('last mpv output: Failed to open <path>')
    expect(joined).not.toContain('/srv/lan-music')
    expect(joined).not.toContain('private track.flac')
    await f.driver.close()
  })

  it('keeps only a bounded tail of mpv output', async () => {
    const f = ipcFixture()
    const internals = f.internals as unknown as { stderrTail: string[] }
    for (let index = 0; index < 20; index += 1) f.internals.collectStderr(`line ${index}\n`)
    expect(internals.stderrTail).toHaveLength(8)
    expect(internals.stderrTail[7]).toBe('line 19')
    await f.driver.close()
  })

  it('restart clears the failure state and the output tail before starting again', async () => {
    const f = ipcFixture()
    const internals = f.internals as unknown as { broken: boolean, failure?: string, stderrTail: string[], reset: () => Promise<void> }
    f.internals.collectStderr('boom\n')
    f.internals.consume('this is not JSON\n')
    expect(internals.broken).toBe(true)
    expect(internals.stderrTail).toEqual(['boom'])
    await internals.reset()
    expect(internals.broken).toBe(false)
    expect(internals.failure).toBeUndefined()
    expect(internals.stderrTail).toEqual([])
    await f.driver.close()
  })

  it('flags a fallback when the detected device differs from an explicit device', async () => {
    const f = ipcFixture({ device: 'pulse/alsa_output.hifi' })
    try {
      const id = randomUUID()
      await f.driver.load('/private/first', id)
      const observer = [...f.internals.observations.entries()].find(([, value]) => value.property === 'audio-out-detected-device')
      expect(observer).toBeDefined()
      const observerId = observer![0]
      f.internals.consume(`${JSON.stringify({ event: 'property-change', id: observerId, data: 'alsa_output.usb-headset' })}\n`)
      expect(f.events).toContainEqual({
        type: 'device', playbackId: id, expected: 'pulse/alsa_output.hifi', detected: 'alsa_output.usb-headset', mismatch: true
      })
      f.internals.consume(`${JSON.stringify({ event: 'property-change', id: observerId, data: 'alsa_output.hifi' })}\n`)
      expect(f.events.at(-1)).toMatchObject({ type: 'device', detected: 'alsa_output.hifi', mismatch: false })
    } finally {
      await f.driver.close()
    }
  })

  it('never flags a mismatch for the auto device', async () => {
    const f = ipcFixture()
    try {
      const id = randomUUID()
      await f.driver.load('/private/first', id)
      const observerId = [...f.internals.observations.entries()].find(([, value]) => value.property === 'audio-out-detected-device')![0]
      f.internals.consume(`${JSON.stringify({ event: 'property-change', id: observerId, data: 'whatever-picked' })}\n`)
      expect(f.events.at(-1)).toMatchObject({ type: 'device', detected: 'whatever-picked', mismatch: false })
    } finally {
      await f.driver.close()
    }
  })
})
