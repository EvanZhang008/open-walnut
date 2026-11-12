/**
 * A request to a daemon that is shutting down for a swap waits for the next daemon and is sent
 * again, so a person never sees the swap (2026-11-10: a 6.6 MB attachment failed at 0% with
 * "internal daemon error handling upload.part: Daemon is shutting down; retry after
 * reconnecting" and a Retry button, in the second the Mac's daemon was being replaced, and
 * triggers.configure, host.slice, fs.read and replica.sync were refused in the same second).
 *
 * Two cases, told apart by what the daemon could have done:
 *  - Refused (`isDaemonDrainRefusal`): the daemon's command drain refuses before it runs a byte of
 *    the command (daemon-command-drain.ts `admit`), so sending it again is safe for every command
 *    but the few that are about the old daemon itself (DRAIN_RESEND_EXEMPT).
 *  - Lost (the link closed while the reply was on its way, during a swap): the command may have
 *    run, so only one that is the same done twice is sent again (RESEND_AFTER_LOST). A command
 *    that changes a session is drained before the old daemon stops, so its reply is not lost.
 *
 * Both stay inside the caller's own timeout (capped at DRAIN_RESEND_MAX_MS), counted from the first
 * try, then answer what the last try got: a caller that gives up at 20 s still hears at 20 s.
 * DaemonConnection.send and the cloud bridge's bridgeRequest use it; the guard
 * (tests/providers/daemon-drain-resend-guard.test.ts) lists every command the daemon handles.
 */

/** The most a request waits for the next daemon, whatever its own timeout. An overdue swap restarts the old daemon within about a minute. */
export const DRAIN_RESEND_MAX_MS = 3 * 60_000

/** A request with no link re-checks the swap this often, so a swap that ended (or failed) ends its wait. */
export const DRAIN_WAIT_SLICE_MS = 5_000

/** The least time between two tries: a link that reads up while its socket is still closing never spins the loop. */
const MIN_GAP_MS = 50

/** How often a refused request is tried again on the same link while the daemon there still drains. */
export const DRAIN_RETRY_EVERY_MS = 1_000

/** After the last refusal a swap counts as under way this long: a draining daemon closes its socket within its 45 s shutdown cap. */
export const DRAIN_SWAP_WINDOW_MS = 60_000

// The drain's own words (daemon-command-drain.ts), case and all: the gateway's lowercase line is another path's.
const DRAIN_WORDS = /Daemon is shutting down; retry after reconnecting/

/** The daemon refused the command because it is shutting down (it ran nothing of it). */
export function isDaemonDrainRefusal(reply: unknown): boolean {
  if (!reply || typeof reply !== 'object') return false
  const r = reply as { ok?: unknown; error?: unknown; errorKind?: unknown }
  if (r.ok === true) return false
  return r.errorKind === 'daemon_draining' || (typeof r.error === 'string' && DRAIN_WORDS.test(r.error))
}

/** Commands answered as they are when the daemon drains, each with why. */
export const DRAIN_RESEND_EXEMPT: Readonly<Record<string, string>> = {
  ping: 'a liveness probe: the answer of the daemon there now is the point, and the next one asks the next daemon',
  hello: 'the handshake of this link; a new link says hello to the new daemon itself',
  'follower.hello': 'the handshake of a follower link; the new link makes its own',
  'service.handover': 'the swap itself asks the old daemon to hand over; its refusal is the answer the swap acts on',
  'service.update': 'the swap itself asks the old daemon; its refusal is the answer the swap acts on',
}

/**
 * Commands the same done twice (a read, a whole setting pushed again), sent again when the link
 * closed under them during a swap. Each with why. Not the upload parts: an old daemon may still be
 * appending a part whose reply was lost (they are not drained), and a second writer would interleave
 * with it; the browser asks for a lost part again itself, and that try waits for the next daemon.
 */
export const RESEND_AFTER_LOST: Readonly<Record<string, string>> = {
  'fs.ls': 'read', 'fs.stat': 'read', 'fs.read': 'read', 'fs.readRange': 'read', 'fs.readBounded': 'read',
  'fs.readImage': 'read', 'fs.find': 'read', 'fs.grep': 'read', 'fs.resolvePath': 'read',
  'git.status': 'read', 'git.diff': 'read', 'git.refs': 'read', 'git.fileShow': 'read', 'git.fileLog': 'read',
  'changes.compute': 'read', 'changes.file': 'read', getState: 'read', status: 'read', list: 'read',
  'host.slice': 'read', 'host.vitals': 'read', 'host.facts': 'read', 'host.load': 'read',
  'exec.list': 'read', 'exec.read': 'read', 'jobs.status': 'read', 'net.status': 'read', 'server.status': 'read',
  'replica.status': 'read', 'triggers.state.snapshot': 'read', 'taskdir.list': 'read', 'taskdir.sizes': 'read', 'cli.holder': 'read',
  'usage.scan': 'read', 'usage.sessionCost': 'read', 'usage.costState': 'read', 'usage.budget.get': 'read',
  'usage.budget.list': 'read', 'usage.codexOutside': 'read', 'net.identity': 'read', 'jobs.logs': 'read', 'host.preflight': 'read',
  'triggers.configure': 'the whole rule set, pushed again', 'hooks.configure': 'the whole rule set, pushed again',
  'leader.configure': 'the whole setting, pushed again', 'net.configure': 'the whole setting, pushed again',
  'turns.configure': 'the whole setting, pushed again', 'workspace.configure': 'the whole setting, pushed again',
  'jobs.configure': 'the whole job list, pushed again', 'bridge.configure': 'the whole setting, pushed again',
  'server.configure': 'the whole setting, pushed again', 'usage.budget.configure': 'the whole budget, pushed again',
}

/** Whether `cmd` is sent again after `failure` (refused by a draining daemon, or its reply lost in a swap). */
export function resendsAfter(cmd: string, failure: 'refused' | 'lost'): boolean {
  if (Object.hasOwn(DRAIN_RESEND_EXEMPT, cmd)) return false
  return failure === 'refused' || Object.hasOwn(RESEND_AFTER_LOST, cmd)
}

/** One link to one host's daemon, as the resend loop needs it. */
export interface SwapLink<R> {
  /** Send the command once on the link as it is now, waiting at most `timeoutMs` for its answer. */
  once(timeoutMs: number): Promise<R>
  /** What a thrown failure says of the link: none (`no-link`), closed under the command (`lost`), or anything else (null). */
  failure(err: unknown): 'no-link' | 'lost' | null
  /** A swap of this host's daemon is under way: a refusal seen in the window, or a swap this server started. */
  swapUnderway(): boolean
  /** A drain refusal came back. */
  noteRefusal(): void
  /** Resolves once a link of this host is up (`fresh`: comes up anew), or after `ms`. */
  waitLink(ms: number, fresh?: boolean): Promise<void>
  /** The request starts to wait out a swap (once per request), for the log. */
  onWait?(why: 'refused' | 'no-link' | 'lost'): void
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Send `cmd` through a daemon swap: a refusal is sent again on the next daemon (or on this one
 * once it stops draining), and so is a command whose link was gone or closed under it while
 * the swap runs, when `resendsAfter` allows it. All of it inside `timeoutMs` (capped at `maxMs`)
 * from the first try; each later try waits only for what is left of it.
 */
export async function resendThroughSwap<R>(cmd: string, link: SwapLink<R>, timeoutMs: number, maxMs = DRAIN_RESEND_MAX_MS): Promise<R> {
  if (Object.hasOwn(DRAIN_RESEND_EXEMPT, cmd)) return link.once(timeoutMs)
  const deadline = Date.now() + Math.min(maxMs, timeoutMs)
  let told = false
  const wait = async (why: 'refused' | 'no-link' | 'lost', ms: number, fresh: boolean) => {
    if (!told) { told = true; link.onWait?.(why) }
    const at = Date.now()
    await link.waitLink(ms, fresh)
    const spent = Date.now() - at
    if (spent < MIN_GAP_MS) await pause(MIN_GAP_MS - spent)
  }
  for (let attempt = 0; ; attempt++) {
    const budget = attempt === 0 ? timeoutMs : Math.max(1, deadline - Date.now())
    let result: R
    try {
      result = await link.once(budget)
    } catch (err) {
      const left = deadline - Date.now()
      const kind = link.failure(err)
      const again = left > MIN_GAP_MS && link.swapUnderway()
        && (kind === 'no-link' || (kind === 'lost' && resendsAfter(cmd, 'lost')))
      if (!again) throw err
      // In slices: a swap that ended or failed meanwhile ends the wait at the next look.
      await wait(kind === 'lost' ? 'lost' : 'no-link', Math.min(left, DRAIN_WAIT_SLICE_MS), false)
      continue
    }
    const left = deadline - Date.now()
    if (!isDaemonDrainRefusal(result) || left <= MIN_GAP_MS) return result
    link.noteRefusal()
    await wait('refused', Math.min(DRAIN_RETRY_EVERY_MS, left), true)
  }
}

const linkWaiters = new Map<string, Set<() => void>>()
/** Until when each link's announced swap counts. */
const swapsExpected = new Map<string, number>()

/**
 * The daemon behind link `key` is about to be replaced (a restart for its update): a gap in its
 * link within `forMs` is the swap. Ends when a link of `key` comes up, or with `clearDaemonSwap`.
 */
export function expectDaemonSwap(key: string, forMs = DRAIN_SWAP_WINDOW_MS): void { swapsExpected.set(key, Date.now() + forMs) }

/** The announced swap did not happen (refused, or it failed): a gap is no swap again. */
export function clearDaemonSwap(key: string): void { swapsExpected.delete(key) }

/** A swap of `key`'s daemon was announced, is still within its time, and no link came up since. */
export function daemonSwapExpected(key: string): boolean {
  const until = swapsExpected.get(key)
  return until !== undefined && Date.now() < until
}

/** Resolves when `wakeHostLink(key)` runs or after `ms`, whichever is first; at once when `up()` already holds. */
export function waitHostLink(key: string, ms: number, up: () => boolean): Promise<void> {
  if (up()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let waiters = linkWaiters.get(key)
    if (!waiters) { waiters = new Set(); linkWaiters.set(key, waiters) }
    const holder = waiters
    const done = () => {
      clearTimeout(timer)
      holder.delete(done)
      if (holder.size === 0 && linkWaiters.get(key) === holder) linkWaiters.delete(key)
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, ms))
    timer.unref?.()
    holder.add(done)
  })
}

/** A link of `key` came up: every request waiting on it tries again. */
export function wakeHostLink(key: string): void {
  swapsExpected.delete(key)
  const waiters = linkWaiters.get(key)
  if (!waiters) return
  for (const done of [...waiters]) done()
}
