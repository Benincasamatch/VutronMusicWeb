// These tests use an injected fake and never start mpv or a listener.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Coordinator } from '../src/coordinator.js'
import { addSession, FakeDriver, fixture } from './helpers.js'

let f: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => { f = await fixture() })
afterEach(async () => { await f.close() })

describe('authoritative shared control', () => {
  it('enqueues without starting audio and binds requester identity to the session', async () => {
    const response = await f.enqueue()
    expect(response.snapshot.player.status).toBe('idle')
    expect(response.snapshot.queue.entries[0]?.requester.id).toBe(f.user.user.id)
    expect(f.driver.calls.some((call) => call.operation === 'load')).toBe(false)
    expect(f.store.waiting()).toHaveLength(1)
  })

  it('restricts ordinary users to removing their own WAITING entries', async () => {
    const result = await f.enqueue()
    const entryId = result.snapshot.queue.entries[0]!.entryId
    await expect(f.coordinator.remove(f.other.context, entryId, f.mutation())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(f.coordinator.control(f.user.context, 'play', f.playback())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    await expect(f.coordinator.remove(f.user.context, entryId, f.mutation())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('allows own waiting removal and DJ moderation but never deletes current or historical entries', async () => {
    const dj = addSession(f.store, 'dj', 'presenter')
    const own = (await f.enqueue()).snapshot.queue.entries[0]!
    await f.coordinator.remove(f.user.context, own.entryId, f.mutation())
    expect(f.coordinator.snapshot().queue.entries).toHaveLength(0)
    const moderated = (await f.enqueue()).snapshot.queue.entries[0]!
    await f.coordinator.remove(dj.context, moderated.entryId, f.mutation())
    const first = (await f.enqueue()).snapshot.queue.entries[0]!
    const second = (await f.enqueue()).snapshot.queue.entries[1]!
    await f.coordinator.control(dj.context, 'play', f.playback())
    await f.coordinator.control(dj.context, 'next', f.playback())
    for (const entry of [first, second]) {
      await expect(f.coordinator.remove(f.admin.context, entry.entryId, f.mutation()))
        .rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(f.coordinator.snapshot().player.current?.entryId).toBe(second.entryId)
    expect(() => f.coordinator.users(f.auth.authenticate(dj.token))).toThrow()
  })

  it.each(['play', 'pause', 'next', 'previous', 'seek', 'volume', 'mute'] as const)(
    'rejects ordinary-user %s before consulting the player', async (command) => {
      const before = f.coordinator.snapshot()
      const calls = f.driver.calls.length
      await expect(f.coordinator.control(f.user.context, command, {
        ...f.playback(), positionSeconds: 0, volume: 10, muted: true
      })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(f.coordinator.snapshot()).toEqual(before)
      expect(f.driver.calls).toHaveLength(calls)
    }
  )

  it('rechecks the live session after waiting behind a role change, including cached retries', async () => {
    const dj = addSession(f.store, 'dj', 'presenter')
    const successful = { ...f.playback(), volume: 25 }
    await f.coordinator.control(dj.context, 'volume', successful)
    let release: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const blocked = f.coordinator.serial(() => barrier)
    const demotion = f.coordinator.changeRole(f.admin.context, dj.user.id, { requestId: randomUUID(), role: 'user' })
    const calls = f.driver.calls.length
    const fresh = expect(f.coordinator.control(dj.context, 'mute', { ...f.playback(), muted: true }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    const replay = expect(f.coordinator.control(dj.context, 'volume', successful))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    release()
    await blocked
    await demotion
    await fresh
    await replay
    expect(f.driver.calls).toHaveLength(calls)
    expect(f.coordinator.snapshot().player.volume).toBe(25)
  })

  it('checks session, CSRF, instance, revision and playback target before driver calls', async () => {
    const originalCalls = f.driver.calls.length
    await expect(f.coordinator.control({ ...f.admin.context, csrf: 'incorrect' }, 'play', f.playback()))
      .rejects.toMatchObject({ code: 'CSRF_INVALID' })
    await expect(f.coordinator.control(f.admin.context, 'volume', { ...f.playback(), serverInstanceId: randomUUID(), volume: 30 }))
      .rejects.toMatchObject({ code: 'INSTANCE_CONFLICT' })
    await expect(f.coordinator.control(f.admin.context, 'volume', { ...f.playback(), expectedRevision: 200, volume: 30 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(f.coordinator.control(f.admin.context, 'volume', { ...f.playback(), targetPlaybackId: randomUUID(), volume: 30 }))
      .rejects.toMatchObject({ code: 'PLAYBACK_CONFLICT' })
    expect(f.driver.calls).toHaveLength(originalCalls)
  })

  it('deduplicates identical concurrent intents and rejects a reused ID with different input', async () => {
    const body = { ...f.mutation(), trackId: f.catalog.track.id }
    const [first, second] = await Promise.all([
      f.coordinator.enqueue(f.user.context, body),
      f.coordinator.enqueue(f.user.context, { ...body })
    ])
    expect(second).toEqual(first)
    expect(f.coordinator.snapshot().queue.entries).toHaveLength(1)
    await expect(f.coordinator.enqueue(f.user.context, { ...body, trackId: randomUUID() }))
      .rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' })
    f.auth.revoke([f.user.digest], 'logout')
    await expect(f.coordinator.enqueue(f.user.context, body)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('deduplicates a transport retry while its first physical load is pending', async () => {
    await f.enqueue()
    let release: () => void = () => undefined
    f.driver.loadGate = new Promise<void>((resolve) => { release = resolve })
    const body = f.playback()
    const first = f.coordinator.control(f.admin.context, 'play', body)
    const second = f.coordinator.control(f.admin.context, 'play', { ...body })
    release()
    expect(await first).toEqual(await second)
    expect(f.driver.calls.filter((call) => call.operation === 'load')).toHaveLength(1)
  })

  it('does not double skip when next and the old EOF arrive together', async () => {
    await f.enqueue()
    await f.enqueue()
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    const old = f.coordinator.snapshot().player.playbackId!
    const intent = f.playback()
    const next = f.coordinator.control(f.admin.context, 'next', intent)
    f.driver.emit({ type: 'ended', playbackId: old, reason: 'eof' })
    await next
    await f.coordinator.serial(() => undefined)
    expect(f.coordinator.snapshot().queue.entries).toHaveLength(1)
    const current = f.coordinator.snapshot().player.playbackId
    expect(current).not.toBe(old)
    f.driver.emit({ type: 'sample', playbackId: old, positionSeconds: 99, durationSeconds: 100 })
    await f.coordinator.serial(() => undefined)
    expect(f.coordinator.snapshot().player.playbackId).toBe(current)
    expect(f.coordinator.snapshot().player.positionSeconds).toBe(0)
    await expect(f.coordinator.control(f.admin.context, 'next', { ...intent, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('invalidates an HTTP next that was based on pre-EOF state', async () => {
    await f.enqueue()
    await f.enqueue()
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    const intent = f.playback()
    f.driver.emit({ type: 'ended', playbackId: intent.targetPlaybackId!, reason: 'eof' })
    await expect(f.coordinator.control(f.admin.context, 'next', intent)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(f.coordinator.snapshot().queue.entries).toHaveLength(1)
  })

  it('uses real driver samples, preserves playback ID on resume and bounds seeks by duration', async () => {
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    const id = f.coordinator.snapshot().player.playbackId!
    const revision = f.coordinator.snapshot().queue.revision
    f.driver.emit({ type: 'sample', playbackId: id, positionSeconds: 10, durationSeconds: 60 })
    await f.coordinator.serial(() => undefined)
    expect(f.coordinator.snapshot().queue.revision).toBe(revision)
    expect(f.coordinator.snapshot().player.durationSeconds).toBe(60)
    await expect(f.coordinator.control(f.admin.context, 'seek', { ...f.playback(), positionSeconds: 61 }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await f.coordinator.control(f.admin.context, 'pause', f.playback())
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    expect(f.coordinator.snapshot().player.playbackId).toBe(id)
    const afterResume = f.coordinator.snapshot().queue.revision
    f.driver.emit({ type: 'pause', playbackId: id, paused: false })
    await f.coordinator.serial(() => undefined)
    expect(f.coordinator.snapshot().queue.revision).toBe(afterResume)
  })

  it('supports previous without duplicating displaced entries or pushing them back into history', async () => {
    const first = (await f.enqueue()).snapshot.queue.entries[0]!
    const second = (await f.enqueue()).snapshot.queue.entries[1]!
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    await f.coordinator.control(f.admin.context, 'next', f.playback())
    await f.coordinator.control(f.admin.context, 'previous', f.playback())
    expect(f.coordinator.snapshot().player.current?.entryId).toBe(first.entryId)
    expect(f.coordinator.snapshot().queue.entries.map((entry) => entry.entryId)).toEqual([second.entryId])
    const id = f.coordinator.snapshot().player.playbackId
    await f.coordinator.control(f.admin.context, 'previous', f.playback())
    expect(f.coordinator.snapshot().player.playbackId).toBe(id)
    expect(f.driver.calls.at(-1)).toEqual({ operation: 'seek', value: 0 })
  })

  it('reports failures explicitly and retries only with a fresh playback identity', async () => {
    await f.enqueue()
    f.driver.failLoad = true
    await expect(f.coordinator.control(f.admin.context, 'play', f.playback())).rejects.toMatchObject({ code: 'PLAYBACK_FAILED' })
    const failed = f.coordinator.snapshot()
    expect(failed.player.status).toBe('error')
    expect(failed.player.current).not.toBeNull()
    expect(failed.queue.entries).toHaveLength(0)
    f.driver.failLoad = false
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    expect(f.coordinator.snapshot().player.playbackId).not.toBe(failed.player.playbackId)
  })

  it('rebuilds a dead player once on the next play and announces it explicitly', async () => {
    const frames: Array<{ type: string }> = []
    f.coordinator.subscribe((event) => frames.push(event))
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    f.driver.emit({ type: 'unavailable', playbackId: f.coordinator.snapshot().player.playbackId })
    await f.coordinator.serial(() => undefined)
    const dead = f.coordinator.snapshot()
    expect(dead.player.status).toBe('error')
    expect(dead.player.error?.code).toBe('PLAYER_UNAVAILABLE')
    expect(frames.some((frame) => frame.type === 'player.recovered')).toBe(false)
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    expect(f.driver.calls.filter((call) => call.operation === 'restart')).toHaveLength(1)
    expect(frames.some((frame) => frame.type === 'player.recovered')).toBe(true)
    const resumed = f.coordinator.snapshot()
    expect(resumed.player.status).toBe('playing')
    expect(resumed.player.error).toBeNull()
  })

  it('keeps the failure explicit when a rebuild attempt fails', async () => {
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    f.driver.emit({ type: 'unavailable', playbackId: f.coordinator.snapshot().player.playbackId })
    await f.coordinator.serial(() => undefined)
    f.driver.restartFails = true
    await expect(f.coordinator.control(f.admin.context, 'play', f.playback())).rejects.toMatchObject({ code: 'PLAYER_UNAVAILABLE' })
    const failed = f.coordinator.snapshot()
    expect(failed.player.status).toBe('error')
    expect(failed.player.error?.code).toBe('PLAYER_UNAVAILABLE')
  })

  it('surfaces an audio-device fallback as a persistent warning and clears it when resolved', async () => {
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    const id = f.coordinator.snapshot().player.playbackId!
    f.driver.emit({ type: 'device', playbackId: randomUUID(), expected: 'pulse/a', detected: 'pulse/b', mismatch: true })
    await f.coordinator.serial(() => undefined)
    expect(f.coordinator.snapshot().player.warning).toBeNull()
    f.driver.emit({ type: 'device', playbackId: id, expected: 'pulse/a', detected: 'pulse/b', mismatch: true })
    await f.coordinator.serial(() => undefined)
    expect(f.coordinator.snapshot().player.warning?.code).toBe('AUDIO_DEVICE_FALLBACK')
    f.driver.emit({ type: 'device', playbackId: id, expected: 'pulse/a', detected: 'pulse/a', mismatch: false })
    await f.coordinator.serial(() => undefined)
    expect(f.coordinator.snapshot().player.warning).toBeNull()
  })

  it('enforces the per-account waiting allowance', async () => {
    for (let index = 0; index < 50; index += 1) await f.enqueue()
    await expect(f.enqueue()).rejects.toMatchObject({ code: 'QUEUE_FULL' })
    expect(f.coordinator.snapshot().queue.entries).toHaveLength(50)
  })

  it('rejects previous atomically if displacing current would overflow the global queue', async () => {
    await f.enqueue()
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    await f.coordinator.control(f.admin.context, 'next', f.playback())
    // Inject a full authoritative waiting list to isolate this boundary from the per-user allowance.
    const current = f.coordinator.snapshot().player.current!
    const internals = f.coordinator as unknown as { queue: typeof current[] }
    internals.queue = Array.from({ length: 500 }, () => ({ ...current, entryId: randomUUID() }))
    const before = f.coordinator.snapshot()
    const calls = f.driver.calls.length
    await expect(f.coordinator.control(f.admin.context, 'previous', f.playback())).rejects.toMatchObject({ code: 'QUEUE_FULL' })
    expect(f.coordinator.snapshot()).toEqual(before)
    expect(f.driver.calls).toHaveLength(calls)
    await expect(f.enqueue()).rejects.toMatchObject({ code: 'QUEUE_FULL' })
  })

  it('recovers waiting order and safe settings but never auto-resumes interrupted audio', async () => {
    await f.enqueue()
    await f.enqueue()
    await f.coordinator.control(f.admin.context, 'play', f.playback())
    await f.coordinator.control(f.admin.context, 'volume', { ...f.playback(), volume: 20 })
    const before = f.coordinator.snapshot()
    await f.coordinator.close()
    const nextDriver = new FakeDriver()
    const restarted = new Coordinator(f.store, f.catalog, nextDriver, f.auth)
    try {
      await restarted.initialize()
      const restored = restarted.snapshot()
      expect(restored.serverInstanceId).not.toBe(before.serverInstanceId)
      expect(restored.queue.entries).toEqual(before.queue.entries)
      expect(restored.queue.revision).toBe(0)
      expect(restored.player.status).toBe('idle')
      expect(restored.player.current).toBeNull()
      expect(restored.player.volume).toBe(20)
      expect(nextDriver.calls.some((call) => call.operation === 'load')).toBe(false)
    } finally {
      await restarted.close()
    }
  })
})
