/**
 * The completion check: a task that shipped a change (ships.ts) completes only after it named
 * what real use should show and who watches it (a usage_watch watch), or recorded why nothing
 * can (an exemption). It sits in the one gate every session close goes through
 * (sessions/owed-to-user.ts admitSessionClose), so every way to complete a task meets it; a
 * person's own close never does. On only with the `real_use_watch` experiment.
 */
import { lastShipOf } from './ships.js'
import { listWatches, newWatch, putWatch, type Watch } from './watches.js'

const HOUR_MS = 3_600_000

export interface ShipWatchRefusal {
  ok: false
  code: 'no_real_use_watch'
  message: string
  items: Array<{ source: 'ship'; text: string }>
}

export interface GateDeps {
  enabled: () => Promise<boolean>
  /** Whether a trigger is enabled and aimed at an open task other than `taskId`. */
  triggerWatches: (triggerId: string, taskId: string) => Promise<boolean>
}

/** Whether a watch covers the ship: set after it (or just before, in the same work) and checking at least an hour past it. */
function coversShip(w: Watch, shipAt: number): boolean {
  if (w.state === 'exempt') return w.createdAt >= shipAt - 24 * HOUR_MS
  if (w.state === 'dropped' || w.state === 'unwatched') return false
  return w.checkAt >= shipAt + HOUR_MS && w.createdAt >= shipAt - 24 * HOUR_MS
}

/** Null when the task may complete; else the refusal naming what is missing. */
export async function admitShipWatch(task: { id: string }, deps: GateDeps): Promise<ShipWatchRefusal | null> {
  if (!(await deps.enabled())) return null
  const ship = lastShipOf(task.id)
  if (!ship) return null
  const mine = listWatches({ taskId: task.id }).filter((w) => coversShip(w, ship.at))
  if (mine.some((w) => w.state === 'exempt')) return null
  const failed = mine.find((w) => w.state === 'failed')
  const ok = mine.filter((w) => w.state !== 'failed')
  for (const w of ok) {
    if (w.targets.length) return null
    if (w.triggerId && await deps.triggerWatches(w.triggerId, task.id).catch(() => false)) return null
  }
  const when = new Date(ship.at).toISOString().slice(0, 16).replace('T', ' ')
  const text = failed
    ? `Your watch ${failed.id} failed: ${(failed.result ?? []).filter((r) => !r.ok).map((r) => `${r.target}: ${r.notes.join('; ')}`).join(' · ') || 'see usage_watch {"action":"list"}'}.`
    : `This task shipped (${ship.how}, ${when} UTC) and names nothing to watch in real use.`
  return {
    ok: false,
    code: 'no_real_use_watch',
    items: [{ source: 'ship', text }],
    message: `Not completed: ${text} `
      + (failed
        ? 'Fix what it names and ship again, then arm a new watch; '
        : 'Arm a watch on what you changed, then complete again: ')
      + 'usage_watch {"action":"set","targets":["op:<tool>" or "route:GET /api/..." or "page:<part>"],"checks":{"max_answer_chars":20000,"max_fail_pct":5},"who":"this task","check_after":"24h"}. '
      + 'A check only a script can make: name a trigger aimed at a task that stays open ("trigger":"<id>"). '
      + 'Only copy, colour, docs or tests changed, the ship did not happen, or real use is watched outside Walnut (a pipeline alarm, a dashboard): '
      + 'record why instead, then complete again: usage_watch {"action":"exempt","kind":"copy|colour|docs|tests|not_shipped|watched_elsewhere","reason":"<20+ characters: for watched_elsewhere, what watches it, who reads it, when>"} '
      + '(it shows under Watches, and your lead sees it).',
  }
}

/**
 * A task that shipped was closed with nothing naming its real-use signal (its lead or a person
 * closed it, so the check above did not run): one `unwatched` row per ship, so the Real Use page
 * shows the gap. Never refuses anything. Null when nothing was recorded.
 */
export function noteClosedUnwatched(taskId: string, now = Date.now()): Watch | null {
  const ship = lastShipOf(taskId)
  if (!ship) return null
  const mine = listWatches({ taskId })
  if (mine.some((w) => (w.state === 'unwatched' && w.createdAt >= ship.at) || coversShip(w, ship.at))) return null
  const w = newWatch({ taskId, targets: [], checks: {}, who: 'this task', shipAt: ship.at, checkAt: now, createdAt: now, state: 'unwatched', by: 'closed' })
  putWatch(w)
  return w
}

export const gateDeps: GateDeps = {
  enabled: async () => (await import('./runtime.js')).realUseOn(),
  triggerWatches: async (triggerId, taskId) => {
    // A trigger is a routine with a check whose executor sends to a session's task (task-wait-until.ts).
    const { listRoutines } = await import('../routines/routines-core.js')
    const { jobs } = await listRoutines(true)
    const job = (jobs as Array<{ id: string; enabled?: boolean; check?: unknown; executor?: { type?: string; config?: unknown } }>).find((j) => j.id === triggerId)
    if (!job || job.enabled === false || !job.check || job.executor?.type !== 'session') return false
    const target = (job.executor.config as { target?: unknown } | undefined)?.target
    if (typeof target !== 'string' || target === taskId) return false
    const { listTasksByIds } = await import('../task-manager.js')
    const [task] = await listTasksByIds([target])
    return !!task && task.phase !== 'COMPLETE'
  },
}
