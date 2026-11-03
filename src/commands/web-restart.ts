/**
 * How `walnut web` restarts into an update it installed while it served
 * (src/core/self-update/live-update.ts calls the handler registered here).
 *
 * Only a supervised server restarts: a looping parent started it
 * (restart-supervisor.ts: the parent a startup update leaves behind, or a
 * `walnut web` whose install can live-update, which supervises from the start).
 * It runs the same teardown a SIGTERM runs, then exits 75; the parent starts the
 * new version and watches it. Any other server registers no handler: an
 * installed version waits for its next start, and Restart answers no_restart.
 *
 * The local session daemon is never stopped: sessions survive, as on every deploy.
 */

import fs from 'node:fs'

/** config.yaml `updates.auto` (the startup update and the restart loop read it). */
export async function readConfigAuto(): Promise<boolean | undefined> {
  const { getConfig } = await import('../core/config-manager.js')
  return (await getConfig()).updates?.auto
}

/**
 * Run as the supervisor (web.ts): `firstCode`, a child's exit 75 after a startup
 * update; without it, start the first child here. Resolves to this process's exit code.
 */
export async function runSupervisor(baseEnv: Record<string, string | undefined>, o: { firstCode?: number; readyAlso?: string } = {}): Promise<number> {
  const { superviseWalnut } = await import('../core/self-update/restart-supervisor.js')
  return superviseWalnut(readConfigAuto, { baseEnv, ...o })
}

export interface LiveRestartOptions {
  supervised: boolean
  /** The signal shutdown's bail (web.ts SHUTDOWN_BAIL_MS): the restart's teardown gets the same. */
  bailMs: number
  stopServer: (opts?: { dropConnections?: boolean }) => Promise<void>
  exitTraceFile: () => string
  /** Claims the process's one teardown (web.ts shuttingDown); false when a shutdown already runs. */
  beginTeardown: () => boolean
}

/** stopServer() within the shutdown's bail; false when it did not end in time. */
async function teardown(stopServer: LiveRestartOptions['stopServer'], bailMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bail = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), bailMs) })
  try {
    // An open window's keep-alive socket would hold the close past the bail: they go now.
    return await Promise.race([stopServer({ dropConnections: true }).then(() => true as const, () => true as const), bail])
  } finally {
    clearTimeout(timer)
  }
}

export async function registerLiveRestart(o: LiveRestartOptions): Promise<void> {
  if (!o.supervised) return
  const { setRestartHandler } = await import('../core/self-update/live-update.js')
  const { RESTART_EXIT_CODE, recordSignals } = await import('../core/self-update/restart-supervisor.js')
  const trace = (line: string) => {
    try { fs.appendFileSync(o.exitTraceFile(), `[${new Date().toISOString()}] SERVER EXIT: ${line} pid=${process.pid}\n`) } catch { /* best-effort */ }
  }
  setRestartHandler(async () => {
    if (!o.beginTeardown()) return
    // A signal during the teardown means stop, not restart.
    const signals = recordSignals()
    const done = await teardown(o.stopServer, o.bailMs)
    const code = signals.received() ? 0 : RESTART_EXIT_CODE
    trace(code === RESTART_EXIT_CODE ? `restarting into an update (exit ${code}${done ? '' : `, teardown bail after ${o.bailMs}ms`})` : 'stopped during a restart')
    process.exit(code)
  })
}
