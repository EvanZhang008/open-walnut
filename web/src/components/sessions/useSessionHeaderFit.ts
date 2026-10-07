/**
 * Measures the two rows of a session panel's header and decides what each shows
 * (session-header-fit.ts has the rules). Hidden items stay mounted with
 * `data-hidden="true"` (CSS hides them), so the menus that stand in for them
 * can proxy a click to the real element and read its live text.
 *
 * Natural widths are remembered per item and per form (full / short), measured
 * whenever that form is on screen, so the decision never reads the current
 * state: the composer controls row's rule against flicker.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  classifyTitleMetaChild, fitTitleMeta, fitToolRow,
  TITLE_FLOOR_WIDTH, TITLE_MIN_WIDTH, type TitleMetaItem, type TitleMetaKind, type TitleMetaLevel, type ToolItemKind, type ToolRowItem,
} from './session-header-fit';

/** Mirrors `.session-meta-row-2-chips { gap }`, `.session-panel-window-controls { gap }`, `.session-meta-row-2 { gap }`. */
const CHIP_GAP = 6;
const WINDOW_GAP = 3;
const GROUP_GAP = 6;
/** Mirrors `.session-panel-header-top { gap }` and `.session-panel-title-area / -title-meta { gap }`. */
const TITLE_ROW_GAP = 8;
const TITLE_AREA_GAP = 6;
const META_GAP = 3;
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
  plan: { kind: 'chip', priority: 1, name: 'Plan' },
  fork: { kind: 'chip', priority: 2, name: 'Fork' },
  changed: { kind: 'chip', priority: 3, name: 'Changed' },
  files: { kind: 'chip', priority: 4, name: 'Files' },
  board: { kind: 'chip', priority: 5, name: 'Board' },
  terminal: { kind: 'chip', priority: 6, name: 'Terminal' },
  time: { kind: 'info', priority: 7, name: 'Last activity' },
  // Locate, the way back to the task from the Ask and Mail drawers, is the last
  // of the two movable window buttons to leave.
  locate: { kind: 'window', priority: 9, name: 'Locate task' },
  popout: { kind: 'window', priority: 11, name: 'Open in new tab' },
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
 * finds the items itself, so a chip the session does not offer (no Board without
 * a task, no Terminal on a host without SSH) simply is not there.
 */
export function useToolRowFit(rowRef: RefObject<HTMLElement | null>): ToolRowState {
  const widths = useRef(new Map<string, number>());
  const [state, setState] = useState<ToolRowState>(NO_TOOL_FIT);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const items: ToolRowItem[] = [];
    for (const el of row.querySelectorAll<HTMLElement>('[data-header-id]')) {
      const id = el.dataset.headerId!;
      // A wrapper whose component rendered nothing (Fork without a task) is not an item.
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
    if (rowWidth <= 0) return;
    const fit = fitToolRow(items, rowWidth - FIT_SLACK, {
      chipGap: CHIP_GAP, windowGap: WINDOW_GAP, groupGap: GROUP_GAP, moreWidth,
    });
    const hidden = [...fit.inMore, ...fit.dropped];
    setState((prev) => {
      const prevHidden = [...prev.hidden];
      if (sameList(prevHidden, hidden) && sameList(prev.inMore, fit.inMore)) return prev;
      return { hidden: new Set(hidden), inMore: fit.inMore };
    });
  }, [rowRef]);

  useObserved(rowRef, measure, '[data-header-id]');
  return state;
}

export interface TitleMetaState {
  level: TitleMetaLevel;
  /** Pills hidden because even their letters did not fit, by kind (`trigger`, `worker`, ...). */
  hidden: Set<TitleMetaKind | string>;
}

const FULL_META: TitleMetaState = { level: 'full', hidden: new Set() };

export interface TitleMetaFitHandle extends TitleMetaState {
  /** Keep this kind's pill on the row (a kebab row is about to open it, and its
   *  flyout anchors to the pill). Released when the row fits everything again. */
  pin: (kind: TitleMetaKind | string) => void;
}

/**
 * The title row (`.session-panel-header-top`): how the cluster beside the title
 * reads. `metaRef` is `.session-panel-title-meta`; the row is its parent.
 */
export function useTitleMetaFit(metaRef: RefObject<HTMLElement | null>): TitleMetaFitHandle {
  const fullWidths = useRef(new Map<string, number>());
  const shortWidths = useRef(new Map<string, number>());
  const [state, setState] = useState<TitleMetaState>(FULL_META);
  const [pinned, setPinned] = useState<string | null>(null);

  const measure = useCallback(() => {
    const meta = metaRef.current;
    const row = meta?.parentElement;
    if (!meta || !row) return;
    // What the DOM shows right now decides which form a width belongs to. Read
    // from the attributes the render wrote, not from React state: a measurement
    // between a decision and its paint would otherwise file a full-text width
    // under the short form.
    const level = (meta.dataset.fit as TitleMetaLevel | undefined) ?? 'full';
    const hidden = new Set((meta.dataset.hiddenPills ?? '').split(' ').filter(Boolean));
    const items: TitleMetaItem[] = [];
    const kinds = new Map<string, TitleMetaKind>();
    const seen = new Map<TitleMetaKind, number>();
    for (const el of Array.from(meta.children) as HTMLElement[]) {
      const kind = classifyTitleMetaChild(el.classList, el.dataset as { headerPill?: string });
      // One id per child, by KIND (numbered only when a kind repeats), so a pill
      // appearing in front of the others does not hand its neighbours' remembered
      // widths to the wrong element.
      const nth = seen.get(kind) ?? 0;
      seen.set(kind, nth + 1);
      const id = nth === 0 ? kind : `${kind}-${nth}`;
      kinds.set(id, kind);
      if (!hidden.has(kind)) {
        const w = el.getBoundingClientRect().width;
        if (w > 0) {
          const shortForm = (kind === 'status' && level !== 'full')
            || (level === 'letters' && kind !== 'status' && kind !== 'kebab' && kind !== 'other');
          (shortForm ? shortWidths : fullWidths).current.set(id, w);
        }
      }
      items.push({ id, kind, fullWidth: fullWidths.current.get(id), shortWidth: shortWidths.current.get(id) });
    }
    // The room the cluster may take: the row, minus everything before the title
    // (the slot's menu button, the marker, the phase circle, their gaps; read as
    // the title's left edge, so an absolutely placed marker costs nothing), minus
    // the title's reserve, minus any sibling between the title area and the
    // cluster (the thread mode pill).
    const rowBox = row.getBoundingClientRect();
    if (rowBox.width <= 0) return;
    const titleArea = row.querySelector<HTMLElement>(':scope > .session-panel-title-area');
    const title = titleArea?.querySelector<HTMLElement>(':scope > .session-panel-title, :scope > .session-panel-title-input') ?? null;
    let fixed = title ? title.getBoundingClientRect().left - rowBox.left : 0;
    let titleReserve = TITLE_MIN_WIDTH;
    if (title) {
      // A short title does not reserve room it would not use; a title being edited keeps the full reserve.
      const natural = title.classList.contains('session-panel-title') ? title.scrollWidth : TITLE_MIN_WIDTH;
      if (natural > 0) titleReserve = Math.min(TITLE_MIN_WIDTH, natural);
    }
    fixed += titleReserve + TITLE_ROW_GAP;
    for (const sibling of Array.from(row.children) as HTMLElement[]) {
      if (sibling === meta || sibling === titleArea) continue;
      if (sibling.compareDocumentPosition(titleArea ?? meta) & Node.DOCUMENT_POSITION_FOLLOWING) continue; // before the title: in its left edge already
      fixed += sibling.getBoundingClientRect().width + TITLE_ROW_GAP;
    }
    const available = rowBox.width - fixed - FIT_SLACK;
    const fit = fitTitleMeta(items, available, META_GAP, { pinned, dropSlack: Math.max(0, titleReserve - TITLE_FLOOR_WIDTH) });
    const hiddenKinds = fit.hidden.map((id) => kinds.get(id) ?? id);
    const next: TitleMetaState = { level: fit.level, hidden: new Set(hiddenKinds) };
    setState((prev) => (prev.level === next.level && sameList([...prev.hidden], hiddenKinds) ? prev : next));
    // Everything fits again: the pin has nothing to hold open.
    if (hiddenKinds.length === 0 && pinned !== null) setPinned(null);
  }, [metaRef, pinned]);

  useObserved(metaRef, measure, ':scope > *', titleRowOf);
  const pin = useCallback((kind: string) => setPinned((p) => (p === kind ? p : kind)), []);
  return useMemo(() => ({ ...state, pin }), [state, pin]);
}

/** The whole title row, and its title: the row's width, a title that grows (an
 *  auto-title replacing a short one) or turns into an input, a thread mode pill
 *  appearing, all change the cluster's room without touching the cluster. */
const titleRowOf = (meta: HTMLElement): HTMLElement[] => {
  const row = meta.parentElement;
  if (!row) return [];
  return [row, ...Array.from(row.querySelectorAll<HTMLElement>(':scope > *, :scope > .session-panel-title-area > *'))].filter((el) => el !== meta);
};

/**
 * Re-measures when the container, the elements `alsoWatch` names, or any item
 * changes size, and when the DOM under the outermost watched element changes
 * (a Trigger pill appearing, a chip the host stops offering, a title renamed).
 * The measurement's state update renders on React's schedule, and that render
 * is measured again by the observers, so the decision converges in a frame or two.
 */
function useObserved(
  ref: RefObject<HTMLElement | null>,
  measure: () => void,
  itemSelector: string,
  alsoWatch?: (el: HTMLElement) => HTMLElement[],
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
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
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { observeItems(); measure(); });
    mo?.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { ro.disconnect(); mo?.disconnect(); };
  }, [ref, measure, itemSelector, alsoWatch]);
}
