// Pure cmdline matching only: these tests never scan /proc or signal a process.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOurMpv, mpvSocketPrefix } from '../src/orphans.js'

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
