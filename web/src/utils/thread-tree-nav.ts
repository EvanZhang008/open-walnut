/**
 * Keyboard movement over the drawer's flattened rows (spec 6.7), split out of
 * thread-tree-rows.ts (which builds the rows): which rows take the cursor, the
 * arrow keys, and where the cursor goes when a row is removed.
 */
import { pathToRoot, type ThreadTree } from '@/utils/thread-tree';
import type { TreeRow, TreeRowKind } from '@/utils/thread-tree-rows';


const NAVIGABLE: ReadonlySet<TreeRowKind> = new Set(['root', 'thread', 'pin', 'done-group', 'pending', 'draft', 'hidden']);

export const isNavigable = (row: TreeRow | undefined): boolean => !!row && NAVIGABLE.has(row.kind);
const navIndexes = (rows: readonly TreeRow[]): number[] => rows.flatMap((r, i) => (NAVIGABLE.has(r.kind) ? [i] : []));
export const firstRowId = (rows: readonly TreeRow[]): string | undefined => rows.find(isNavigable)?.id;
export const lastRowId = (rows: readonly TreeRow[]): string | undefined => [...rows].reverse().find(isNavigable)?.id;

/** The first row that matched the search (not an ancestor, not root). */
export function firstMatchRowId(rows: readonly TreeRow[]): string | undefined {
  return rows.find((r) => r.matched && r.kind !== 'root' && NAVIGABLE.has(r.kind))?.id ?? firstRowId(rows);
}

/** Next (+1) / previous (-1) navigable row; `null` = ArrowUp on the first row
 *  (focus goes back to the search box); the same id at the end. */
export function stepRowId(rows: readonly TreeRow[], id: string | undefined, delta: 1 | -1): string | null | undefined {
  const nav = navIndexes(rows);
  if (nav.length === 0) return undefined;
  const at = nav.findIndex((i) => rows[i].id === id);
  if (at < 0) return rows[nav[0]].id;
  const next = at + delta;
  return next < 0 ? null : rows[nav[Math.min(next, nav.length - 1)]].id;
}

export type TreeArrowResult = { type: 'expand' | 'collapse'; row: TreeRow } | { type: 'move'; id: string } | { type: 'none' };

/** ArrowRight: collapsed with children = expand; expanded = first child. */
export function arrowRight(rows: readonly TreeRow[], id: string | undefined): TreeArrowResult {
  const i = rows.findIndex((r) => r.id === id);
  const row = rows[i];
  if (!row?.hasChildren) return { type: 'none' };
  if (!row.expanded) return row.disclosureDisabled ? { type: 'none' } : { type: 'expand', row };
  for (let j = i + 1; j < rows.length; j++) {
    const r = rows[j];
    const child = r.parentRowId === row.id || (row.kind === 'done-group' && r.depth === row.depth);
    if (!child) break;
    if (NAVIGABLE.has(r.kind)) return { type: 'move', id: r.id };
  }
  return { type: 'none' };
}

/** ArrowLeft: expanded with children = collapse; else move to the parent row. */
export function arrowLeft(rows: readonly TreeRow[], id: string | undefined): TreeArrowResult {
  const row = rows.find((r) => r.id === id);
  if (!row) return { type: 'none' };
  if (row.hasChildren && row.expanded && !row.disclosureDisabled) return { type: 'collapse', row };
  const up = row.parentRowId && rows.some((r) => r.id === row.parentRowId && NAVIGABLE.has(r.kind));
  return up ? { type: 'move', id: row.parentRowId! } : { type: 'none' };
}

/**
 * Where the keyboard cursor goes when row `id` is removed: the next surviving
 * sibling, else the previous one, else the parent (spec 6.5). Siblings share a
 * parent row; placeholders and non-navigable rows never take the cursor.
 */
export function survivorAfterRemove(rows: readonly TreeRow[], id: string, removedIds: ReadonlySet<string> = new Set()): string | undefined {
  const i = rows.findIndex((r) => r.id === id);
  const row = rows[i];
  if (!row) return undefined;
  const ok = (r: TreeRow) => r.id !== id && NAVIGABLE.has(r.kind) && !removedIds.has(r.id)
    && r.parentRowId === row.parentRowId && r.depth === row.depth;
  for (const dir of [1, -1]) {
    for (let j = i + dir; j >= 0 && j < rows.length && rows[j].depth >= row.depth; j += dir) if (ok(rows[j])) return rows[j].id;
  }
  return row.parentRowId;
}

/** Keys to un-collapse so `key`'s row is visible (its ancestors and root). */
export function ancestorKeysOf(tree: ThreadTree, key: string): string[] {
  return pathToRoot(tree, key).slice(0, -1).map((n) => n.key);
}

/** Is this key a printable character typed without Cmd / Ctrl / Alt (type-to-search)? */
export function isTypeToSearchKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey;
}
