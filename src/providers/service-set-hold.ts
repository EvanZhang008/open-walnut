/**
 * The hold a service set move puts on one host link (service-set-move.ts): while it is on, no work
 * of this Walnut reaches the daemon the link reaches now (another Walnut's shared daemon), and no
 * setting that would start work there (this Walnut's follower, its triggers, its plugin jobs) is
 * pushed there again. One gate, by the kind of the command, in DaemonConnection.send: every caller
 * goes through it, so no caller is missed (review round 1, B3: the hold covered only `start` and
 * `send`, and an ACP start, a one-shot or a host_exec run went on to the shared daemon).
 *
 *   refuse  `send`: refused in the words of a link that is down, so the runner keeps the rows
 *           pending under its host-away words and sends them on the release (its contract).
 *   wait    a `start` (a session started during the hold has no runner row to keep it: refused, it
 *           ended in error and never ran; drill round 3, R3-1), and every other command that starts
 *           or feeds work (ACP, one-shot, host_exec, a raw write)
 *           and the per-Walnut pushes that start work there (server.configure, triggers.configure,
 *           jobs.configure): it waits for the release and then goes to whatever the link reaches,
 *           the set's service after a move, the shared daemon after a put-back. The move's own
 *           commands pass (pastSetHold).
 *
 * It also counts the work commands under way, so the move waits for the ones that passed the gate
 * just before the hold (drained) before it judges the sessions quiet.
 */
import { resolveAgentCommand } from './agent-command-map.js'

/** Marks a command the move itself sends during its hold. A symbol: JSON never carries it. */
export const PAST_SET_HOLD: unique symbol = Symbol('past-service-set-hold')

export function pastSetHold(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, [PAST_SET_HOLD]: true }
}

const REFUSED = new Set(['send'])
/** Commands that start or feed work in a session, an ACP worker, a one-shot or a host command. */
const WORK = new Set([
  'start', 'sendRaw', 'bridgeResume', 'setMode', 'appendUserMarker', 'turns.restore',
  'acpStart', 'acpNewSession', 'acpSend', 'acpSteer', 'acpRespond', 'acpSetConfigOption',
  'oneshot.run', 'oneshot.prewarm', 'exec.run', 'exec.script',
])
/** This Walnut's pushes that start work on the daemon by themselves (its follower, triggers, plugin jobs). */
const STARTS_WORK_THERE = new Set(['server.configure', 'triggers.configure', 'jobs.configure'])

/** Longest a held command waits: past every bound of one move (the stops, the flip, two reconnects). */
export const SET_HOLD_MAX_WAIT_MS = 15 * 60_000

export type SetHoldKind = 'refuse' | 'wait' | null

/** What the hold does with `cmd` (an `agent.<op>` frame by the command it runs). */
export function setHoldKind(cmd: string, params: Record<string, unknown>): SetHoldKind {
  const canonical = cmd.startsWith('agent.') ? (() => {
    const route = resolveAgentCommand(params.engine, cmd.slice('agent.'.length))
    return route.ok ? route.cmd : cmd
  })() : cmd
  if (REFUSED.has(canonical)) return 'refuse'
  if (WORK.has(canonical) || STARTS_WORK_THERE.has(canonical)) return 'wait'
  return null
}

const isWork = (cmd: string, params: Record<string, unknown>): boolean => {
  const kind = setHoldKind(cmd, params)
  return kind === 'refuse' || (kind === 'wait' && !STARTS_WORK_THERE.has(cmd))
}

export class SetHold {
  private released: { promise: Promise<void>; resolve: () => void } | null = null
  private underWay = 0
  private idle: Array<() => void> = []

  get on(): boolean { return this.released !== null }

  set(on: boolean): void {
    if (on && !this.released) {
      let resolve!: () => void
      const promise = new Promise<void>((r) => { resolve = r })
      this.released = { promise, resolve }
    } else if (!on && this.released) {
      const r = this.released
      this.released = null
      r.resolve()
    }
  }

  /** Work commands sent and not answered yet. */
  get inFlight(): number { return this.underWay }

  /**
   * Let `cmd` go, hold it, or refuse it; the answer is called when its reply came (it counts the
   * work under way). `refused` builds the error a held start or send throws.
   */
  async admit(cmd: string, params: Record<string, unknown>, refused: () => Error, maxWaitMs = SET_HOLD_MAX_WAIT_MS): Promise<() => void> {
    if (this.released && !(params as { [PAST_SET_HOLD]?: unknown })[PAST_SET_HOLD]) {
      const kind = setHoldKind(cmd, params)
      if (kind === 'refuse') throw refused()
      if (kind === 'wait') {
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), maxWaitMs); timer.unref?.() })
        try {
          while (this.released) {
            if (await Promise.race([this.released.promise.then(() => 'ok' as const), late]) === 'late') throw refused()
          }
        } finally { clearTimeout(timer) }
      }
    }
    return this.track(cmd, params)
  }

  /** Count a work command that goes now (no hold, or past it); the answer is called when its reply came. Sync. */
  track(cmd: string, params: Record<string, unknown>): () => void {
    if (!isWork(cmd, params)) return () => {}
    this.underWay++
    let done = false
    return () => {
      if (done) return
      done = true
      this.underWay--
      if (this.underWay === 0) for (const w of this.idle.splice(0)) w()
    }
  }

  /** True once no work command is under way, false at `boundMs`. */
  async drained(boundMs: number): Promise<boolean> {
    if (this.underWay === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<boolean>((r) => this.idle.push(() => r(true)))
    const late = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), boundMs); timer.unref?.() })
    try { return await Promise.race([idle, late]) } finally { clearTimeout(timer) }
  }
}
