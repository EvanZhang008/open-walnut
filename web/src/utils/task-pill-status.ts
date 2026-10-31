/**
 * Every task pill on the page wears its task's live status (a dot drawn by CSS
 * from `data-user-state`), on every surface at once: the session columns, the
 * Ask here thread, the Org chat, the Brief, letters.
 *
 * Set on the rendered anchors in place, never baked into the HTML: a status
 * moves every turn, and a new HTML string would rebuild each message naming
 * the task (dropping a selection in it) and flush the markdown cache. The Brief
 * learned that first and keeps stamping its own letter
 * (org-brief-model.ts applyBriefDecorations, 2026-10-28), so its pills are skipped here.
 *
 * One MutationObserver on the document catches pills as messages render; a
 * status change re-stamps the pills already on the page. Both are batched to
 * one animation frame.
 */
import type { UserState } from '@open-walnut/user-status';

export const TASK_PILL_SELECTOR = 'a.task-link[data-task-id]';
const BRIEF_BODY = '.org-brief-body';

export interface PillElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Stamp one pill; true when it changed. A link inside code stays code: no dot. */
export function stampTaskPill(el: PillElement, stateOf: (id: string) => UserState | undefined): boolean {
  const id = el.getAttribute('data-task-id') ?? '';
  const inCode = (el.getAttribute('class') ?? '').split(/\s+/).includes('task-link-code');
  const state = id && !inCode ? stateOf(id) : undefined;
  const now = el.getAttribute('data-user-state');
  if ((state ?? null) === now) return false;
  if (state) el.setAttribute('data-user-state', state); else el.removeAttribute('data-user-state');
  return true;
}

/**
 * Start stamping pills under `root` (the document body). `stateOf` is read at
 * stamp time, so `refresh()` after the task list changed is all a caller does.
 */
export function startTaskPillStatus(
  root: HTMLElement,
  stateOf: (id: string) => UserState | undefined,
): { refresh(): void; stop(): void } {
  let pending: Element[] = [];
  let all = true;
  let frame = 0;
  const run = () => {
    frame = 0;
    const scopes: ParentNode[] = all ? [root] : pending;
    all = false;
    pending = [];
    for (const scope of scopes) {
      const els = Array.from(scope.querySelectorAll(TASK_PILL_SELECTOR));
      if (scope instanceof Element && scope.matches(TASK_PILL_SELECTOR)) els.push(scope);
      // The Brief stamps its own pills (org-brief-model.ts applyBriefDecorations): one writer each.
      for (const el of els) if (!el.closest(BRIEF_BODY)) stampTaskPill(el, stateOf);
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
  const observer = new MutationObserver((records) => {
    if (all) return;
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1) pending.push(n as Element);
    }
    if (pending.length > 0) schedule();
  });
  observer.observe(root, { childList: true, subtree: true });
  schedule();
  return {
    refresh() { all = true; pending = []; schedule(); },
    stop() { observer.disconnect(); if (frame) cancelAnimationFrame(frame); },
  };
}
