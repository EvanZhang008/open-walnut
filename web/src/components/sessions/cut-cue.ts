/**
 * A timeline row whose words are cut (one line, or two, each ending in an ellipsis:
 * step-rows.css) shows its open chevron at rest, so the reader sees there is more behind
 * it; a row that shows all its words keeps the chevron for hover only (2026-11-21, the UI
 * audit of the user's chats: "System, about" cards cut their title and body "with no way
 * to expand"). One shared ResizeObserver marks each row `data-cut="true"` while any of its
 * line parts overflows; tests/e2e/browser/step-row-lines.spec.ts checks the row kinds.
 *
 * Every check reads all the rows due first and then writes their marks, so mounting a page
 * of rows (Load earlier turns) costs one layout, not one per row.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

/** The parts of a row that are cut with an ellipsis. */
export const CUT_PARTS = '.op-card-title, .op-card-summary, .op-card-to, .op-card-to-pill, .op-card-to-text, .tool-run-label, .tool-run-detail';

function isCut(row: Element): boolean {
  for (const el of row.querySelectorAll<HTMLElement>(CUT_PARTS)) {
    // Its own line only: an opened card's detail or a row's body may hold other rows.
    const inner = el.closest('.op-card-detail, .tool-run-body');
    if (inner && row.contains(inner)) continue;
    if (el.scrollWidth > el.clientWidth + 1) return true;
  }
  return false;
}

function markAll(rows: Iterable<Element>): void {
  const due = [...rows].filter((r) => r.isConnected);
  const cut = due.map(isCut); // every read first ...
  due.forEach((row, i) => {   // ... then every write
    if (cut[i]) { if (row.getAttribute('data-cut') !== 'true') row.setAttribute('data-cut', 'true'); }
    else if (row.hasAttribute('data-cut')) row.removeAttribute('data-cut');
  });
}

let observer: ResizeObserver | null = null;
const watchers = new Map<Element, number>();
const pending = new Set<Element>();
let frame = 0;

function shared(): ResizeObserver | null {
  if (observer || typeof ResizeObserver === 'undefined') return observer;
  // Its first call for a row comes with the observe itself, after layout and before paint.
  observer = new ResizeObserver((entries) => markAll(entries.map((e) => e.target)));
  return observer;
}

/** A row whose words changed at the same size: checked once on the next frame, with the rest. */
function later(row: Element): void {
  pending.add(row);
  if (frame || typeof requestAnimationFrame === 'undefined') return;
  frame = requestAnimationFrame(() => { frame = 0; const rows = [...pending]; pending.clear(); markAll(rows); });
}

function watch(row: Element): void {
  const n = watchers.get(row) ?? 0;
  watchers.set(row, n + 1);
  if (n === 0) shared()?.observe(row);
  else later(row);
}

function unwatch(row: Element): void {
  const n = (watchers.get(row) ?? 1) - 1;
  if (n > 0) { watchers.set(row, n); return; }
  watchers.delete(row);
  pending.delete(row);
  shared()?.unobserve(row);
}

/**
 * Marks the row that `ref`'s element belongs to while its words are cut: the element itself,
 * its parent (`'parent'`, a part drawn beside the row's other line), or the card around it
 * (`'card'`, a part inside a card's who line). `words` re-checks when the text changes at the
 * same size (a task's label that loads late).
 */
export function useCutCue<T extends HTMLElement>(words: unknown, rowOf: 'self' | 'parent' | 'card' = 'self'): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const row = !el ? null : rowOf === 'parent' ? el.parentElement : rowOf === 'card' ? el.closest('.provenance-card') : el;
    if (!row) return;
    watch(row);
    return () => { unwatch(row); };
  }, [words, rowOf]);
  return ref;
}
