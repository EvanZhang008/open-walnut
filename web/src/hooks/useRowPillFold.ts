import { useLayoutEffect, type RefObject } from 'react';

/**
 * Tells a task row whether it is crowded, as `data-pill-crowd` on the row itself.
 * The pills of a row are siblings with no common component, and the rule needs to
 * know about the ones BEFORE and AFTER a pill, which CSS can only ask with `:has()`;
 * WebKit (the Mac app) does not restyle reliably when a late pill changes that
 * (row-pill-fit.css). So each pill reports when it appears or goes, and the row
 * carries a plain attribute that CSS reads the way it reads `data-row-fit`.
 */
const ROW = '.todo-item-title-row, .todo-focus-card, .todo-pinned-card';

/** A row is crowded with two pills, or a tag group beside a pill. */
export function isCrowdedRow(row: Element): boolean {
  let pills = 0;
  let tags = 0;
  for (const child of Array.from(row.children)) {
    if (child.classList.contains('task-row-pill')) pills++;
    else if (child.classList.contains('task-tag-pills')) tags++;
  }
  return pills >= 2 || (pills >= 1 && tags >= 1);
}

export function syncRowPillCrowd(row: Element): void {
  if (!row.matches(ROW)) return;
  row.toggleAttribute('data-pill-crowd', isCrowdedRow(row));
}

/** After the commit, so an unmounting pill is already out of the row when it is counted. */
function syncAfterCommit(row: Element): void {
  queueMicrotask(() => { if (row.isConnected) syncRowPillCrowd(row); });
}

/**
 * `ref` is the pill's own element, `present` whether it is drawn now (a component
 * that returns null is still mounted). Call it above any early return.
 */
export function useRowPillFold(ref: RefObject<Element | null>, present: boolean): void {
  useLayoutEffect(() => {
    if (!present) return undefined;
    const row = ref.current?.parentElement;
    if (!row) return undefined;
    syncAfterCommit(row);
    return () => syncAfterCommit(row);
  }, [ref, present]);
}
