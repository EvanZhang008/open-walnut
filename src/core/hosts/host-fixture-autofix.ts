/**
 * The host fixture's automatic fix (C29, C95), in the order the real server
 * puts it on the wire: the Update click's own re-check answers first (still
 * outdated), then `readiness.fixing` appears, then the fix ends and `fixing`
 * drops a moment BEFORE the re-check that clears the problem lands. A client
 * that lets go of "Updating..." on the first answer newer than its click shows
 * the old warning in that gap: the flicker useHostActions' hold exists to stop.
 *
 * Fixture only (WALNUT_TEST_HOST_FIXTURE_MODE=1): nothing here runs a command.
 */

import { BLOCKING_READINESS_KINDS, autofixVerbFor } from './host-problem.js'
import { fixActionFor, fixingText, type HostFixAction } from './host-autofix.js'
import { getHostReadiness } from './host-readiness.js'
import { fixtureHost, fixtureNow, healthyFixtureClaude, seedFixtureReadiness } from './host-fixture.js'

/** The click's re-check lands, then the fix starts. */
const FIX_START_AFTER_MS = 300
/** A fix with no autofix-slow setting. */
const DEFAULT_FIX_MS = 2_000
/** Between the fix ending and its re-check answering (the real one is up to ~14s). */
const RECHECK_GAP_MS = 1_500

const timers = new Map<string, Set<ReturnType<typeof setTimeout>>>()

function later(host: string, ms: number, fn: () => void): void {
  const set = timers.get(host) ?? new Set()
  const t = setTimeout(() => { set.delete(t); fn() }, ms)
  set.add(t)
  timers.set(host, set)
}

/** Stop every simulated fix (one host, or all): a reloaded or reset fixture starts clean. */
export function cancelFixtureAutofix(host?: string): void {
  for (const [key, set] of timers) {
    if (host !== undefined && key !== host) continue
    for (const t of set) clearTimeout(t)
    timers.delete(key)
  }
}

function doneText(action: HostFixAction, version: string | undefined): string {
  const v = version ? ` ${version}` : ''
  return action === 'update-claude' ? `Updated Claude Code${version ? ` to ${version}` : ''}` : `Installed Claude Code${v}`
}

/**
 * A human asked a connected fixture host to connect again (Update): when its
 * blocking problem has an automatic fix, run the simulated one. `push` sends
 * the host's frame. Returns whether a fix started.
 */
export function maybeStartFixtureAutofix(host: string, push: () => void): boolean {
  const h = fixtureHost(host)
  if (!h || h.phase !== 'connected' || h.fixing || timers.get(host)?.size) return false
  const r = getHostReadiness(host, fixtureNow())
  const problem = r?.problems.find((p) => BLOCKING_READINESS_KINDS.includes(p.kind) && autofixVerbFor(p, r.claude.installMethod))
  const action = r && problem ? fixActionFor(problem.kind, r) : null
  if (!action) return false
  later(host, FIX_START_AFTER_MS, () => {
    if (fixtureHost(host) !== h) return
    h.fixing = { action, startedAt: fixtureNow(), text: fixingText(action) }
    push()
    later(host, h.autofixSlowMs || DEFAULT_FIX_MS, () => {
      if (fixtureHost(host) !== h || !h.fixing) return
      const claude = healthyFixtureClaude()
      h.fixing = undefined
      h.fixes = [...(h.fixes ?? []), { action, ok: true, finishedAt: fixtureNow(), text: doneText(action, claude.version) }]
      // The fix is over, but its re-check has not answered: the old problem is still the stored answer.
      push()
      later(host, RECHECK_GAP_MS, () => {
        if (fixtureHost(host) !== h) return
        h.nextCheck = { claude }
        seedFixtureReadiness(host)
      })
    })
  })
  return true
}
