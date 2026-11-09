/**
 * Measures the tool row of a session panel's header and decides what it shows
 * (session-header-fit.ts has the rules). Hidden items stay mounted with
 * `data-hidden="true"` (CSS hides them), so the menus that stand in for them
 * can proxy a click to the real element and read its live text.
 *
 * Natural widths are remembered per item and per form (full / short), measured
 * whenever that form is on screen, so the decision never reads the current
 * state: the composer controls row's rule against flicker.
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { fitToolRow, type ToolItemKind, type ToolRowItem } from './session-header-fit';

/** Mirrors `.session-meta-row-2-chips { gap }`, `.session-panel-window-controls { gap }`, `.session-meta-row-2 { gap }`. */
const CHIP_GAP = 6;
const WINDOW_GAP = 3;
const GROUP_GAP = 6;
/** The "..." chip before it has rendered once. */
const ASSUMED_MORE_WIDTH = 22;
/** Kept free of every decision: a row that fits to the last fraction of a pixel
 *  can still wrap (its containment) on a sub-pixel rounding, the Mac app zoomed
 *  most of all. Same idea as the composer row's DETAIL_FIT_SLACK. */
const FIT_SLACK = 1;

export interface ToolRowState {
  hidden: Set<string>;
  /** What the row's "..." menu lists: hidden chips, then hidden window buttons. */
  inMore: string[];
}

const NO_TOOL_FIT: ToolRowState = { hidden: new Set(), inMore: [] };

/** Priority (1 leaves last) and kind of every tool row item, by its `data-header-id`. */
export const TOOL_ITEMS: Record<string, { kind: ToolItemKind; priority: number; name: string }> = {
  // Plan is known only once the session record (or its plan) has loaded, so it may join
  // the row after first paint: it leaves before every host chip, so arriving it only takes
  // room nobody uses or joins the "..." menu, and never pushes a chip out from under a
  // click on its way (2026-10-11). A fact the user pinned still leaves first.
  plan: { kind: 'chip', priority: 6.2, name: 'Plan' },
  fork: { kind: 'chip', priority: 2, name: 'Fork' },
  changed: { kind: 'chip', priority: 3, name: 'Changed' },
  files: { kind: 'chip', priority: 4, name: 'Files' },
  terminal: { kind: 'chip', priority: 6, name: 'Terminal' },
  // Scripts rides with Terminal (it types into it) and leaves just before it.
  scripts: { kind: 'chip', priority: 6.05, name: 'Scripts' },
  // Board is a lead's chip only, and like Plan it may join after first paint (when the
  // task list or the owner read lands): it leaves just before Terminal, so arriving it
  // never pushes Terminal into "..." (2026-10-26).
  board: { kind: 'chip', priority: 6.1, name: 'Board' },
  time: { kind: 'info', priority: 7, name: 'Last activity' },
  // Locate and Watch are no header buttons: they are rows of the kebab, by their names
  // (2026-11-09, the user of the crosshair and the eye: "this 2 put iot in the drop down").
  popout: { kind: 'window', priority: 11, name: 'Open in new tab' },
  // Minimize puts the panel on the taskbar: the last window button to fold, after
  // Open in new tab.
  minimize: { kind: 'window', priority: 8, name: 'Minimize to taskbar' },
  // Lock, Expand and Close stay at every width: a cramped column is the moment to
  // go full screen (the user: "at the very least keep close and expand",
  // 2026-10-03), and Lock is the one that keeps the panel there (2026-10-04).
  lock: { kind: 'fixed', priority: 0, name: 'Lock panel' },
  expand: { kind: 'fixed', priority: 0, name: 'Expand' },
  close: { kind: 'fixed', priority: 0, name: 'Close' },
};

/** The prefix of a pinned plugin fact's id on the row (PinnedSessionFacts in SessionMetaFacts.tsx). */
export const SLOT_ID_PREFIX = 'slot:';

/**
 * Kind, priority and name of a row item. A plugin fact the user pinned to the header
 * is a chip that leaves before every chip of the host's own (priority past Terminal),
 * and is named by the slot's title, which the row carries as `data-header-name`.
 */
export function toolItemSpec(id: string, el?: HTMLElement | null): { kind: ToolItemKind; priority: number; name: string } | undefined {
  const own = TOOL_ITEMS[id];
  if (own) return own;
  if (!id.startsWith(SLOT_ID_PREFIX)) return undefined;
  return { kind: 'chip', priority: 6.5, name: el?.dataset.headerName || 'Plugin' };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The tool row (`.session-meta-row-2`): which `[data-header-id]` items stay and
 * which go to the row's "..." menu. Pass the row's ref; the hook
 * finds the items itself, so a chip the session does not offer (no Fork or Board
 * on a session known to have no task, no Terminal on a host without SSH)
 * simply is not there. One that waits for the session record is there from the
 * first frame, disabled; one kept as a spacer (`data-header-spacer`) is an item
 * like the control it stands in for, so the row folds exactly as before.
 */
export function useToolRowFit(rowRef: RefObject<HTMLElement | null>): ToolRowState {
  const widths = useRef(new Map<string, number>());
  const [state, setState] = useState<ToolRowState>(NO_TOOL_FIT);
  const current = useRef(state);
  current.current = state;

  /** The fit the row's room asks for now, or null when that is what it shows. */
  const measure = useCallback((): ToolRowState | null => {
    const row = rowRef.current;
    if (!row) return null;
    const items: ToolRowItem[] = [];
    for (const el of row.querySelectorAll<HTMLElement>('[data-header-id]')) {
      const id = el.dataset.headerId!;
      // A wrapper whose component rendered nothing (Fork with no fork draft, or no task) is not an item.
      if (el.childElementCount === 0 && !el.textContent?.trim()) continue;
      const spec = toolItemSpec(id, el);
      if (!spec) continue;
      if (el.dataset.hidden !== 'true') {
        const w = el.getBoundingClientRect().width;
        if (w > 0) widths.current.set(id, w);
      }
      items.push({ id, kind: spec.kind, priority: spec.priority, width: widths.current.get(id) });
    }
    const more = row.querySelector<HTMLElement>('[data-header-more]');
    const moreWidth = more?.getBoundingClientRect().width || ASSUMED_MORE_WIDTH;
    const rowWidth = row.getBoundingClientRect().width;
    // A row with no width is not laid out (a hidden column, a collapsed panel):
    // keep the last decision rather than reset to "show everything".
    if (rowWidth <= 0) return null;
    const fit = fitToolRow(items, rowWidth - FIT_SLACK, {
      chipGap: CHIP_GAP, windowGap: WINDOW_GAP, groupGap: GROUP_GAP, moreWidth,
    });
    const hidden = [...fit.inMore, ...fit.dropped];
    const prev = current.current;
    if (sameList([...prev.hidden], hidden) && sameList(prev.inMore, fit.inMore)) return null;
    return { hidden: new Set(hidden), inMore: fit.inMore };
  }, [rowRef]);

  const apply = useCallback((next: ToolRowState) => {
    current.current = next;
    setState(next);
  }, []);

  useObserved(rowRef, measure, apply, '[data-header-id]');
  return state;
}

/**
 * Re-measures when the container, the elements `alsoWatch` names, or any item
 * changes size, and when the DOM under the outermost watched element changes
 * (a Trigger pill appearing, a chip the host stops offering, a title renamed).
 * A changed decision renders before the frame paints (flushSync), and that render
 * is measured again by the observers, so the decision converges at once. An
 * unchanged one renders nothing: flushSync would also commit every other update
 * waiting then (the title row's, a neighbour's), and a box above the row changing
 * inside the observer's callback is WebKit's 'ResizeObserver loop' error.
 */
function useObserved<T>(
  ref: RefObject<HTMLElement | null>,
  measure: () => T | null,
  apply: (next: T) => void,
  itemSelector: string,
  alsoWatch?: (el: HTMLElement) => HTMLElement[],
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // In a layout effect the update renders before paint by itself.
    const first = measure();
    if (first !== null) apply(first);
    if (typeof ResizeObserver === 'undefined') return;
    // The observers run after layout and before paint; flushSync renders the new fit in that same
    // frame, so a column that narrows or widens (a draft opening or closing beside it) never paints
    // one frame with the old fit (2026-11-04: a neighbour's tools showed compact, then expanded).
    const fit = () => {
      const next = measure();
      if (next !== null) flushSync(() => apply(next));
    };
    const ro = new ResizeObserver(fit);
    const watched = alsoWatch?.(el) ?? [];
    const observeItems = () => {
      for (const item of el.querySelectorAll<HTMLElement>(itemSelector)) ro.observe(item);
      for (const extra of alsoWatch?.(el) ?? []) ro.observe(extra);
    };
    ro.observe(el);
    observeItems();
    // Mutations are watched from the outermost element (the row when one is
    // named), so a new sibling or a changed title re-measures too.
    const root = watched.find((w) => w.contains(el)) ?? el;
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { observeItems(); fit(); });
    mo?.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { ro.disconnect(); mo?.disconnect(); };
  }, [ref, measure, apply, itemSelector, alsoWatch]);
}
