/**
 * A start or a resume a host refused with host_runs_sessions_off while this leader's switch says
 * on for that host (docs/plan/one-service-every-host.md, phase 2). The host reads the switch from
 * its copy of this leader's config (switch.ts: the copy-only row `hosts_run_sessions`, the
 * `experimental` row), which a config write reaches only with the next round of the config copy
 * kind, a few seconds later (2026-11-23: a resume 5 s after `hosts.<name>.runs_sessions` went true
 * was refused so, and went legacy). So the moment a host is switched on, its first start can be
 * refused for a lag, not for a decision.
 *
 * Then, once: the config copy goes to that host now, to it alone (replication/kinds/copy-kind.ts
 * copyKindNow) and the leader waits for the host's answer to it; a host whose session side was not up yet (its
 * routes come up with the copy, host-boot.ts followHostSwitch) is waited for until its channel
 * links. Then the same start is asked once more. The refusal is the host's first step of a start
 * (host-routes.ts), so nothing of the first ask ran there and the second is the only one. Never a
 * third: a host that still says off is off, and the caller goes on as before (a start fails, a
 * resume is delivered here). The whole wait is bounded by CATCH_UP_MS; it waits on the host's
 * answers, never on a clock of its own.
 *
 * Every start and resume a leader hands a host goes through here, so the other copy that can lag it
 * rides here too: the leader's rows of the start's task (start-task-rows.ts), which the host takes
 * before it judges (2026-11-25: an engine switch's archive of the old session had not reached the
 * host, which refused the new one as the task's second session).
 */
import { log } from '../../logging/index.js'
import { HOST_SESSIONS_OFF } from './host-api.js'
import type { HostCallAnswer } from './leader-links.js'
import { withTaskRows, type TaskRowsReader } from './start-task-rows.js'

/** The longest a refused start waits for the host to catch up before its one more ask. */
export const CATCH_UP_MS = 15_000

export interface SwitchCatchUpSide {
  startOnHost(hostKey: string, payload: unknown): Promise<HostCallAnswer>
  /** Is the switch on for `hostKey` on this leader now? */
  switchOn(hostKey: string): boolean
  /** Linked now, or once its channel links within `ms` (leader-side.ts whenLinked). */
  whenLinked(hostKey: string, ms: number): Promise<boolean>
}

export interface SwitchCatchUpOptions {
  /** The config copy to `hostKey` now: true when the host took it within `ms` (tests: a seam). */
  copyConfigNow?(hostKey: string, ms: number): Promise<boolean>
  budgetMs?: number
  now?(): number
  /** The leader's rows of a task (start-task-rows.ts leaderTaskRows), and which hosts take them (tests: seams). */
  taskRows?: TaskRowsReader
  takesTaskRows?(hostKey: string): boolean
}

/** Was this answer the host's "the switch is off here"? */
export function refusedAsOff(a: HostCallAnswer | null | undefined): boolean {
  return !!a && a.ok !== true && a.error === HOST_SESSIONS_OFF
}

/** `p`, or `fallback` once `ms` passed (the timer is a deadline: it is cleared when `p` settles first). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback)
  return new Promise<T>((resolve) => {
    const deadline = setTimeout(() => resolve(fallback), ms)
    deadline.unref?.()
    p.then((v) => { clearTimeout(deadline); resolve(v) }, () => { clearTimeout(deadline); resolve(fallback) })
  })
}

/** The config copy to `hostKey`'s copy target alone, now, and whether it took it. */
async function copyConfigToHostNow(hostKey: string, ms: number): Promise<boolean> {
  const { copyKindNow } = await import('../replication/kinds/copy-kind.js')
  const target = `host:${hostKey}`
  const results = await within(copyKindNow('config', target), ms, [])
  return results.some((r) => r.target === target && (r.action === 'synced' || r.action === 'unchanged'))
}

/**
 * side.startOnHost(hostKey, payload), asked once more after the host caught up with the switch
 * when its first answer was host_runs_sessions_off and this leader's switch is on for it.
 */
export async function startOnHostCatchingUp(side: SwitchCatchUpSide, hostKey: string, request: unknown, o: SwitchCatchUpOptions = {}): Promise<HostCallAnswer> {
  // Read for each ask: the one more ask below may come up to CATCH_UP_MS later.
  const rowsNow = () => withTaskRows(request, hostKey, { rowsOf: o.taskRows, takes: o.takesTaskRows })
  const first = await side.startOnHost(hostKey, await rowsNow())
  if (!refusedAsOff(first) || !side.switchOn(hostKey)) return first
  const now = o.now ?? Date.now
  const until = now() + (o.budgetMs ?? CATCH_UP_MS)
  log.session.info('host start: the host says its switch is off while this leader says on; its copy of the config goes now, then the start once more', { host: hostKey })
  const took = await (o.copyConfigNow ?? copyConfigToHostNow)(hostKey, Math.max(0, until - now())).catch(() => false)
  if (!took) {
    log.session.warn('host start: the host did not take the config copy in time; its refusal stands', { host: hostKey })
    return first
  }
  if (!(await side.whenLinked(hostKey, Math.max(0, until - now())))) {
    log.session.warn('host start: the host took the config copy but its session side did not link in time; its refusal stands', { host: hostKey })
    return first
  }
  // Turned off meanwhile: the first refusal stands, no start goes.
  if (!side.switchOn(hostKey)) return first
  const second = await side.startOnHost(hostKey, await rowsNow())
  log.session.info('host start: asked once more after the host caught up with the switch', { host: hostKey, ok: second.ok === true, ...(second.ok === true ? {} : { error: second.error }) })
  return second
}
