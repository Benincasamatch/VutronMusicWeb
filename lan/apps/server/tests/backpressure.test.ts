import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture } from './helpers.js'

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

let f: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  vi.useFakeTimers()
  f = await fixture()
})
afterEach(async () => {
  try {
    await f.close()
  } finally {
    vi.useRealTimers()
  }
})

describe('bounded external admission and reserved player events', () => {
  it('processes samples and EOF exactly once after a blocked load and saturated reads', async () => {
    await f.enqueue()
    const second = (await f.enqueue()).snapshot.queue.entries[1]!
    const gate = deferred()
    const started = deferred()
    f.driver.loadGate = gate.promise
    const originalLoad = f.driver.load.bind(f.driver)
    vi.spyOn(f.driver, 'load').mockImplementation(async (path, id) => {
      started.resolve()
      await originalLoad(path, id)
    })
    const playing = f.coordinator.control(f.admin.context, 'play', f.playback())
    await started.promise
    const reads = Array.from({ length: 511 }, () => f.coordinator.serial(() => {
      f.auth.byDigest(f.other.digest)
      return f.coordinator.snapshot()
    }))
    const internal = vi.spyOn(f.coordinator, 'serialInternal')
    try {
      await expect(f.coordinator.serial(() => undefined)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
      const id = f.coordinator.snapshot().player.playbackId!
      for (let index = 0; index < 4096; index += 1) {
        f.driver.emit({ type: 'sample', playbackId: id, positionSeconds: index % 60, durationSeconds: 90 })
      }
      f.driver.emit({ type: 'pause', playbackId: id, paused: true })
      f.driver.emit({ type: 'ended', playbackId: id, reason: 'eof' })
      expect(internal).toHaveBeenCalledTimes(3)
      gate.resolve()
      await playing
      await Promise.all(reads)
      await f.coordinator.serial(() => undefined)
      expect(f.coordinator.snapshot().player.current?.entryId).toBe(second.entryId)
      expect(f.coordinator.snapshot().queue.entries).toHaveLength(0)
      expect(f.driver.calls.filter((call) => call.operation === 'load')).toHaveLength(2)
      expect(f.driver.calls.some((call) => call.operation === 'close')).toBe(false)
      await f.coordinator.control(f.admin.context, 'mute', { ...f.playback(), muted: true })
      expect(f.coordinator.snapshot().player.muted).toBe(true)
    } finally {
      gate.resolve()
      await Promise.allSettled([playing, ...reads])
    }
  })

  it('coalesces only adjacent samples and preserves a position on duration-only updates', async () => {
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    const id = f.coordinator.snapshot().player.playbackId!
    const gate = deferred()
    const blocked = f.coordinator.serial(() => gate.promise)
    try {
      f.driver.emit({ type: 'sample', playbackId: id, positionSeconds: 10, durationSeconds: 60 })
      const middle = f.coordinator.serial(() => f.coordinator.snapshot().player.positionSeconds)
      f.driver.emit({ type: 'sample', playbackId: id, positionSeconds: 20, durationSeconds: 60 })
      f.driver.emit({ type: 'sample', playbackId: id, positionSeconds: null, durationSeconds: 90 })
      gate.resolve()
      await blocked
      expect(await middle).toBe(10)
      await f.coordinator.serial(() => undefined)
      expect(f.coordinator.snapshot().player).toMatchObject({ positionSeconds: 20, durationSeconds: 90 })
    } finally {
      gate.resolve()
      await blocked
    }
  })

  it('keeps one pending sample publication while requests are blocked', async () => {
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    const id = f.coordinator.snapshot().player.playbackId!
    f.driver.emit({ type: 'sample', playbackId: id, positionSeconds: 12, durationSeconds: 60 })
    await f.coordinator.serial(() => undefined)
    const before = f.coordinator.snapshot().eventSeq
    const gate = deferred()
    const blocked = f.coordinator.serial(() => gate.promise)
    const reads = Array.from({ length: 511 }, () => f.coordinator.serial(() => f.coordinator.snapshot()))
    const internal = vi.spyOn(f.coordinator, 'serialInternal')
    try {
      await vi.advanceTimersByTimeAsync(30000)
      expect(internal).toHaveBeenCalledTimes(1)
      expect(f.driver.calls.some((call) => call.operation === 'close')).toBe(false)
      gate.resolve()
      await blocked
      await Promise.all(reads)
      await f.coordinator.serial(() => undefined)
      expect(f.coordinator.snapshot().eventSeq).toBe(before + 1)
      expect(f.coordinator.snapshot().player.positionSeconds).toBe(12)
    } finally {
      gate.resolve()
      await Promise.allSettled([blocked, ...reads])
    }
  })

  it('does not discard an unavailable event while external admission is full', async () => {
    const gate = deferred()
    const blocked = f.coordinator.serial(() => gate.promise)
    const reads = Array.from({ length: 511 }, () => f.coordinator.serial(() => undefined))
    try {
      f.driver.emit({ type: 'unavailable', playbackId: null })
      gate.resolve()
      await blocked
      await Promise.all(reads)
      await f.coordinator.serial(() => undefined)
      expect(f.coordinator.snapshot().player).toMatchObject({
        status: 'error', error: { code: 'PLAYER_UNAVAILABLE' }
      })
    } finally {
      gate.resolve()
      await Promise.allSettled([blocked, ...reads])
    }
  })

  it('bounds internal backlog and still fails closed on a genuine invariant failure', async () => {
    const gate = deferred()
    const blocked = f.coordinator.serial(() => gate.promise)
    await Promise.resolve()
    const jobs = Array.from({ length: 1024 }, () => f.coordinator.serialInternal(() => undefined).catch((error: unknown) => error))
    try {
      await expect(f.coordinator.serialInternal(() => undefined)).rejects.toMatchObject({ code: 'PLAYER_UNAVAILABLE' })
      expect(f.driver.calls.filter((call) => call.operation === 'close')).toHaveLength(1)
      gate.resolve()
      await blocked
      await Promise.all(jobs)
      await expect(f.coordinator.serial(() => undefined)).rejects.toMatchObject({ code: 'PLAYER_UNAVAILABLE' })
      expect(f.driver.calls.filter((call) => call.operation === 'close')).toHaveLength(1)
    } finally {
      gate.resolve()
      await Promise.allSettled([blocked, ...jobs])
    }
  })

  it('fails closed on persistence errors rather than treating them as backpressure', async () => {
    vi.spyOn(f.store, 'saveState').mockImplementationOnce(() => { throw new Error('disk failure') })
    await expect(f.enqueue()).rejects.toThrow('disk failure')
    expect(f.driver.calls.filter((call) => call.operation === 'close')).toHaveLength(1)
    await expect(f.coordinator.serial(() => undefined)).rejects.toMatchObject({ code: 'PLAYER_UNAVAILABLE' })
  })

  it('cancels queued lifecycle work on shutdown without another fatal transition', async () => {
    const gate = deferred()
    const blocked = f.coordinator.serial(() => gate.promise)
    await Promise.resolve()
    const queued = f.coordinator.serialInternal(() => undefined).catch((error: unknown) => error)
    f.driver.emit({ type: 'unavailable', playbackId: null })
    const closing = f.coordinator.close()
    gate.resolve()
    await blocked
    expect(await queued).toMatchObject({ code: 'PLAYER_UNAVAILABLE' })
    await closing
    expect(f.driver.calls.filter((call) => call.operation === 'close')).toHaveLength(1)
    expect(f.coordinator.snapshot().player.status).toBe('idle')
  })
})
