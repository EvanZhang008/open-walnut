/**
 * The question map: the conversation's question tree, always on screen in the
 * timeline's top-left corner (spec slice 1b). It answers "does this conversation
 * have questions, how do they nest, which are open, where am I" without a hover
 * or a click, and one click on a row goes there.
 *
 * Two shapes over the same rows (`utils/thread-map.ts`):
 *  - `panel`: the labelled tree in a gutter the scroll box reserves for it, so no
 *    text ever runs under it;
 *  - `rail`: for a box too narrow to spare that gutter (or when the user hid the
 *    map), one small mark per row in the left padding, the tree's shape at a
 *    glance. Hovering, focusing or tapping it opens the same labelled tree over
 *    the text, the way the outline rail always has; leaving closes it.
 *
 * Sticky INSIDE the scroll container, like the outline it replaces in a session
 * with questions: it rides the scroll without stacking over the panel header,
 * the composer or the drawer, which own their own layers.
 *
 * Keyboard: the whole map is ONE tab stop (the panel's current row by default,
 * the rail itself in the rail shape, whose ArrowDown enters its list); arrows
 * walk the head's buttons, the rows and Back in order, Home/End jump to the
 * first/last row. A close that took the focused element away (Esc, a row opened
 * from the rail's list, hide / keep open) hands focus to the rail or to the
 * control that undoes it, never to <body>.
 */
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent,
  type RefObject,
} from 'react';
import { ThreadStatusWord } from '@/components/sessions/ThreadStatusWord';
import { ThreadChevronIcon, ThreadListIcon, ThreadPinIcon } from '@/components/sessions/ThreadIcons';
import { answeredAgo } from '@/components/sessions/ThreadTreeRows';
import { mapOverlayWidth, mapStep, onPathIds, railMarks, type ThreadMapShape } from '@/utils/thread-map';
import { openChipCount, pluralQuestions, toggleLabel, type ThreadCounts } from '@/utils/thread-meta-counts';
import type { TreeRow } from '@/utils/thread-tree-rows';
import '@/styles/thread-map.css';

export interface ThreadMapProps {
  shape: ThreadMapShape;
  /** The box could hold the panel: the rail's list offers `Keep the map open`. */
  roomy: boolean;
  /** The timeline's scroll box: the map never grows past its visible height. */
  scrollerRef: RefObject<HTMLElement | null>;
  /** The scroll box's width, px: the rail's list never runs past it. */
  boxWidth: number;
  /** The panel shape's width, px (0 for the rail): decides whether the status
   *  word fits beside the titles. */
  panelWidth: number;
  rows: TreeRow[];
  counts: ThreadCounts;
  unreadKeys: ReadonlySet<string>;
  answeredAt: ReadonlyMap<string, number>;
  /** A pin jump from the map is restorable. */
  canGoBack: boolean;
  onBack: () => void;
  onActivate: (row: TreeRow) => void;
  onOpenList: () => void;
  onCollapse: (collapsed: boolean) => void;
}

/** Close-out delay: a diagonal path from the rail to a row leaves the map for a
 *  frame and would close it under the cursor (the outline rail's number). */
const CLOSE_DELAY_MS = 140;

/** A click the keyboard made (Enter / Space on a button): no pointer, detail 0.
 *  Only a keyboard user is handed focus after a close; a mouse click that focused
 *  a row (Chromium does, WebKit does not) must not leave the rail holding focus,
 *  where Space would open the list instead of scrolling the timeline. */
const byKeyboard = (e: { detail: number }) => e.detail === 0;

/** Focus without letting the browser scroll anything: focus() scrolls every
 *  scroller up the chain to reveal its target, the timeline included, and the
 *  reading position must not move for a focus in the map. A row is kept in view
 *  inside the map's own list by hand instead. */
function focusInPlace(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  const box = el.closest<HTMLElement>('.thread-map-rows');
  if (!box) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}

/** A labelled row's height (`.thread-map-row`), and what the head, Back and
 *  paddings take of the map's height: rows that fit in the rest never scroll. */
const MAP_ROW_PX = 24;
const MAP_LIST_CHROME_PX = 64;

/**
 * The timeline's visible height (inside its paddings), measured HERE rather than
 * by the timeline: it changes on every push and pop (a page's header and
 * padding differ from the root's), and state held by the timeline would re-render
 * the whole transcript for it. Held by the map, only the map re-renders.
 */
function useVisibleHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const cs = getComputedStyle(el);
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      setHeight(Math.max(120, Math.round(el.clientHeight - pad - 8)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

/** Non-row tab stops (the rows use their encoded id). */
const STOP_LIST = 'head:list';
const STOP_TOGGLE = 'head:toggle';
const STOP_BACK = 'back';

/** What a row is called, for a tooltip and a screen reader. */
function rowName(row: TreeRow): string {
  if (row.kind === 'pin') return `Pinned passage: ${row.tooltip ?? row.title}`;
  if (row.kind === 'done-group' && row.disclosureDisabled) return `${row.title} (holds the page you are on)`;
  if (row.naming) return `${row.title} (naming)`;
  return row.title;
}

/** A row id as an attribute value: a question key holds a NUL (parent + NUL +
 *  passage), which CSS.escape turns into U+FFFD, so a selector built from the
 *  raw id never matches the element it names (the drawer encodes for its ids). */
function rowDomId(id: string): string {
  return encodeURIComponent(id);
}

/** Depth only: a question has a number, not a colour. */
function rowStyle(depth: number): CSSProperties {
  return { '--map-depth': depth } as CSSProperties;
}

/**
 * The leading glyph: the question's NUMBER, the pin icon, or the done group's
 * chevron. A pending or draft question (no number yet) shows a plus. Rows and
 * marks take primitives and are memoized: every push and pop rebuilds the row
 * objects (a new current page), and without this every row and every glyph
 * re-rendered for a change that touches two or three of them.
 */
const Lead = memo(function Lead({ kind, number, expanded }: {
  kind: TreeRow['kind']; number: number | undefined; expanded: boolean;
}) {
  if (kind === 'pin') return <ThreadPinIcon size={11} className="thread-map-pin" />;
  if (kind === 'done-group') {
    return <span className="thread-map-fold" data-open={expanded ? 'true' : undefined}><ThreadChevronIcon size={9} /></span>;
  }
  if (kind === 'root') return <span className="thread-map-root-dot" aria-hidden="true" />;
  // A question being asked has no number yet: a plus in the badge's place (an
  // SVG, so a row's text is its title alone).
  if (kind === 'pending' || kind === 'draft') {
    return (
      <span className="thread-map-num thread-map-num--new" aria-hidden="true">
        <svg viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 1.5v7M1.5 5h7" /></svg>
      </span>
    );
  }
  return <span className="thread-map-num" aria-hidden="true">{number ?? ''}</span>;
});

interface MapRowProps {
  id: string;
  stop: string;
  kind: TreeRow['kind'];
  status: TreeRow['status'];
  current: boolean;
  onPath: boolean;
  expanded: boolean;
  disabled: boolean;
  name: string;
  label: string;
  naming: boolean;
  depth: number;
  number: number | undefined;
  tabIndex: number;
  entry: boolean;
  unread: string | undefined;
  /** Room for the status WORD (else the glyph alone, the word as its tooltip). */
  wide: boolean;
  onFocusStop: (stop: string) => void;
  onClickRow: (id: string, byKey: boolean) => void;
}

const MapRow = memo(function MapRow(r: MapRowProps) {
  return (
    <button
      type="button"
      className="thread-map-row"
      data-map-stop={r.stop}
      data-map-row={r.stop}
      {...(r.entry ? { 'data-map-entry': '' } : {})}
      data-kind={r.kind}
      data-status={r.status}
      data-current={r.current ? 'true' : undefined}
      data-on-path={r.onPath ? 'true' : undefined}
      tabIndex={r.tabIndex}
      aria-current={r.current ? 'page' : undefined}
      aria-expanded={r.kind === 'done-group' ? r.expanded : undefined}
      aria-disabled={r.disabled ? 'true' : undefined}
      aria-label={r.kind === 'pin' ? r.name : undefined}
      title={r.name}
      style={rowStyle(r.depth)}
      onFocus={() => r.onFocusStop(r.stop)}
      onClick={(e) => r.onClickRow(r.id, byKeyboard(e))}
    >
      <span className="thread-map-lead">
        <Lead kind={r.kind} number={r.number} expanded={r.expanded} />
      </span>
      <span className="thread-map-label">{r.label}</span>
      {r.naming && <span className="thread-naming">Naming…</span>}
      {r.kind === 'thread' && (
        <ThreadStatusWord
          status={r.status}
          unread={!!r.unread}
          compact={!r.wide}
          {...(r.unread ? { title: r.unread } : {})}
          className="thread-map-status"
        />
      )}
    </button>
  );
});

interface ListProps extends ThreadMapProps {
  /** Visible height of the timeline, px. */
  maxHeight: number;
  /** Rendered as the rail's overlay (its head offers `Keep the map open`). */
  overlay: boolean;
  /** A row was activated from the overlay: close it. `byKey`: Enter / Space. */
  onDone?: (byKey: boolean) => void;
  /** The head's hide / keep open button was pressed. */
  onToggleShape: (collapsed: boolean, byKey: boolean) => void;
}

/** The labelled tree: head (title, count, list, hide/keep open), rows, Back. */
function MapList(p: ListProps) {
  const { rows } = p;
  const listRef = useRef<HTMLDivElement>(null);
  const onPath = useMemo(() => onPathIds(rows), [rows]);
  const currentId = rows.find((r) => r.current)?.id;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // A move to another page puts the tab stop back on the page you are on.
  useLayoutEffect(() => { setCursor(undefined); }, [currentId]);

  const showToggle = !p.overlay || p.roomy;
  // The status word needs room beside a title: below this width the glyph
  // stands alone and the word is its tooltip.
  const wide = p.overlay || p.panelWidth >= 220;
  const stops = useMemo(() => [
    STOP_LIST, ...(showToggle ? [STOP_TOGGLE] : []), ...rows.map((r) => rowDomId(r.id)), ...(p.canGoBack ? [STOP_BACK] : []),
  ], [showToggle, rows, p.canGoBack]);
  // The one tab stop: where focus last sat, else the current page, else the first
  // row. In the rail's list the rail itself is the map's tab stop (ArrowDown
  // enters the list on this row), so Tab never stops twice in one map.
  const tabStop = (cursor && stops.includes(cursor) ? cursor : undefined)
    ?? (currentId ? rowDomId(currentId) : undefined) ?? (rows[0] ? rowDomId(rows[0].id) : STOP_LIST);
  const tabIndexOf = (stop: string) => (stop === tabStop && !p.overlay ? 0 : -1);
  const entryOf = (stop: string) => (stop === tabStop ? { 'data-map-entry': '' } : {});

  // Keep the current row in view inside the map (never scrollIntoView: that
  // would also scroll the timeline and the home columns around it). A push or
  // pop re-lays the whole timeline out, so this reads layout only when the list
  // can overflow at all, and a frame after the commit rather than inside it,
  // where the read would force that layout early and the landing's own writes
  // would force it again. The box height is a dependency too: a page with a
  // stack header is shorter than the root, so a row in view can fall out of it.
  useEffect(() => {
    if (!currentId || rows.length * MAP_ROW_PX <= p.maxHeight - MAP_LIST_CHROME_PX) return undefined;
    const raf = requestAnimationFrame(() => {
      const box = listRef.current;
      const el = box?.querySelector<HTMLElement>(`[data-map-stop="${CSS.escape(rowDomId(currentId))}"]`);
      if (!box || !el) return;
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top) box.scrollTop -= b.top - r.top;
      else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
    });
    return () => cancelAnimationFrame(raf);
  }, [currentId, p.maxHeight, rows.length]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const root = e.currentTarget;
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-map-stop]'));
    const at = (document.activeElement as HTMLElement | null)?.dataset?.mapStop;
    const rowEls = els.filter((el) => el.dataset.mapRow !== undefined);
    const pool = e.key === 'Home' || e.key === 'End' ? rowEls : els;
    const next = mapStep(pool.map((el) => el.dataset.mapStop ?? ''), at, e.key);
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setCursor(next);
    focusInPlace(pool.find((el) => el.dataset.mapStop === next));
  }, []);

  // Row handlers read the latest props through a ref, so the memoized rows keep
  // one stable pair of callbacks across renders.
  const live = useRef({ p, byId: new Map<string, TreeRow>() });
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  live.current = { p, byId };
  const onFocusStop = useCallback((stop: string) => setCursor(stop), []);
  const onClickRow = useCallback((id: string, byKey: boolean) => {
    const { p: props, byId: rowsById } = live.current;
    const row = rowsById.get(id);
    if (!row || (row.kind === 'done-group' && row.disclosureDisabled)) return;
    if (row.kind !== 'done-group') props.onDone?.(byKey);
    props.onActivate(row);
  }, []);

  const unreadTitle = (row: TreeRow): string | undefined => (
    row.kind === 'thread' && p.unreadKeys.has(row.key)
      ? answeredAgo(p.answeredAt.get(row.key), Date.now()) ?? 'New answer'
      : undefined
  );
  // The header pill's narrow form (the map is always narrow); the full text,
  // counts the narrow form drops included, is the tooltip.
  const count = toggleLabel(p.counts, { narrow: true });
  const fullCount = toggleLabel(p.counts);

  return (
    <div className="thread-map-list" onKeyDown={onKeyDown}>
      <div className="thread-map-head">
        <span className="thread-map-title">Questions</span>
        <span className="thread-map-count" title={fullCount !== count ? fullCount : undefined}
          data-all-done={openChipCount(p.counts) === 0 ? 'true' : undefined}>{count}</span>
        <span className="thread-map-head-actions">
          <button type="button" className="thread-map-icon" title="Open the question list" aria-label="Open the question list"
            data-map-stop={STOP_LIST} {...entryOf(STOP_LIST)} tabIndex={tabIndexOf(STOP_LIST)} onFocus={() => setCursor(STOP_LIST)}
            onClick={(e) => { p.onDone?.(byKeyboard(e)); p.onOpenList(); }}>
            <ThreadListIcon size={13} />
          </button>
          {showToggle && (p.overlay ? (
            <button type="button" className="thread-map-icon thread-map-keep" title="Keep the map open" aria-label="Keep the map open"
              data-map-stop={STOP_TOGGLE} {...entryOf(STOP_TOGGLE)} tabIndex={tabIndexOf(STOP_TOGGLE)} onFocus={() => setCursor(STOP_TOGGLE)}
              onClick={(e) => p.onToggleShape(false, byKeyboard(e))}>
              <ThreadChevronIcon size={10} />
            </button>
          ) : (
            <button type="button" className="thread-map-icon thread-map-hide" title="Hide the map" aria-label="Hide the map"
              data-map-stop={STOP_TOGGLE} {...entryOf(STOP_TOGGLE)} tabIndex={tabIndexOf(STOP_TOGGLE)} onFocus={() => setCursor(STOP_TOGGLE)}
              onClick={(e) => p.onToggleShape(true, byKeyboard(e))}>
              <ThreadChevronIcon size={10} />
            </button>
          ))}
        </span>
      </div>
      <div className="thread-map-rows" ref={listRef}>
        {rows.map((row) => {
          const stop = rowDomId(row.id);
          return (
            <MapRow
              key={row.id}
              id={row.id}
              stop={stop}
              kind={row.kind}
              status={row.status}
              current={row.current}
              onPath={onPath.has(row.id)}
              expanded={row.expanded}
              disabled={row.kind === 'done-group' && row.disclosureDisabled}
              name={rowName(row)}
              label={row.title}
              naming={!!row.naming}
              depth={row.depth}
              number={row.number}
              tabIndex={tabIndexOf(stop)}
              entry={stop === tabStop}
              unread={unreadTitle(row)}
              wide={wide}
              onFocusStop={onFocusStop}
              onClickRow={onClickRow}
            />
          );
        })}
      </div>
      {p.canGoBack && (
        <button type="button" className="thread-map-back" data-map-stop={STOP_BACK} {...entryOf(STOP_BACK)} tabIndex={tabIndexOf(STOP_BACK)}
          onFocus={() => setCursor(STOP_BACK)} onClick={(e) => { p.onDone?.(byKeyboard(e)); p.onBack(); }}>
          Back to where I was
        </button>
      )}
    </div>
  );
}

export const ThreadMap = memo(function ThreadMap(p: ThreadMapProps) {
  const { shape, rows } = p;
  const maxHeight = useVisibleHeight(p.scrollerRef);
  const style = {
    ['--thread-map-maxh' as string]: `${maxHeight}px`,
    ['--thread-map-overlay-w' as string]: `${mapOverlayWidth(p.boxWidth)}px`,
  } as CSSProperties;
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const show = useCallback(() => { clearTimeout(closeTimer.current); setOpen(true); }, []);
  const hide = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);
  const closeNow = useCallback(() => { clearTimeout(closeTimer.current); setOpen(false); }, []);
  const navRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const focusInside = () => !!navRef.current?.contains(document.activeElement);

  // Focus handed to the rail by a close must not reopen the list (the nav opens
  // on focus). Focus events run inside focus(), so the flag spans exactly one.
  const quietFocus = useRef(false);
  const focusRailQuietly = useCallback(() => {
    const rail = railRef.current;
    if (!rail || document.activeElement === rail) return;
    quietFocus.current = true;
    focusInPlace(rail);
    quietFocus.current = false;
  }, []);

  // A shape change (resize, hide / keep open) starts closed; when the button
  // that caused it held focus, focus lands on the control that undoes it.
  const refocusAfterShape = useRef(false);
  const toggleShape = useCallback((collapsed: boolean, byKey: boolean) => {
    refocusAfterShape.current = byKey && focusInside();
    p.onCollapse(collapsed);
  }, [p]);
  useLayoutEffect(() => {
    closeNow();
    if (!refocusAfterShape.current) return;
    refocusAfterShape.current = false;
    if (shape === 'rail') focusRailQuietly();
    else focusInPlace(navRef.current?.querySelector<HTMLElement>('.thread-map-hide'));
  }, [shape, closeNow, focusRailQuietly]);

  // A row (or Back, or the list button) chosen in the rail's list closes it;
  // a keyboard user's focus goes back to the rail.
  const doneFromOverlay = useCallback((byKey: boolean) => {
    const refocus = byKey && focusInside();
    closeNow();
    if (refocus) focusRailQuietly();
  }, [closeNow, focusRailQuietly]);

  // A tap opened it (no pointer to leave with): a press anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && navRef.current?.contains(e.target)) return;
      closeNow();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, closeNow]);

  if (shape === 'panel') {
    return (
      <nav ref={navRef} className="thread-map" data-shape="panel" aria-label="Questions map" style={style}>
        <div className="thread-map-body"><MapList {...p} maxHeight={maxHeight} overlay={false} onToggleShape={toggleShape} /></div>
      </nav>
    );
  }

  // ArrowDown on the rail goes into its list, on the row that holds the tab stop.
  const enterList = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    show();
    const nav = e.currentTarget.closest('.thread-map');
    requestAnimationFrame(() => focusInPlace(nav?.querySelector<HTMLElement>('.thread-map-overlay [data-map-entry]')));
  };
  const room = Math.max(0, maxHeight - 12);
  const { marks, more } = railMarks(rows, room);
  return (
    <nav
      ref={navRef}
      className={`thread-map${open ? ' is-open' : ''}`}
      data-shape="rail"
      aria-label="Questions map"
      style={style}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={() => { if (!quietFocus.current) show(); }}
      onBlur={hide}
      onKeyDown={(e) => {
        // Esc closes the list first; the page's own Esc (pop) waits for the next one.
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        doneFromOverlay(true);
      }}
    >
      <div className="thread-map-body">
        <button
          ref={railRef}
          type="button"
          className="thread-map-rail"
          // Explicit: WebKit (the Mac app) leaves a bare <button> out of the Tab
          // order, and the rail is the map's one tab stop in this shape.
          tabIndex={0}
          // The drawer's edge peek never arms over the rail (or its open list).
          {...(open ? {} : { 'data-thread-rail': '' })}
          aria-expanded={open}
          aria-label={`Questions map: ${pluralQuestions(p.counts.all)}`}
          // Opens only: hovering already opened it for a mouse, and the list covers
          // the rail, so a toggle here would only ever close it under a tap.
          onClick={show}
          onKeyDown={enterList}
        >
          {marks.map((row) => (
            <span
              key={row.id}
              className="thread-map-mark"
              data-kind={row.kind}
              data-status={row.status}
              data-current={row.current ? 'true' : undefined}
              data-unread={row.kind === 'thread' && p.unreadKeys.has(row.key) ? 'true' : undefined}
              style={rowStyle(row.depth)}
            >
              <Lead kind={row.kind} number={row.number} expanded={row.expanded} />
            </span>
          ))}
          {more > 0 && <span className="thread-map-mark thread-map-mark--more">+{more}</span>}
        </button>
      </div>
      {open && (
        <div className="thread-map-overlay" data-thread-rail="">
          <MapList {...p} maxHeight={maxHeight} overlay onDone={doneFromOverlay} onToggleShape={toggleShape} />
        </div>
      )}
    </nav>
  );
});
