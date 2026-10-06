import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const MPV_SOCKET_PREFIX = 'lan-mpv-'

// The private IPC socket directory each run creates: mkdtemp(join(tmpdir(), mpvSocketPrefix(dataDir))).
// The name carries a digest of the private data directory rather than its path, for two reasons.
// /proc/<pid>/cmdline is world-readable, so the name must not disclose where the library lives. And
// scoping the name to one data directory is what stops a second instance from reaping the mpv of a
// live one: only the holder of that directory's lock can be running, so once the lock is taken,
// anything still pointing at this prefix really is a leftover.
export function mpvSocketPrefix(dataDir: string): string {
  return `${MPV_SOCKET_PREFIX}${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}-`
}

export function isOurMpv(cmdline: string, socketRoot: string): boolean {
  const argument = `--input-ipc-server=${socketRoot}`
  return cmdline.split('\0').some((part) => part.startsWith(argument))
}

// A SIGKILLed or crashed run leaves its mpv child playing and holding the audio device, while the
// lock takeover lets the next run start. Reclaim only processes that are ours by uid and point at
// our own private socket directory; anything else is left alone.
const TERM_GRACE_MS = 2000
const KILL_GRACE_MS = 1000

function socketPathOf(cmdline: string): string | null {
  for (const part of cmdline.split('\0')) {
    if (part.startsWith('--input-ipc-server=')) return part.slice('--input-ipc-server='.length)
  }
  return null
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForExit(pid: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await delay(50)
  }
  return !isAlive(pid)
}

// The crashed parent created this directory with mkdtemp and never removed it. Only a directory that
// really is ours is touched: directly inside the temp directory, under our own prefix, not a link.
async function removeSocketDirectory(socketPath: string | null, prefix: string): Promise<void> {
  if (!socketPath) return
  const directory = dirname(socketPath)
  if (dirname(directory) !== tmpdir() || !basename(directory).startsWith(prefix)) return
  const info = await lstat(directory).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) return
  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

export async function sweepOrphanMpv(prefix: string, report: (message: string) => void = () => undefined): Promise<number> {
  if (process.platform !== 'linux') return 0
  const uid = process.getuid?.()
  const socketRoot = join(tmpdir(), prefix)
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
    const socketPath = socketPathOf(cmdline)
    // Re-read the command line immediately before signalling. A numeric PID is not pinned to the
    // process that was inspected, so this narrows the window in which a recycled PID could be hit.
    const confirmed = await readFile(join('/proc', name, 'cmdline'), 'utf8').catch(() => '')
    if (!isOurMpv(confirmed, socketRoot)) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      continue
    }
    let exited = await waitForExit(pid, TERM_GRACE_MS)
    if (!exited) {
      // A stopped or wedged orphan keeps the audio device open, so escalate instead of claiming success.
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        exited = true
      }
      exited = await waitForExit(pid, KILL_GRACE_MS)
    }
    if (!exited) {
      report(`A leftover mpv process (pid ${pid}) did not exit; it may still hold the audio device`)
      continue
    }
    await removeSocketDirectory(socketPath, prefix)
    reclaimed += 1
    report(`Reclaimed a leftover mpv process from a previous run (pid ${pid})`)
  }
  return reclaimed
}
