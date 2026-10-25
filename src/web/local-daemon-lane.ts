/**
 * The primary's one standing link to its own session daemon (pool key '__local__').
 *
 * The cloud companion hears this Mac only through that link: DaemonConnection's
 * connected edge pushes `bridge.configure` (with the hooks, the triggers, the host
 * slice and the leader set-up), and the daemon dials the companion from what it was
 * told. Nothing else dials '__local__' without a session, a route call or a user
 * action, so a Mac with no session was never heard (2026-10-24: in the test fleet's
 * companion upgrade runs, every Mac daemon had no client for the whole run).
 *
 * One owner, one trigger: every ensureRunning() that ends with a daemon serving (the
 * boot's own, a later start after a failed boot, an upgrade, a restart the reconnect
 * loop asked for) fires localDaemon.onReady, and the lane then makes sure an attempt
 * runs and watches it, one at a time. When the pool is cold it starts the pool's dial
 * (or, for a link that was up and dropped, runs the reconnect loop's waiting attempt now,
 * as any caller's call does); when an attempt already runs (another caller's dial, the reconnect loop's attempt) it
 * joins that one through the same call, which hands back the running attempt's promise
 * (getDaemonConnection), so the lane never starts a second connect() and never ends a
 * connection. A watched attempt that fails, the lane's or another caller's (which no
 * later ready edge may follow), is tried again after 2 min, then 5, then every 15,
 * never before the pool's failure cache lets a dial through; a success resets that.
 * An attempt that ends because a newer one took the key (a pool reset) hands the watch
 * to the newer one on a short timer, not a failure. Once connected, the pooled
 * connection's own reconnect loop keeps it. The heartbeat and every fan-out stay
 * non-dialing, and the boot never waits on the lane.
 */

const LOCAL = '__local__'
/** Waits after a failed attempt: 2 min, 5 min, then every 15 min. */
const RETRY_STEPS_MS = [120_000, 300_000, 900_000]
/** A newer attempt took the key: watch it after this, on a timer so a settle can never loop. */
const HANDOFF_MS = 1_000

export interface LocalDaemonLaneDeps {
  /** localDaemon.onReady: called after every ensureRunning() that ends with a daemon serving. */
  onReady(cb: () => void): () => void
  /** daemonConnectWouldWait('__local__'). */
  wouldWait(): 'connected' | 'fails-fast' | 'dialing' | 'cold'
  /** getDaemonConnection('__local__', …): starts the pooled dial when cold, joins the running attempt when dialing. */
  dial(): Promise<unknown>
  /** How long a cached failure still holds (getDaemonConnectState's retryInMs), 0 when none. */
  retryInMs(): number
  log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void }
  setTimer?(fn: () => void, ms: number): { clear(): void }
}

/**
 * Whether this server keeps the lane: the primary (role leader, which runs on the Mac
 * only) and never an ephemeral test server, whose boundary this change leaves as it was.
 * Pairing is not an input: what pairing changes is what the connected edge pushes.
 */
export function wantsLocalDaemonLane(facts: { role: 'leader' | 'replica'; ephemeral: boolean }): boolean {
  return facts.role === 'leader' && !facts.ephemeral
}

export function startLocalDaemonLane(deps: LocalDaemonLaneDeps): { stop(): void } {
  let stopped = false
  let failures = 0
  let watching = false
  let retry: { clear(): void } | null = null
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return { clear: () => clearTimeout(t) }
  })
  const step = () => RETRY_STEPS_MS[Math.min(Math.max(failures, 1), RETRY_STEPS_MS.length) - 1]

  const schedule = (ms: number) => {
    if (stopped || retry) return
    retry = setTimer(() => { retry = null; consider('retry') }, ms)
  }

  const consider = (why: string) => {
    if (stopped || watching) return
    const state = deps.wouldWait()
    if (state === 'connected') { failures = 0; return }
    if (state === 'fails-fast') {
      // A cached failure says when a dial is let through; a standing cause the
      // reconnect loop waits out says nothing (0), so wait the lane's own step.
      const cached = deps.retryInMs()
      schedule(cached > 0 ? cached : step())
      return
    }
    // 'cold' starts the pool's one dial; 'dialing' joins the attempt already running.
    watching = true
    retry?.clear()
    retry = null
    deps.dial().then(
      () => {
        watching = false
        if (stopped) return
        failures = 0
        deps.log.info('local daemon lane: connected', { why, joined: state === 'dialing' })
      },
      (err: unknown) => {
        watching = false
        if (stopped) return
        const now = deps.wouldWait()
        if (now === 'connected') { failures = 0; return }
        if (now === 'dialing') { schedule(HANDOFF_MS); return }
        failures += 1
        deps.log.warn('local daemon lane: attempt failed', {
          why, joined: state === 'dialing', failures, error: err instanceof Error ? err.message : String(err),
        })
        schedule(Math.max(deps.retryInMs(), step()))
      },
    )
  }

  const off = deps.onReady(() => consider('daemon-ready'))
  return {
    stop() {
      stopped = true
      off()
      retry?.clear()
      retry = null
    },
  }
}

/** The parts of the daemon pool the lane reads (src/providers/daemon-connection.ts). */
export interface LanePool {
  daemonConnectWouldWait(hostKey: string): 'connected' | 'fails-fast' | 'dialing' | 'cold'
  getDaemonConnection(hostKey: string, target: { hostname: string }): Promise<unknown>
  getDaemonConnectState(hostKey: string): { retryInMs?: number }
}

/** One boot's lane step (src/web/server.ts startServer). */
export interface PrimaryLaneBoot {
  daemon: { onReady(cb: () => void): () => void }
  /** wantsLocalDaemonLane for this server. */
  wanted: boolean
  /** This boot still owns the lane: no stopServer and no newer boot since it began. */
  live(): boolean
  /** Puts this boot's lane in server.ts's slot (emptied at the boot's entry); called only while live, in the tick of the check. */
  install(lane: { stop(): void }): void
  /** A lane that could not be built (an import failed): the boot goes on without it. */
  warn(msg: string, meta?: Record<string, unknown>): void
  /** The two imports (a test passes its own). */
  load?(): Promise<{ pool: LanePool; log: LocalDaemonLaneDeps['log'] }>
}

async function loadPrimaryLaneDeps(): Promise<{ pool: LanePool; log: LocalDaemonLaneDeps['log'] }> {
  const [dc, { log }] = await Promise.all([import('../providers/daemon-connection.js'), import('../logging/index.js')])
  return { pool: dc, log: { info: (msg, meta) => log.session.info(msg, meta), warn: (msg, meta) => log.session.warn(msg, meta) } }
}

/**
 * The lane wired to the real local daemon and the daemon pool, fenced by the boot that
 * builds it: 'not-wanted' (not the primary; nothing built, the boot goes on as before),
 * 'installed', 'unavailable' (an import failed; the boot goes on without a lane), or
 * 'overtaken' (a stopServer or a newer boot came during an await: nothing is built and
 * nothing is written, so no listener, timer or dial is left behind, and server.ts starts
 * no daemon for this boot). The check, the ready listener and the slot write run in one
 * tick after the last await, so a stop can never fall between them.
 */
export async function bootPrimaryLocalDaemonLane(b: PrimaryLaneBoot): Promise<'not-wanted' | 'installed' | 'unavailable' | 'overtaken'> {
  if (!b.wanted) return 'not-wanted'
  if (!b.live()) return 'overtaken'
  let loaded: { pool: LanePool; log: LocalDaemonLaneDeps['log'] } | null = null
  let failure: unknown = null
  try {
    loaded = await (b.load ?? loadPrimaryLaneDeps)()
  } catch (err) {
    failure = err
  }
  if (!b.live()) return 'overtaken'
  if (!loaded) {
    b.warn('local daemon lane: not started', { error: failure instanceof Error ? failure.message : String(failure) })
    return 'unavailable'
  }
  const { pool, log } = loaded
  b.install(startLocalDaemonLane({
    onReady: (cb) => b.daemon.onReady(cb),
    wouldWait: () => pool.daemonConnectWouldWait(LOCAL),
    dial: () => pool.getDaemonConnection(LOCAL, { hostname: LOCAL }),
    retryInMs: () => pool.getDaemonConnectState(LOCAL).retryInMs ?? 0,
    log,
  }))
  return 'installed'
}
