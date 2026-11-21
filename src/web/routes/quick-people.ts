/**
 * The lists under the quick box (quick-input-v1.ts): who the box can talk to, and the tasks that
 * match the words typed into it.
 *
 *   quickPeople(): the org's nodes first (CEO, then every VP: the lead of a project), then the
 *   open tasks, the ones needing the user first. Each row carries the one line the user reads
 *   about it now (its ask, its report, or how many threads wait on him), so the picker says who
 *   is busy and who waits without another read. The client puts the people it sent to lately
 *   above the tasks (web/src/components/quickbar/quickbar-people.ts).
 */

import type { Task } from '../../core/types.js'
import type { UserState } from '../../core/user-status.js'

export interface QuickTaskRow {
  id: string
  title: string
  project: string
  state: string
  stateLabel: string
}

export interface QuickPerson {
  id: string
  title: string
  /** `ceo`: Main; `vp`: a project's lead; `task`: any other task. `stateLabel` is the short word (stateWord). */
  kind: 'ceo' | 'vp' | 'task'
  project: string
  state: string
  stateLabel: string
  /** What it does or asks now, in one line (may be empty). */
  line: string
  /** Threads (or, on a task, the ask) waiting on the user. */
  needs: number
}

/**
 * The people list while the user is in a focus space (experiment focus_workspace): the CEO and
 * the VPs stay (Main always sees all, and a line to a VP is how he drops a thought out), the
 * tasks inside the focus follow, and the tasks outside it are left out, only counted.
 * No focus (or the experiment off): the list as it is.
 */
export async function focusPeople(people: QuickPerson[]): Promise<{ people: QuickPerson[]; focus?: { name: string; outside: number } }> {
  const { experimentCache } = await import('../../core/experimental-cache.js')
  if (!(await (focusFlag ??= experimentCache('focus_workspace')).on())) return { people }
  const { getActiveFocus } = await import('../../core/focus-spaces/active.js')
  const active = await getActiveFocus()
  if (!active) return { people }
  const [{ taskInScope }, { scopeTaskLookup }] = await Promise.all([
    import('../../core/focus-spaces/scope.js'),
    import('../../core/task-manager.js'),
  ])
  const lookup = await scopeTaskLookup()
  const kept: QuickPerson[] = []
  let outside = 0
  for (const p of people) {
    if (p.kind !== 'task' || taskInScope(active.scope, p.id, lookup)) kept.push(p)
    else outside++
  }
  return { people: kept, focus: { name: active.name, outside } }
}
let focusFlag: import('../../core/experimental-cache.js').ExperimentCache | undefined

/** Tasks matching the words, best first, open ones before finished ones. */
const STATE_RANK: Record<string, number> = { needs: 0, read: 1, working: 2, waiting: 3, done: 4 }
const LINE_CHARS = 140

function oneLine(text: string | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS - 1)}…` : flat
}

/** Open board tasks, the ones needing the user first, then the most recently changed. */
export async function recentQuickTasks(limit: number): Promise<QuickTaskRow[]> {
  return (await openBoardTasks(limit)).map(({ task, state, label }) => ({ id: task.id, title: task.title, project: task.project ?? '', state, stateLabel: label }))
}

async function openBoardTasks(limit: number): Promise<Array<{ task: Task; state: string; label: string }>> {
  const [{ listTasks }, { USER_STATE_LABELS, fallbackUserState }, { phoneListedTasks }] = await Promise.all([
    import('../../core/task-manager.js'),
    import('../../core/user-status.js'),
    import('../../core/test-run.js'),
  ])
  // What the board shows: no plugin's own task (a test task only to a test run's own phone,
  // core/test-run.ts), not Main or a lead.
  return phoneListedTasks(await listTasks())
    .filter((t) => t.phase !== 'COMPLETE' && !t.org_role)
    .map((task) => ({ task, state: task.user_status?.state ?? fallbackUserState(task.phase) }))
    .sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9)
      || String(b.task.updated_at ?? '').localeCompare(String(a.task.updated_at ?? '')))
    .slice(0, limit)
    .map(({ task, state }) => ({ task, state, label: USER_STATE_LABELS[state as keyof typeof USER_STATE_LABELS] ?? state }))
}

export async function quickTasks(q: string, limit: number): Promise<QuickTaskRow[]> {
  const [{ search }, { getTask }, { USER_STATE_LABELS, fallbackUserState }] = await Promise.all([
    import('../../core/search.js'),
    import('../../core/task-manager.js'),
    import('../../core/user-status.js'),
  ])
  // A typing-speed list: the keyword lanes answer at once, the semantic lane gets a short wait.
  const hits = await search(q, { types: ['task'], limit: limit * 2, semanticDeadlineMs: 150 })
  const seen = new Set<string>()
  const rows: QuickTaskRow[] = []
  for (const hit of hits) {
    const id = hit.taskId
    if (!id || seen.has(id)) continue
    seen.add(id)
    const task = await getTask(id).catch(() => null)
    if (!task) continue
    const state = task.user_status?.state ?? fallbackUserState(task.phase)
    rows.push({ id: task.id, title: task.title, project: task.project ?? '', state, stateLabel: USER_STATE_LABELS[state] })
  }
  const open = rows.filter((r) => r.state !== 'done')
  const done = rows.filter((r) => r.state === 'done')
  return [...open, ...done].slice(0, limit)
}

/**
 * The line an org node shows: how many threads wait on the user, else what it does now. Never its
 * waitingOn: an idle CEO or VP always waits on "your next message", the same words on every row.
 */
function nodeLine(task: Task): { line: string; needs: number } {
  const status = task.user_status
  const needs = status?.threads?.needs ?? 0
  if (needs > 0) return { line: status?.threads?.title ? oneLine(status.threads.title) : '', needs }
  return { line: oneLine(status?.now), needs: 0 }
}

/** The line a task shows: its ask when it needs the user, else its report. */
function taskLine(task: Task, state: string): { line: string; needs: number } {
  const status = task.user_status
  if (state === 'needs') return { line: oneLine(status?.ask || status?.now), needs: 1 }
  return { line: oneLine(status?.now || status?.waitingOn), needs: 0 }
}

/** CEO, every VP, then up to `taskLimit` open tasks. */
export async function quickPeople(taskLimit: number): Promise<QuickPerson[]> {
  const [{ getOrgTree }, { getTask }, { stateWord, fallbackUserState }] = await Promise.all([
    import('../../core/org/org-store.js'),
    import('../../core/task-manager.js'),
    import('../../core/user-status.js'),
  ])
  const tree = await getOrgTree()
  const people: QuickPerson[] = []
  const seen = new Set<string>()
  const add = async (id: string | undefined, kind: 'ceo' | 'vp') => {
    if (!id || seen.has(id)) return
    seen.add(id)
    const task = await getTask(id).catch(() => null)
    if (!task || task.id !== id || task.phase === 'COMPLETE') return
    const state = task.user_status?.state ?? fallbackUserState(task.phase)
    people.push({
      id: task.id, title: task.title || (kind === 'ceo' ? 'CEO' : 'VP'), kind, project: task.project ?? '',
      state, stateLabel: stateWord(state), ...nodeLine(task),
    })
  }
  await add(tree.main?.id, 'ceo')
  for (const project of tree.projects) await add(project.lead?.id, 'vp')
  for (const { task, state } of await openBoardTasks(taskLimit)) {
    if (seen.has(task.id)) continue
    seen.add(task.id)
    people.push({ id: task.id, title: task.title, kind: 'task', project: task.project ?? '', state, stateLabel: stateWord(state as UserState), ...taskLine(task, state) })
  }
  return people
}
