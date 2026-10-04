import { createApp } from './app.js'
import { Catalog } from './catalog.js'
import { assertUnprivileged, loadConfig } from './config.js'
import { MpvDriver } from './player/mpv.js'
import { SimulationDriver } from './player/simulation.js'
import { openStore } from './store.js'

async function main(): Promise<void> {
  assertUnprivileged()
  process.umask(0o077)
  const config = loadConfig()
  if (!config.simulation && process.platform !== 'linux') {
    throw new Error('Real playback requires Linux. No simulated player was selected')
  }
  const opened = await openStore(config.dataDir)
  let service: Awaited<ReturnType<typeof createApp>> | undefined
  let starting = true
  let signalRequested = false
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      await service?.app.close()
    } finally {
      await opened.close()
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
  }
  const onSignal = () => {
    signalRequested = true
    // During initialization keep ownership of resources until its bounded work settles.
    if (starting) return
    void stop().catch(() => {
      process.stderr.write('LAN shutdown did not finish cleanly\n')
      process.exitCode = 1
    })
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    const catalog = new Catalog(opened.store, config.musicRoot)
    await catalog.scan()
    if (!signalRequested) {
      const driver = config.simulation ? new SimulationDriver() : new MpvDriver(config.mpvPath, config.audioDevice)
      service = await createApp({ config, store: opened.store, catalog, driver })
      if (!signalRequested) await service.app.listen({ host: config.host, port: config.port })
    }
    starting = false
    if (signalRequested) await stop()
    else process.stdout.write(config.simulation
      ? 'LAN controller ready on loopback. DEVELOPMENT SIMULATION: no physical audio output.\n'
      : 'LAN controller ready on loopback. Physical mpv output enabled.\n')
  } catch (error) {
    starting = false
    await stop()
    throw error
  }
}

void main().catch(() => {
  // Do not print library errors: they can contain filenames, SQL or connection details.
  process.stderr.write('LAN startup failed. Real playback is Linux-only and requires mpv/procfs. Check non-root execution, configuration, private data lock, catalog and built assets. No fallback player was started.\n')
  process.exitCode = 1
})
