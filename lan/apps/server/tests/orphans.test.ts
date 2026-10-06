// Pure cmdline matching only: these tests never scan /proc or signal a process.
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOurMpv, mpvSocketPrefix, sweepOrphanMpv } from '../src/orphans.js'

const socketRoot = '/tmp/lan-mpv-'

function cmdline(...args: string[]): string {
  return args.join('\0')
}

describe('orphan mpv matching', () => {
  it('matches only our private IPC socket directory', () => {
    expect(isOurMpv(cmdline('/usr/bin/mpv', '--no-config', `--input-ipc-server=${socketRoot}AbC123/ipc`), socketRoot)).toBe(true)
    expect(isOurMpv(cmdline('/usr/bin/mpv', `--input-ipc-server=/run/user/1000/mpv/ipc`), socketRoot)).toBe(false)
    expect(isOurMpv(cmdline('/usr/bin/mpv', '--input-ipc-server=/tmp/other/ipc'), socketRoot)).toBe(false)
    expect(isOurMpv(cmdline('/usr/bin/mpv'), socketRoot)).toBe(false)
    expect(isOurMpv('', socketRoot)).toBe(false)
  })

  it('does not match a lookalike prefix in another argument', () => {
    expect(isOurMpv(cmdline('/usr/bin/mpv', `--script=x--input-ipc-server=${socketRoot}z/ipc`), socketRoot)).toBe(false)
    expect(isOurMpv(cmdline('/usr/bin/mpv', '--title=lan-mpv-', `--input-ipc-server=${socketRoot}z/ipc`), socketRoot)).toBe(true)
  })
})

describe('socket directory scoping', () => {
  it('scopes the prefix to one data directory without disclosing its path', () => {
    const first = mpvSocketPrefix('/srv/lan-music/data')
    expect(first).toMatch(/^lan-mpv-[0-9a-f]{12}-$/)
    expect(first).not.toBe(mpvSocketPrefix('/srv/other-library/data'))
    expect(first).not.toContain('/srv')
    expect(mpvSocketPrefix('/srv/lan-music/data')).toBe(first)
  })

  it('never matches an mpv belonging to a different data directory', () => {
    const mine = join(tmpdir(), mpvSocketPrefix('/srv/lan-music/data'))
    const theirs = join(tmpdir(), mpvSocketPrefix('/srv/other-library/data'))
    // Same account, same temporary directory, different data directory: the process a broader sweep
    // used to kill while its own service was still running.
    const foreign = cmdline('/usr/bin/mpv', '--no-config', `--input-ipc-server=${theirs}AbC123/ipc`)
    expect(isOurMpv(foreign, mine)).toBe(false)
    expect(isOurMpv(foreign, theirs)).toBe(true)
  })
})

// Real children only, and the sweep is scoped to a prefix unique to this test run, so it can never
// reach a process the host owns. No mpv and no audio device are involved.
describe('orphan reclamation', () => {
  const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

  const start = async (prefix: string, onTerm: string) => {
    const directory = await mkdtemp(join(tmpdir(), prefix))
    const script = join(directory, 'holder.js')
    await writeFile(script, [
      `process.on('SIGTERM', ${onTerm})`,
      "process.stdout.write('ready')",
      'setInterval(() => {}, 1000)'
    ].join('\n'))
    const child = spawn(process.execPath, [script, `--input-ipc-server=${join(directory, 'ipc')}`], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never reported readiness')), 10000)
      child.stdout!.once('data', () => { clearTimeout(timer); resolve() })
      child.once('error', reject)
      child.once('exit', () => reject(new Error('the holder exited before the sweep ran')))
    })
    return { directory, child }
  }

  const stop = async (child: ChildProcess, directory: string) => {
    if (alive(child)) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
    await rm(directory, { recursive: true, force: true })
  }

  it.skipIf(process.platform !== 'linux')('reclaims a cooperative orphan and removes its directory', async () => {
    const prefix = `lan-mpv-test-${process.pid}-`
    const { directory, child } = await start(prefix, '() => process.exit(0)')
    try {
      const messages: string[] = []
      expect(await sweepOrphanMpv(prefix, (message) => messages.push(message))).toBe(1)
      expect(messages.some((message) => /Reclaimed/.test(message))).toBe(true)
      expect(alive(child)).toBe(false)
      expect(child.signalCode).toBe(null)
      // The crashed parent's private directory goes with the process it belonged to.
      expect(await lstat(directory).catch(() => null)).toBeNull()
    } finally {
      await stop(child, directory)
    }
  })

  it.skipIf(process.platform !== 'linux')('escalates to SIGKILL and reports only once the orphan is gone', async () => {
    const prefix = `lan-mpv-test-${process.pid}-`
    // This holder ignores SIGTERM, which is what a stopped or wedged orphan looks like.
    const { directory, child } = await start(prefix, '() => undefined')
    try {
      const messages: string[] = []
      expect(await sweepOrphanMpv(prefix, (message) => messages.push(message))).toBe(1)
      expect(messages.some((message) => /Reclaimed/.test(message))).toBe(true)
      expect(alive(child)).toBe(false)
      expect(child.signalCode).toBe('SIGKILL')
    } finally {
      await stop(child, directory)
    }
  })
})
