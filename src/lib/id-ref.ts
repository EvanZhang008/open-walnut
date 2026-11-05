/**
 * An id reference (a whole id, or the start of one) resolved the one way every
 * reader agrees on: the item whose id IS the reference wins, and only when none
 * does is the reference read as a prefix. Ids vary in length (`muudy83e-d669`,
 * a UUID, `mvu1ubwm-45b6`), so one task's whole id can be the start of
 * another's; a plain prefix match then named both and answered "ambiguous" for
 * an id given in full. `tests/lib/id-ref-ratchet.test.ts` fails on a new
 * prefix match of an id that does not go through here.
 */

/** The items `ref` names: the exact one, else every one whose id starts with it. */
export function matchIdRef<T>(items: Iterable<T>, ref: string, idOf: (item: T) => string = (item) => (item as { id: string }).id): T[] {
  const byPrefix: T[] = []
  for (const item of items) {
    const id = idOf(item)
    if (id === ref) return [item]
    if (ref && id.startsWith(ref)) byPrefix.push(item)
  }
  return byPrefix
}

/**
 * Whether `ref` names `id`, when `exactExists` says whether some item's id is `ref` itself.
 * `holderId` is the item that carries `ref` (a child's `parent_task_id`): a reference never
 * names its own holder, whose id often starts with its parent's.
 */
export function refNamesId(ref: string | null | undefined, id: string, exactExists: boolean, holderId?: string): boolean {
  if (!ref || id === holderId) return false
  if (id === ref) return true
  return !exactExists && id.startsWith(ref)
}

/**
 * The parent a child's `parent_task_id` names among `items`: the task whose id IS the
 * reference, else the first whose id starts with it, and never the child itself. `knownIds`
 * holds every task id there is when `items` is only some of them (a filtered list): a
 * reference that is one of them names that task alone, so a parent left out of `items`
 * (completed, filtered away) resolves to nothing, never to the child, a sibling or a
 * descendant whose id starts with it (2026-11-04: a subtask whose id starts with its completed
 * parent's became its own parent in the search list, and the depth walk overflowed the stack).
 */
export function matchParentRef<T>(
  items: Iterable<T>,
  child: { id: string; parent_task_id?: string | null },
  opts: { idOf?: (item: T) => string; knownIds?: { has(id: string): boolean } } = {},
): T | undefined {
  const ref = child.parent_task_id
  if (!ref || ref === child.id) return undefined
  const idOf = opts.idOf ?? ((item: T) => (item as { id: string }).id)
  let first: T | undefined
  for (const item of items) {
    const id = idOf(item)
    if (id === child.id) continue
    if (id === ref) return item
    if (first === undefined && id.startsWith(ref)) first = item
  }
  return opts.knownIds?.has(ref) ? undefined : first
}

/**
 * The status an id lookup's own error answers with: an ambiguous prefix is the caller's to
 * lengthen and a parent that names no task, the task itself or one of its descendants is a
 * bad field (400), an id that names nothing
 * is not found (404). The core throws plain errors
 * with these words (task-manager.ts), and a route that passes one on to the error handler
 * answered 500, which also logged it as a broken route.
 */
export function idRefErrorStatus(message: string): 400 | 404 | 409 | null {
  if (/^(?:Ambiguous (?:ID|parent_task_id) prefix\b|Parent task not found:|A task cannot be its own parent\.)/.test(message)) return 400
  // A parent under its own child conflicts with the tree as it stands, as /api/v1 answers it.
  if (/^Circular reference:/.test(message)) return 409
  if (/^(?:No task found matching ID\b|Task not found: )/.test(message)) return 404
  return null
}

/** The words for a reference no task's id equals or starts with (idRefErrorStatus reads its head as 404). */
export function missingIdMessage(ref: string): string {
  return `No task found matching ID "${ref}": no task has that id or an id starting with it.`
}

/**
 * For `getTask(ref).catch(missingIsNull)` where a route answers 404 to a task it cannot find:
 * a reference that names no task reads null, and one several tasks share is thrown on (the
 * error handler answers it 400, idRefErrorStatus), so the caller hears to give more of the id,
 * never that a task it can see does not exist.
 */
export function missingIsNull(err: unknown): null {
  if (err instanceof Error && idRefErrorStatus(err.message) === 400) throw err
  return null
}

/** The words for a prefix several tasks share: which ones (the first three), and that the whole id names one. */
export function ambiguousIdMessage(ref: string, matches: readonly { id: string }[], field = 'ID'): string {
  const shown = matches.slice(0, 3).map((t) => t.id).join(', ')
  return `Ambiguous ${field} prefix "${ref}" matches ${matches.length} tasks (${shown}${matches.length > 3 ? ', ...' : ''}): give the whole id.`
}
