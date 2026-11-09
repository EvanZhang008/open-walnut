/**
 * Walnut closes the tabs a task opened once the task no longer uses them (2026-11-08, the user:
 * "the app shows only 2 open, but in browser so many open and keep there, please be consistent
 * also clean up after used, unless wait for human"). Every minute, while a browser is connected:
 *
 *   - a task that is done (COMPLETE, or gone) has its tabs closed at once;
 *   - a task whose tabs no agent used for IDLE_MS has them closed, unless it waits for the person
 *     (its status reads Needs you: it may have left a page for them to look at);
 *   - a tab the person has (Take over), watches, or looks at in the agent window, the agent waits
 *     on (a sign-in ask), or a command is on its way to, is never closed;
 *   - a tab of the person's own (handed over, or taken from their window) is given back, never
 *     closed: the extension's `close` decides that (agent.ts), as for an agent's own close.
 *
 * Only tasks' tabs: a session or script outside a task keeps its tabs until it closes them. The
 * extension closes its own leftovers (a tab it opened that no agent holds any more) itself
 * (agent-tidy.ts).
 */
import { log } from '../../logging/index.js'

export const TIDY_EVERY_MS = 60_000
export const IDLE_MS = 30 * 60_000

type Hub = typeof import('../../core/browser-control/hub.js')

export interface TidyDeps {
  hub: () => Promise<Hub>
  /** Whether the task is finished, and whether its status asks the person (Needs you, To read); undefined when there is no such task. */
  taskOf: (taskId: string) => Promise<{ done: boolean; needsYou: boolean } | undefined>
  /** What the browser may be told (the site rules); `close` itself checks no page. */
  allow: () => Promise<import('../../core/browser-control/hub.js').WireCommand['allow']>
  /** An open sign-in ask on the tab (the agent waits for the person there). */
  asksOn: (device: string, tab: number, owner: string) => boolean
}

/** One pass: the tabs closed, for the log and the tests. */
export async function tidyTabs(d: TidyDeps, now = Date.now()): Promise<Array<{ device: string; tab: number; owner: string; why: 'done' | 'idle' }>> {
  const h = await d.hub()
  const live = new Set(h.connected(now).map((c) => c.device))
  const tasks = new Map<string, { done: boolean; needsYou: boolean } | undefined | 'unknown'>()
  const out: Array<{ device: string; tab: number; owner: string; why: 'done' | 'idle' }> = []
  for (const t of h.heldTabs()) {
    if (!t.owner.startsWith('task:') || !live.has(t.device)) continue
    if (t.driving || d.asksOn(t.device, t.tab, t.owner) || h.tabBusy(t.device, t.tab)) continue
    const taskId = t.owner.slice(5)
    if (!tasks.has(taskId)) tasks.set(taskId, await d.taskOf(taskId).catch(() => 'unknown' as const))
    const task = tasks.get(taskId)
    if (task === 'unknown') continue
    const why = task === undefined || task.done ? 'done' as const
      : !task.needsYou && now - t.usedAt > IDLE_MS ? 'idle' as const : undefined
    if (!why) continue
    const gen = h.tabGen(t.device, t.tab)
    // Its end reads "tidied" even when the browser's next report of its tabs comes before the answer.
    const undoEnd = h.endingTab(t.device, t.tab, 'tidied')
    try {
      // `tidy`: the browser keeps a tab the person is looking at, and only lets go of one in their window.
      const r = await h.send(t.device, 'close', { tab: t.tab, owner: t.owner, tidy: true }, await d.allow(), 15_000) as { released?: boolean; kept?: string } | undefined
      if (r?.kept) { undoEnd(); continue }
      h.releaseTabIf(t.device, t.tab, t.owner, gen, r?.released ? 'given_back' : 'tidied')
      out.push({ device: t.device, tab: t.tab, owner: t.owner, why })
      log.web.info('browser tab tidied', { device: t.device, tab: t.tab, owner: t.owner, why, givenBack: r?.released === true })
    } catch (err) {
      undoEnd()
      // The tab went meanwhile, or the browser did not answer: the next pass tries again.
      log.web.info('browser tab tidy skipped', { device: t.device, tab: t.tab, owner: t.owner, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

let timer: NodeJS.Timeout | undefined
let running = false

/** Start the minute clock once (the first time a browser polls); idempotent. */
export function startTabTidy(d: TidyDeps): void {
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void tidyTabs(d).catch((err: unknown) => log.web.warn('browser tab tidy failed', { error: err instanceof Error ? err.message : String(err) })).finally(() => { running = false })
  }, TIDY_EVERY_MS)
  timer.unref?.()
}

export function _stopTabTidyForTesting(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  running = false
}
