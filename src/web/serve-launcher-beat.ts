/**
 * `walnut serve` under a launcher (service-launcher-script.ts starts it with WALNUT_LAUNCHER_DIR):
 * the server writes the launcher's marks itself (service-launcher-beat.ts), as the daemon service
 * does today, so a launcher keeps the server the way it keeps that service: one command to swap.
 *   - heartbeat: from the server's own event loop, so a stalled server writes none;
 *   - ready: once it serves: sessions adopted (the in-process daemon, when it runs one, answers
 *     hello as itself and status; a host's one Walnut service, over its door), the port listening,
 *     and one real request on that port answered right (200 with a JSON object): GET /api/config,
 *     or on a host replica, which trusts no loopback caller, the public GET /api/v1/instance;
 *   - leaving: just before a planned stop (stopServer), so the launcher counts it as no crash.
 * The variables are the launcher's own: they are taken out of this process's env at its start
 * (launcher-env.ts), so no daemon or session started below the server writes the launcher's marks.
 *
 * WALNUT_LAUNCHER_SERVICE_PID: the pid the launcher started, when that is not this process. On the
 * Mac the launcher runs a version's run script (scripts/lib/devprod-launcher.sh), which puts the
 * server under Walnut.app's session host, so the server is two processes below the launcher's
 * child; its marks name the child, as the launcher matches them by pid.
 * On the leader (not a host's one service) a put-back the launcher made is raised in Walnut Health
 * here, as the leader raises a host's from its hello.
 * Nothing here throws into the server.
 */
import { startLauncherBeat, type LauncherBeat } from '../providers/service-launcher-beat.js'
import { log } from '../logging/index.js'
import { takeLauncherEnv } from './launcher-env.js'
import type { ServesAs } from '../providers/one-service-mode.js'

let beat: LauncherBeat | null = null

const ADOPTION_BUSY_SECONDS = 600
/** The ready mark's `serves=` line: this is the Walnut server, not the session daemon (daemon-boot-proof.ts reads it). */
const SERVES_WALNUT: ServesAs = 'walnut-serve'

const REQUEST_TIMEOUT_MS = 10_000

/** The server's readiness, asked again by the beat until it holds: null when it serves, else why not. */
export async function serveReadyCheck(deps: {
  port: number
  /** The request that must answer (default GET /api/config). */
  path?: string
  fetch?: typeof globalThis.fetch
  inProcess: { wanted(): Promise<boolean>; check(): Promise<string | null> }
}): Promise<string | null> {
  const fetchFn = deps.fetch ?? globalThis.fetch
  if (await deps.inProcess.wanted()) {
    const why = await deps.inProcess.check()
    if (why) return `sessions: ${why}`
  }
  const route = deps.path ?? '/api/config'
  const res = await fetchFn(`http://127.0.0.1:${deps.port}${route}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (res.status !== 200) return `GET ${route} answered ${res.status}`
  const body = await res.json().catch(() => null) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) return `GET ${route} answered no JSON object`
  return null
}

/** Starts the beat when a launcher runs this server; a no-op otherwise. Call once the port listens. */
export function startServeLauncherBeat(port: number): void {
  if (beat) return
  const { dir, servicePid } = takeLauncherEnv()
  beat = startLauncherBeat({ dir, ...(servicePid ? { pid: servicePid } : {}), warn: (message) => log.web.warn(message) })
  if (!beat) return
  beat.busy(ADOPTION_BUSY_SECONDS)
  const own = beat
  void (async () => {
    const [inProcess, { isHostReplica }] = await Promise.all([import('../providers/in-process-daemon.js'), import('../core/server-role.js')])
    await own.ready({ exe: process.execPath, serves: SERVES_WALNUT }, () => serveReadyCheck({
      port,
      ...(isHostReplica() ? { path: '/api/v1/instance' } : {}),
      inProcess: { wanted: inProcess.inProcessDaemonWanted, check: inProcess.inProcessDaemonServesCheck },
    }))
    own.idle()
    log.web.info('launcher: ready mark written', { port, ...(servicePid ? { servicePid } : {}) })
    if (!isHostReplica() && dir) {
      const [{ readLauncherFacts }, { noteLauncherRollback }] = await Promise.all([
        import('../providers/service-launcher-beat.js'), import('../core/hosts/host-launcher.js'),
      ])
      await noteLauncherRollback('__local__', await readLauncherFacts(dir))
    }
  })().catch((err: unknown) => log.web.warn('launcher: ready check stopped', { error: err instanceof Error ? err.message : String(err) }))
}

/**
 * The launcher's facts this server read (its state, its last put-back), or null: what the daemon
 * runtime inside a host's one Walnut service says in hello (in-process-daemon.ts), since this
 * server, not the runtime, is the one writer of the launcher's marks.
 */
export function serveLauncherFacts(): ReturnType<LauncherBeat['facts']> {
  return beat?.facts() ?? null
}

/** Just before a planned stop: the launcher counts the exit as no crash. */
export function serveLauncherLeaving(reason: string): void {
  const own = beat
  beat = null
  if (!own) return
  try { own.leaving(reason) } catch { /* never the stop's problem */ }
  try { own.stop() } catch { /* the same */ }
}
