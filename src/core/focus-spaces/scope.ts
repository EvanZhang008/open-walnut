/**
 * Which tasks a focus scope lets through: the ONE rule the server's gates (push, letters,
 * threads, approvals) and the browser's (toasts, the rail, the views) both follow.
 *
 * A scope names projects and tasks. A task is inside when it is one of the named tasks, a
 * subtask of one (any depth, through `parent_task_id`), or in one of the named projects. A
 * scope with nothing in it lets nothing through. Naming a task never moves it: the scope is
 * a list read beside the board, so Main and every lead still see the task where it lives.
 *
 * Leaf module, no imports: the web app reads this same file through the
 * `@open-walnut/focus-scope` alias, so the server and the browser can never decide
 * differently. The caller supplies the task lookup (the server's store, the browser's).
 */

export interface FocusScope {
  /** Project names (case-insensitive). The Inbox is `Inbox` ('' in older data reads as it). */
  projects?: readonly string[]
  /** Task ids; their subtasks are inside too. */
  tasks?: readonly string[]
}

/** What the rule needs of a task. */
export interface ScopeTask {
  id: string
  project?: string | null
  parent_task_id?: string | null
}

export type ScopeTaskLookup = (id: string) => ScopeTask | undefined | null

/** Parent hops followed at most (a cycle or a very deep tree stops here). */
export const SCOPE_MAX_HOPS = 12
export const SCOPE_MAX_TASKS = 50
export const SCOPE_MAX_PROJECTS = 20

/** True when the scope names anything at all. */
export function scopeIsEmpty(scope: FocusScope | null | undefined): boolean {
  return !scope || ((scope.projects?.length ?? 0) === 0 && (scope.tasks?.length ?? 0) === 0)
}

/** Is `taskId` inside `scope`? Unknown tasks are outside, except a named id itself. */
export function taskInScope(scope: FocusScope, taskId: string | null | undefined, lookup: ScopeTaskLookup): boolean {
  if (!taskId) return false
  const tasks = new Set(scope.tasks ?? [])
  const projects = new Set((scope.projects ?? []).map(projectKey))
  if (tasks.has(taskId)) return true
  let id: string | null | undefined = taskId
  const seen = new Set<string>()
  for (let hop = 0; id && hop <= SCOPE_MAX_HOPS && !seen.has(id); hop++) {
    seen.add(id)
    if (tasks.has(id)) return true
    const task = lookup(id)
    if (!task) return false
    if (projects.size > 0 && projects.has(projectKey(task.project ?? ''))) return true
    id = task.parent_task_id
  }
  return false
}

/** One key per project: case-insensitive, and the Inbox's old '' is `inbox`. */
function projectKey(name: string): string {
  return name.trim().toLowerCase() || 'inbox'
}

/** A scope cleaned for storage: trimmed, de-duplicated, capped. */
export function normalizeScope(raw: unknown): FocusScope {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const list = (v: unknown, max: number, keepEmpty: boolean): string[] => {
    if (!Array.isArray(v)) return []
    const out: string[] = []
    for (const one of v) {
      if (typeof one !== 'string') continue
      const s = one.trim()
      if ((!s && !keepEmpty) || s.length > 200 || out.includes(s)) continue
      out.push(s)
      if (out.length >= max) break
    }
    return out
  }
  const projects = list(r.projects, SCOPE_MAX_PROJECTS, true)
  const tasks = list(r.tasks, SCOPE_MAX_TASKS, false)
  return { ...(projects.length ? { projects } : {}), ...(tasks.length ? { tasks } : {}) }
}
