/**
 * A block that answers inside a list (a task's Action needed: its answer box, its buttons, its
 * agent words) keeps its key presses off the row and the list's own keys, but never Escape.
 *
 * Escape belongs to what a press inside opened over the page: a path in the block's words opens
 * the file viewer, which hears Escape on `window` (FileViewer.tsx). A block that stopped every key
 * kept that Escape from it, and the viewer stayed open (2026-11-20, nightly agent-status-source:
 * a file opened from a row's ask did not close on Escape). Guard:
 * tests/web/keep-keys-inside-guard.test.ts.
 */
export function keepKeysInside(e: { key: string; stopPropagation(): void }): void {
  if (e.key === 'Escape') return;
  e.stopPropagation();
}
