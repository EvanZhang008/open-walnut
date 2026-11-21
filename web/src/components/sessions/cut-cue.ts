/**
 * A timeline row whose words are cut (one line, or two, each ending in an ellipsis:
 * step-rows.css) shows its open chevron at rest, so the reader sees there is more behind
 * it; a row that shows all its words keeps the chevron for hover only (2026-11-21, the UI
 * audit of the user's chats: "System, about" cards cut their title and body "with no way
 * to expand"). One shared ResizeObserver marks each row `data-cut="true"` while any of its
 * line parts overflows; tests/e2e/browser/step-row-lines.spec.ts checks every row kind.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

/** The parts of a row that are cut with an ellipsis. */
export const CUT_PARTS = '.op-card-title, .op-card-summary, .op-card-to, .tool-run-label, .tool-run-detail';

function mark(row: Element): void {
  let cut = false;
  for (const el of row.querySelectorAll<HTMLElement>(CUT_PARTS)) {
    // Its own line only: an opened card's detail or a row's body may hold other rows.
    const inner = el.closest('.op-card-detail, .tool-run-body');
    if (inner && row.contains(inner)) continue;
    if (el.scrollWidth > el.clientWidth + 1) { cut = true; break; }
  }
  if (cut) row.setAttribute('data-cut', 'true');
  else row.removeAttribute('data-cut');
}

let observer: ResizeObserver | null = null;
function shared(): ResizeObserver | null {
  if (observer || typeof ResizeObserver === 'undefined') return observer;
  observer = new ResizeObserver((entries) => { for (const e of entries) mark(e.target); });
  return observer;
}

/**
 * Marks the row `ref` points at (or its parent, `parent: true`, for a part inside the row)
 * while its words are cut. `words` re-checks when the row's text changes at the same size.
 */
export function useCutCue<T extends HTMLElement>(words: unknown, parent = false): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const row = parent ? ref.current?.parentElement : ref.current;
    if (!row) return;
    mark(row);
    const ro = shared();
    ro?.observe(row);
    return () => { ro?.unobserve(row); };
  }, [words, parent]);
  return ref;
}
