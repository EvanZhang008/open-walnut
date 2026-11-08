/**
 * Which parents the task panel's load-time auto-expand opens (TodoPanel): a parent with an open
 * subtask that is not open yet, ONCE. A parent it opened before is in `opened`, so a parent the
 * user folded afterwards stays folded on every later load (2026-11-10 review: a fold the user
 * set is the user's, and no late load writes it again).
 */
import { matchParentRef } from '../../../../src/lib/id-ref';

interface ParentLike { id: string; parent_task_id?: string | null; status?: string }

export function parentsToAutoOpen(
  tasks: readonly ParentLike[],
  expanded: ReadonlySet<string>,
  opened: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    if (!t.parent_task_id || t.status === 'done') continue;
    // The same parent rule as the tree (src/lib/id-ref.ts): an id prefix alone can name another task.
    const parent = matchParentRef(tasks, t);
    if (parent && !expanded.has(parent.id) && !opened.has(parent.id)) out.add(parent.id);
  }
  return [...out];
}

/** How many parents the record keeps: the oldest go first past it, so it never grows forever. */
export const AUTO_OPENED_CAP = 2_000;

/**
 * The record after a load opened `added`: every parent it holds stays (newest last), and only the
 * oldest past `cap` are dropped. It is never pruned against the loaded tasks: those leave out the
 * archived and completed ones the board has not fetched, and a parent dropped for that would be
 * opened again over the user's fold once it shows (2026-11-10 review). Returns `opened` itself
 * when nothing changed.
 */
export function recordAutoOpened(opened: ReadonlySet<string>, added: readonly string[], cap = AUTO_OPENED_CAP): ReadonlySet<string> {
  const fresh = added.filter((id) => !opened.has(id));
  if (fresh.length === 0 && opened.size <= cap) return opened;
  const all = [...opened, ...fresh];
  return new Set(all.slice(Math.max(0, all.length - cap)));
}
