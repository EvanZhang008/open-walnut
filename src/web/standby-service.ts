/**
 * A leading service (src/binary/service-entry.ts runLeaderService) whose boot turned standby (a
 * hand-over marker, or the witnesses naming another machine: core/leader/switch/handed-over.ts).
 * The standby opens nothing in the home, but this machine's sessions are not the home's: they keep
 * their runtime (the in-process daemon on the launcher's dir, outside the home, its door open for
 * whoever leads now), and the launcher hears the service is ready once the runtime answers on its
 * door and the standby answers on the port. Standby counts as ready for a leading service (the
 * leader switch's contract): without this the ready watch wrote the fallback marker 180 s later
 * and the machine had no session runtime meanwhile.
 * Nothing here runs when this process holds no service runtime (the Mac's own standby).
 */
import { serviceRuntime } from '../core/server-role.js'
import { log } from '../logging/index.js'

let held = false

/** Starts the runtime and the launcher's beat for the standby on `port`. False when this process holds no service runtime. */
export async function holdServiceRuntimeInStandby(port: number): Promise<boolean> {
  const rt = serviceRuntime()
  if (!rt) return false
  const { startInProcessDaemon } = await import('../providers/in-process-daemon.js')
  const started = await startInProcessDaemon({
    dir: rt.dir, env: { ...rt.env, WALNUT_DAEMON_DIR: rt.dir },
    service: { home: rt.home, ...(rt.leads ? { leads: rt.leads } : {}) },
  })
  // As the leading boot does (server.ts): a service without its runtime serves nothing it is for.
  if (started.kind === 'existing') throw new Error(`another daemon holds ${rt.dir} (port ${started.port || 'none'}): this standby has no session runtime`)
  held = true
  log.web.info('leader switch: this standby keeps the machine\'s session runtime', { dir: rt.dir })
  ;(await import('./serve-launcher-beat.js')).startServeLauncherBeat(port, { standby: true })
  return true
}

/** The standby's planned stop: the launcher's leaving mark, then the runtime stops as a daemon program does. */
export async function releaseServiceRuntimeInStandby(reason: string, budgetMs: number): Promise<void> {
  if (!held) return
  held = false
  ;(await import('./serve-launcher-beat.js')).serveLauncherLeaving(reason)
  await (await import('../providers/in-process-daemon.js')).stopInProcessDaemon(reason, budgetMs, { forGood: true })
}
