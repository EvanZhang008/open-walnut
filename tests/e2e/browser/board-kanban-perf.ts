/**
 * The kanban spec's main-thread CPU probes and budgets (board-kanban-layout.spec.ts C50 C96),
 * kept apart so the spec stays under its 500 line limit (tests/web/kanban-hygiene.test.ts).
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import type { Page } from '@playwright/test'
import { getTask, type KanbanApi } from './board-kanban-fixture'

/** Long tasks from now on (Chromium; WebKit has no longtask entries: null). */
export const watchLongTasks = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __long: number[] | null }
  if (!(PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')) { w.__long = null; return false }
  w.__long = []
  const at = window as unknown as { __longAt: string[] }
  at.__longAt = []
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      w.__long!.push(Math.round(e.duration))
      at.__longAt.push(`${Math.round(e.duration)}ms@${new Date(performance.timeOrigin + e.startTime).toISOString().slice(14, 23)}`)
    }
  }).observe({ type: 'longtask' })
  return true
})
export const longTasks = (page: Page) => page.evaluate(() => (window as unknown as { __long: number[] | null }).__long)

// Main-thread CPU budgets (37 cards, the production bundle), counted in reference draws on the same
// clock (cpu-reference.ts). Measured 2026-11-02 over 20 runs: in an 8 CPU container (reference 122 to
// 137 ms) the open cost 169 to 235 ms (1.3 to 1.9 references, median 1.45) and the drag 256 to 357
// (2.1 to 2.8, median 2.6); with 4 CPUs and 4 workers (load 6 to 7) the open 181 to 296 (1.4 to 2.2)
// and the drag 318 to 433 (2.6 to 3.2). Three copies of this spec at once on 4 CPUs read 551 and 794
// for the drag: another copy's status pushes landed inside it. React's development build, which the
// old 500 ms / 3.5 references and 600 ms / 4.5 were set on, read 529 to 538 for the same open (3.7
// references; 2026-11-01: 2.3 to 2.6 at load, 3.6 to 3.9 for the build of 2026-10-23, whose inline
// callback ref re-measured the pane on every render). So the open 2.7 references and the drag 4,
// about 1.25 times the worst read: work grown by half fails wherever it reads like the loaded runs,
// and on a quiet machine at 1.9 (open) and 1.5 (drag) times its median. A lower line would also fail
// the loaded runs (the open spreads 1.7 times). As written: the same at the fastest reference (125 ms).
export const OPEN_CPU_REFS = 2.7
export const DRAG_CPU_REFS = 4
export const OPEN_CPU_MS = 340
export const DRAG_CPU_MS = 500
// One task of the drag, and of C96's pushes (the CPU of the longest one, scaled by the reference as
// a long task budget is: cpu-reference.ts longTaskBudget). Measured 2026-11-02 on the production
// bundle: the drag's longest 16 to 20 ms of CPU in the runs above (38 with another copy's pushes
// inside it), C96's 7 to 22 (the development build's read 60 ms, 2026-11-01). Tasks from 16 ms of wall time are traced, so one under the long
// task line of 50 ms is still judged.
export const DRAG_TASK_MS = 30
export const PUSH_TASK_MS = 32
export const TRACE_FROM_MS = 16

/**
 * The page's live frames about tasks and sessions outside the team are dropped (C50). Every worker of a
 * run shares the fixture server, and each frame about another spec's task re-renders what reads the
 * task store (the task list, the Board's view model), so the drag was judged on other specs' writes:
 * 2026-11-04, CI shard 1 ran three other kanban specs beside C50 and its drag read 1,967 and 2,165 ms
 * of CPU (budgets 688 and 976, 4 to 5 times the runs before it) with no change to the drag's code,
 * and on Linux one unrelated task patched 57 times inside the drag added about 3,000 ms. The team's
 * own frames pass (a task under it and its session are learned from them), so its live pushes still
 * land inside the window, as a user's own team's do.
 */
export async function onlyTeamFrames(page: Page, api: KanbanApi, taskIds: readonly string[], sessionIds: readonly string[]): Promise<void> {
  const tasks = new Set(taskIds)
  const sessions = new Set(sessionIds)
  for (const t of await Promise.all(taskIds.map((id) => getTask(api, id)))) {
    const sid = (t as { session_id?: string } | null)?.session_id
    if (sid) sessions.add(sid)
  }
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => { if (!outsideTeam(message, tasks, sessions)) ws.send(message) })
  })
}

type FrameData = { task?: { id?: unknown; session_id?: unknown; parent_task_id?: unknown }; taskId?: unknown; sessionId?: unknown }
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function outsideTeam(message: string | Buffer, tasks: Set<string>, sessions: Set<string>): boolean {
  if (typeof message !== 'string') return false
  let frame: { type?: string; data?: FrameData }
  try { frame = JSON.parse(message) } catch { return false }
  const d = frame.type === 'event' && frame.data && typeof frame.data === 'object' ? frame.data : null
  if (!d) return false
  const task = d.task && typeof d.task === 'object' ? d.task : undefined
  const taskOf = [task?.id, d.taskId].filter(str)
  const sessionOf = [d.sessionId, task?.session_id].filter(str)
  if (!taskOf.length && !sessionOf.length) return false
  const inTeam = taskOf.some((id) => tasks.has(id)) || sessionOf.some((id) => sessions.has(id))
    || (str(task?.parent_task_id) && tasks.has(task.parent_task_id))
  if (!inTeam) return true
  for (const id of taskOf) tasks.add(id)
  for (const id of sessionOf) sessions.add(id)
  return false
}
