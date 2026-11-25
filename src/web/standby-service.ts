/**
 * The handed-over standby keeps this machine's session runtime (docs/reference/leader-switch.md,
 * "Standby"). The standby opens nothing in the home, but this machine's sessions are not the
 * home's: one process per machine holds the runtime whatever role it boots in, and the runtime
 * does not change hands when the role changes. So a standby holds it when the server it replaces
 * held it in its own process:
 *
 * - a leading service (src/binary/service-entry.ts runLeaderService) whose boot turned standby (a
 *   hand-over marker, or the witnesses naming another machine: core/leader/switch/handed-over.ts):
 *   the in-process daemon on the launcher's dir, outside the home, its door open for whoever leads
 *   now, and the launcher hears the service is ready once the runtime answers on its door and the
 *   standby answers on the port. Standby counts as ready for a leading service (the leader switch's
 *   contract): without this the ready watch wrote the fallback marker 180 s later and the machine
 *   had no session runtime meanwhile;
 * - a plain server (`walnut web`, the Mac app's) that ran its daemon in its own process (experiment
 *   `in_process_daemon`): its switch stop stopped that runtime with it, so its sessions kept running
 *   (the production dir keeps them for the next runtime, as a deploy restart does) with nothing
 *   watching them, and the new leader could not reach this machine as a host. The standby starts
 *   the same runtime on the same dir (localDaemon.holdInProcess: the in-process start's own rules),
 *   which adopts them from the registry and opens the door the new leader dials. It never starts a
 *   daemon program in its place.
 *
 * A server whose daemon is a program of its own holds nothing here: that program outlived the stop.
 */
import { serviceRuntime } from '../core/server-role.js'
import { log } from '../logging/index.js'

/** What the standby holds: the service's runtime, a plain server's in-process runtime, or none (and why). */
export type StandbyRuntime = { held: 'service' | 'in-process'; dir: string } | { held: false; why: string }

let held: StandbyRuntime['held'] = false
let state: StandbyRuntime | null = null
/** A hold still starting (its prewarm, its start): a stop meanwhile closes the runtime for good, so it never starts after the stop. */
let holding: Promise<boolean> | null = null
/** Counts the stops: a hold that a stop overtook reports nothing held, whatever its start answered. */
let releases = 0

/** What this standby holds, for its status (handed-over.ts); null before the hold ran. */
export function standbyRuntimeState(): StandbyRuntime | null { return state }

/**
 * Starts the runtime the server before this standby held (and, for a service, the launcher's beat
 * for the standby on `port`). False when this process holds no runtime: the daemon is a program of
 * its own, or the in-process start declined (logged, and named in the standby's status).
 */
export async function holdServiceRuntimeInStandby(port: number): Promise<boolean> {
  const at = releases
  const hold = holdRuntime(port)
  holding = hold
  try {
    const ok = await hold
    if (releases === at) return ok
    held = false
    state = null
    return false
  } finally { if (holding === hold) holding = null }
}

async function holdRuntime(port: number): Promise<boolean> {
  const rt = serviceRuntime()
  if (!rt) return holdPlainRuntime()
  const { startInProcessDaemon } = await import('../providers/in-process-daemon.js')
  const started = await startInProcessDaemon({
    dir: rt.dir, env: { ...rt.env, WALNUT_DAEMON_DIR: rt.dir },
    service: { home: rt.home, ...(rt.leads ? { leads: rt.leads } : {}) },
  })
  // As the leading boot does (server.ts): a service without its runtime serves nothing it is for.
  if (started.kind === 'existing') throw new Error(`another daemon holds ${rt.dir} (port ${started.port || 'none'}): this standby has no session runtime`)
  held = 'service'
  state = { held, dir: rt.dir }
  log.web.info('leader switch: this standby keeps the machine\'s session runtime', { dir: rt.dir })
  ;(await import('./serve-launcher-beat.js')).startServeLauncherBeat(port, { standby: true })
  return true
}

/** A plain server's standby: the in-process runtime on the default local daemon's dir, when this machine runs its daemon in process. */
async function holdPlainRuntime(): Promise<boolean> {
  const { inProcessDaemonWanted } = await import('../providers/in-process-daemon.js')
  if (!(await inProcessDaemonWanted())) {
    state = { held: false, why: 'this machine\'s daemon is a program of its own (in_process_daemon off): it outlived the server' }
    return false
  }
  const { localDaemon } = await import('../providers/local-daemon.js')
  let verdict: Awaited<ReturnType<typeof localDaemon.holdInProcess>>
  try {
    verdict = await localDaemon.holdInProcess()
  } catch (err) {
    verdict = { kind: 'declined', why: err instanceof Error ? err.message : String(err) }
  }
  if (verdict.kind === 'declined') {
    state = { held: false, why: verdict.why }
    log.web.warn('leader switch: this standby could not keep the machine\'s session runtime; its sessions have no daemon until one starts', { dir: localDaemon.dir, why: verdict.why })
    return false
  }
  held = 'in-process'
  state = { held, dir: localDaemon.dir }
  log.web.info('leader switch: this standby keeps the machine\'s session runtime (in process, as its server did)', { dir: localDaemon.dir })
  return true
}

/**
 * The standby's planned stop: a service's launcher leaving mark first; then the runtime stops as a
 * daemon program does (the production dir's sessions keep running for the next process, which
 * adopts them: the leader's boot on a switch back or a rollback, or the next standby).
 */
export async function releaseServiceRuntimeInStandby(reason: string, budgetMs: number): Promise<void> {
  const was = held
  // A hold still starting is stopped too: the stop closes the runtime for good first, so the start that
  // is under way is refused (InProcessDaemonClosedError, or the stop waits for it and stops what it started).
  if (!was && !holding) return
  releases++
  held = false
  state = null
  if (was === 'service') (await import('./serve-launcher-beat.js')).serveLauncherLeaving(reason)
  await (await import('../providers/in-process-daemon.js')).stopInProcessDaemon(reason, budgetMs, { forGood: true })
}
