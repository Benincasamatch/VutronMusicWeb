import { lstat, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The private IPC socket directory each run creates: mkdtemp(join(tmpdir(), MPV_SOCKET_PREFIX)).
export const MPV_SOCKET_PREFIX = 'lan-mpv-'

export function isOurMpv(cmdline: string, socketRoot: string): boolean {
  const argument = `--input-ipc-server=${socketRoot}`
  return cmdline.split('\0').some((part) => part.startsWith(argument))
}

// A SIGKILLed or crashed run leaves its mpv child playing and holding the audio device, while the
// lock takeover lets the next run start. Reclaim only processes that are ours by uid and point at
// our private socket directory; anything else is left alone.
export async function sweepOrphanMpv(report: (message: string) => void = () => undefined): Promise<number> {
  if (process.platform !== 'linux') return 0
  const uid = process.getuid?.()
  const socketRoot = join(tmpdir(), MPV_SOCKET_PREFIX)
  let reclaimed = 0
  const entries = await readdir('/proc').catch(() => [] as string[])
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid) continue
    const owner = (await lstat(join('/proc', name)).catch(() => null))?.uid
    if (uid !== undefined && owner !== uid) continue
    const cmdline = await readFile(join('/proc', name, 'cmdline'), 'utf8').catch(() => '')
    if (!isOurMpv(cmdline, socketRoot)) continue
    try {
      process.kill(pid, 'SIGTERM')
      reclaimed += 1
      report(`Reclaimed a leftover mpv process from a previous run (pid ${pid})`)
    } catch {
      // It exited between the scan and the signal.
    }
  }
  return reclaimed
}
