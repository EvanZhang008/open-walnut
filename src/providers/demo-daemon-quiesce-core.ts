// Demo reset fence: close a Demo's own daemon for good and wait for work it accepted, so the reset's list sees all it started; self-contained (daemon-source.ts inlines it).

export interface DemoQuiesceChildren {
  runs: number
  pool: number
  /** Every spawned child not yet exited (warm or run). */
  children: number
}

export interface DemoQuiesceDeps {
  env: Record<string, string | undefined>
  daemonDir: string
  isProdDaemonDir: boolean
  serviceMode: boolean
  keepSessions: boolean
  resolve: (...parts: string[]) => string
  basename: (p: string) => string
  settle: () => Promise<void>
  /** stdin end only, no signal. */
  endWarmPool: () => void
  oneShot: () => DemoQuiesceChildren
  acpRuntimes: () => Array<{ sid: string; state: string; pid: number | null; stopping: boolean }>
  /** Sync, at the fence and again after settle: the daemon's own timers would start work past it. */
  stopInternalWork?: (home: string) => void
  /** That work not gone yet, by kind; the Demo is quiet only when every count is 0. */
  background?: (home: string) => Record<string, number>
  deadlineMs?: number
  pollMs?: number
  now?: () => number
}

export type DemoQuiesceReply =
  | { ok: true; quiet: true; acpRuntimes: Array<{ sid: string; state: string; pid: number | null; stopping: boolean }> }
  | { ok: false; error: string; errorKind: 'demo_quiesce_refused' | 'demo_not_quiet'; oneShot?: DemoQuiesceChildren; background?: Record<string, number> }

export function createDemoDaemonQuiesce(deps: DemoQuiesceDeps) {
  var DEADLINE_MS = deps.deadlineMs || 20000
  var POLL_MS = deps.pollMs || 100
  var now = deps.now || function () { return Date.now() }
  var fenced = false
  // While fenced: reads and stops only; any other name, new ones included, is refused.
  // Own keys only: no prototype name (constructor, __proto__, toString) ever reads as listed.
  var ALLOWED: Record<string, true> = Object.create(null)
  var ALLOWED_NAMES = [
    'demo.quiesce', 'gateway-result', 'ping', 'hello',
    'list', 'acpState', 'agent.state', 'exec.list', 'exec.read',
    'stop', 'acpStop', 'agent.stop', 'exec.kill', 'oneshot.cancel',
  ]
  for (var i = 0; i < ALLOWED_NAMES.length; i++) ALLOWED[ALLOWED_NAMES[i]] = true

  function refused(error: string): DemoQuiesceReply {
    return { ok: false, error: error, errorKind: 'demo_quiesce_refused' }
  }

  /** This Demo generation's data dir, or null on any daemon that is not one Demo's own. */
  function demoData(): string | null {
    var env = deps.env
    var root = typeof env.WALNUT_DEMO_ROOT === 'string' ? env.WALNUT_DEMO_ROOT : ''
    var generation = typeof env.WALNUT_DEMO_GENERATION === 'string' ? env.WALNUT_DEMO_GENERATION : ''
    if (!root || deps.resolve(root) !== root || deps.basename(root) !== 'open-walnut-demo') return null
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(generation)) return null
    if (env.HOME !== deps.resolve(root, 'homes', generation)) return null
    if (deps.resolve(deps.daemonDir) !== deps.resolve(root, 'd', generation)) return null
    if (deps.isProdDaemonDir || deps.serviceMode || deps.keepSessions) return null
    return deps.resolve(root, 'data', generation)
  }

  function within(work: Promise<void>, deadline: number): Promise<boolean> {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(false) }, Math.max(0, deadline - now()))
      work.then(function () { clearTimeout(timer); resolve(true) }, function () { clearTimeout(timer); resolve(false) })
    })
  }

  function notQuiet(error: string, extra?: { oneShot?: DemoQuiesceChildren; background?: Record<string, number> }): DemoQuiesceReply {
    var reply: { ok: false; error: string; errorKind: 'demo_not_quiet'; oneShot?: DemoQuiesceChildren; background?: Record<string, number> } = { ok: false, error: error, errorKind: 'demo_not_quiet' }
    if (extra && extra.oneShot) reply.oneShot = extra.oneShot
    if (extra && extra.background) reply.background = extra.background
    return reply
  }

  /** Stop the daemon's own automatic work; a throw keeps the Demo data (not quiet). */
  function stopInternal(home: string): string | null {
    if (!deps.stopInternalWork) return null
    try { deps.stopInternalWork(home); return null } catch (err) { return err instanceof Error ? err.message : String(err) }
  }

  /** Background work still going, or null when every count is 0. */
  function backgroundLeft(home: string): Record<string, number> | null {
    if (!deps.background) return null
    var counts = deps.background(home)
    var keys = Object.keys(counts)
    for (var k = 0; k < keys.length; k++) if (counts[keys[k]] !== 0) return counts
    return null
  }

  function wait(ms: number): Promise<void> {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  /** `origin`: a socket role (bridge, follower, lane, probe); the server's own socket has none. */
  async function quiesce(origin: unknown, params: Record<string, unknown>): Promise<DemoQuiesceReply> {
    if (origin) return refused('demo.quiesce: only the Demo server\'s own socket may send it')
    var data = demoData()
    if (data === null) return refused('demo.quiesce: this daemon is not a Demo\'s own isolated daemon')
    if (typeof params.home !== 'string' || params.home !== data) return refused('demo.quiesce: home is not this Demo generation\'s data dir')
    // Closed before the first await, never reopened; the daemon's own timers stop in the same tick.
    fenced = true
    var stopError = stopInternal(data)
    if (stopError !== null) return notQuiet('Demo daemon could not stop its own background work (' + stopError + '); keep the Demo data and retry')
    var deadline = now() + DEADLINE_MS
    if (!await within(deps.settle(), deadline)) {
      return notQuiet('Demo daemon is still finishing work it accepted before the stop; keep the Demo data and retry')
    }
    // Work the drain accepted before the fence may have armed more.
    stopError = stopInternal(data)
    if (stopError !== null) return notQuiet('Demo daemon could not stop its own background work (' + stopError + '); keep the Demo data and retry')
    deps.endWarmPool()
    for (;;) {
      var shots = deps.oneShot()
      var left = backgroundLeft(data)
      var shotsQuiet = shots.runs === 0 && shots.pool === 0 && shots.children === 0
      if (shotsQuiet && left === null) break
      if (now() >= deadline) {
        if (!shotsQuiet) return notQuiet('Demo one-shot runs have not exited yet; keep the Demo data and retry', left === null ? { oneShot: shots } : { oneShot: shots, background: left })
        return notQuiet('Demo background work (trigger checks, plugin jobs) has not ended yet; keep the Demo data and retry', left === null ? undefined : { background: left })
      }
      await wait(POLL_MS)
    }
    return { ok: true, quiet: true, acpRuntimes: deps.acpRuntimes() }
  }

  return {
    get fenced() { return fenced },
    /** This daemon is one Demo's own isolated daemon (read each time; no side effect). */
    get isDemo() { return demoData() !== null },
    allows: function (cmd: unknown): boolean {
      return !fenced || (typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED, cmd) && ALLOWED[cmd] === true)
    },
    quiesce: quiesce,
  }
}
