/**
 * An update of an SSH host's daemon someone asked for now (host_daemon_update), answered in
 * the host network updater's shape (NetUpdateState), so one op covers both paths that replace a
 * remote daemon from here (daemon-update-paths.ts).
 *
 * The run is the SSH path's own decision (DaemonConnection.recheckPostponedUpgrade with the
 * asked build): past the soft holds the host network request skips too (the update gap, a
 * shared daemon kept, the busy clock, the cooldown after a try, a build's day off), never past
 * the safety holds (writes in flight, host_exec runs, open ACP turns, the previous update still
 * running there, its probation, another host name of the daemon updating it, the asker's grant).
 * The answer comes once it is decided, or after `waitMs` while it still runs (an upload takes
 * minutes); asking again while it runs tells where it is.
 */
import type { NetUpdatePhase, NetUpdateSkip, NetUpdateState } from './daemon-net-update.js'
import type { DaemonUpdateWait } from './daemon-update-wait.js'

export interface RequestedUpdateDeps {
  host: string
  connected(): boolean
  /** The build the host's daemon runs (its hello). */
  running(): string | null
  /** The build this server would put there; null when it names none. */
  expected(): string | null
  /** Decide the update of `expected` now, past the soft holds; true: it went ahead (the link reconnects on the new build). */
  run(expected: string, gate?: () => void): Promise<boolean>
  /** What the update waits for after the decision (its postpone), if anything. */
  wait(): DaemonUpdateWait | null
  /** When a decision on this link last replaced the daemon (ms epoch, 0 never): the one sign that a swap happened. */
  replacedAt(): number
  now?: () => number
}

export class RequestedUpdate {
  private inFlight: Promise<NetUpdateState> | null = null
  state: NetUpdateState

  constructor(private readonly d: RequestedUpdateDeps) {
    this.state = { phase: 'idle', host: d.host, running: null, expected: null, message: '', at: 0 }
  }

  async request(waitMs = 8_000, gate?: () => void): Promise<NetUpdateState> {
    if (this.inFlight) { await within(this.inFlight, waitMs); return this.state }
    const expected = this.d.expected()
    if (!expected) return this.set('skipped', 'this server runs from source and names no daemon build', { skip: 'no-build-version' })
    if (!this.d.connected()) return this.set('skipped', 'the host is not connected')
    // Refused before anything runs: the route answers the refusal itself.
    gate?.()
    this.set('checking', 'checking the host\'s daemon')
    const startedAt = (this.d.now ?? Date.now)()
    const run = this.d.run(expected, gate)
      .then((went) => this.settle(went, expected, startedAt), (err) => this.set('failed', err instanceof Error ? err.message : String(err)))
      .finally(() => { this.inFlight = null })
    this.inFlight = run
    await within(run, waitMs)
    return this.state
  }

  private settle(went: boolean, expected: string, startedAt: number): NetUpdateState {
    const swapping = `the old daemon was replaced by ${expected}; the host reconnects on the new build`
    if (went) return this.set('running', swapping)
    if (this.d.running() === expected) return this.set('updated', `its daemon is this build (${expected})`)
    // Another decision on this link replaced it while this one waited for it; a link that only dropped is no swap.
    if (this.d.replacedAt() >= startedAt) return this.set('running', swapping)
    const wait = this.d.wait()
    if (wait && wait.expected === expected) {
      const skip: NetUpdateSkip | undefined = wait.kind === 'postponed' ? undefined : wait.kind
      return skip
        ? this.set('skipped', wait.why, { skip })
        : this.set('postponed', `waiting: ${wait.why}`, wait.until ? { until: wait.until } : {})
    }
    return this.set('skipped', 'nothing was changed on the host')
  }

  private set(phase: NetUpdatePhase, message: string, extra: Partial<NetUpdateState> = {}): NetUpdateState {
    this.state = { phase, host: this.d.host, running: this.d.running(), expected: this.d.expected(), message, at: (this.d.now ?? Date.now)(), ...extra }
    return this.state
  }
}

async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p.then(() => {}, () => {}), new Promise<void>((r) => { timer = setTimeout(r, ms) })])
  clearTimeout(timer)
}
