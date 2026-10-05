// Pure cmdline matching only: these tests never scan /proc or signal a process.
import { describe, expect, it } from 'vitest'
import { isOurMpv } from '../src/orphans.js'

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
