// Controls stay mounted so the add menu can activate their existing handlers and popovers.
import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { detailFits, foldDirectButtons, pickVisibleControls, rowExcess, type ControlFitInput, type RowShape } from './composer-controls-fit';
import { log } from '@/utils/log';
import '@/styles/composer-controls.css';

/** What the row tells the controls on it about the room it has. */
export interface ComposerRowFit {
  /** The row is narrower than its controls' natural widths, so a control shows
   *  its short form (the model pill: the family word instead of the full name). */
  condensed: boolean;
  /** In a condensed row, there is still room for a control's detail, the part
   *  it marks `data-condensed-detail` (the model pill's context percentage).
   *  Always true in a wide row. */
  showDetail: boolean;
}

const ComposerRowFitContext = createContext<ComposerRowFit>({ condensed: false, showDetail: true });

/** A control reads this to pick its form. Outside a ComposerControlsBar (the
 *  lane composer, the draft panel) it is always the full form. */
export function useComposerRowFit(): ComposerRowFit {
  return useContext(ComposerRowFitContext);
}

/** The model pill's short form before it has been measured once ("Opus" at 11px). */
const ASSUMED_SHORT_MODEL_WIDTH = 48;

export interface ComposerControl {
  /** Stable id, also the measurement key. */
  id: string;
  /** What this control IS, for its overflow row ("Reply style", "Model"). A pill
   *  reads by position on the row; a menu row has to name itself. Static on
   *  purpose: the STATE next to it is read from the live pill, so there is no
   *  second copy of "Rich"/"MD" or of the model name to keep in sync. */
  name: string;
  /** 1 leaves the row last. */
  priority: number;
  /** Clicking this control opens a surface anchored to it, so the overflow row
   *  pins it onto the row before clicking (model picker, side-thread drawer). */
  anchored?: boolean;
  inAddMenu?: boolean;
  /** Falsy renders nothing and takes no width (a pill the session hides). */
  node: ReactNode;
}

export interface ComposerControlsBarHandle {
  activate: (id: string) => void;
  state: (id: string) => string;
  button: (id: string) => HTMLButtonElement | null;
  /** True while the row has folded this control's direct button (Note, btw)
   *  back into the "+" menu to keep its own controls on the row. */
  folded: (id: string) => boolean;
}

interface ComposerControlsBarProps {
  controls: ComposerControl[];
  /** Extra classes for the row (callers keep `.session-mode-bar` styling). */
  className?: string;
  /** Lets the add menu activate the mounted control without duplicating its logic. */
  handleRef?: RefObject<ComposerControlsBarHandle | null>;
}

/** Gap between pills — mirrors `.session-mode-bar { gap: 4px }`. */
const ROW_GAP = 4;
/** What the composer's recall line keeps for itself when the row is tight. */
const RECALL_HINT_MIN_PX = 96;
/** The composer's direct buttons beside this row (ComposerDirectControl). */
const DIRECT_BUTTON = '.composer-direct-control';
/** This bar's own controls: its direct children. A control's node can hold a whole
 *  composer of its own (the side-thread drawer opens INSIDE this bar), and a
 *  descendant query would measure that composer's controls as this row's. */
const OWN_CONTROL = ':scope > [data-control-id]';
const ownControl = (id: string) => `:scope > [data-control-id="${id}"]`;

/**
 * The items of the composer row this bar sits in that match `selector`: the row's
 * direct children only, never a descendant. The side-thread drawer's popover lives
 * inside this bar with its own composer (its own spacer, recall line and buttons),
 * which comes first in document order; measuring ITS spacer as this row's made the
 * room depend on this bar's own fold and condense, so the row flipped between the
 * two on every render until React stopped it ("Maximum update depth exceeded",
 * 2026-11-18: clicking btw took the whole session panel down).
 */
function rowItems(row: Element | null | undefined, selector: string): HTMLElement[] {
  if (!row) return [];
  return Array.from(row.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.matches(selector));
}

/** A row that measured more than this many times within BURST_WINDOW_MS is not
 *  settling but flipping: from then on it measures at most once a frame, until a
 *  measure finds the shape it already has. Flipping on every measure would
 *  otherwise loop inside one commit until React throws (it stops at 50 nested
 *  updates); a real settle takes under ten steps (a jump from a wide column to a
 *  very tight one: fold, condense, drop the detail, move a pill). */
const MAX_MEASURES_PER_BURST = 24;
const BURST_WINDOW_MS = 100;

/**
 * The room a flex row of the composer leaves this bar with its direct buttons
 * folded: the row's content width, less every other item on its line (the recall
 * line keeps only its minimum) and the gaps between them. A row that wraps (the
 * browser side panel's composer) shares its room line by line, so only the items
 * on the bar's own line count. Infinity when the bar does not sit in a flex row,
 * so the caller's own measure stands.
 */
function rowRoom(bar: HTMLElement, spacer: HTMLElement | null, hint: HTMLElement | null, gap: number): number {
  const row = bar.parentElement;
  if (!row) return Infinity;
  const style = getComputedStyle(row);
  if (!style.display.includes('flex') || style.flexDirection.startsWith('column')) return Infinity;
  const line = style.flexWrap === 'nowrap' ? null : bar.getBoundingClientRect();
  let used = 0;
  let items = 0;
  for (const child of row.children) {
    const el = child as HTMLElement;
    if (el.matches(DIRECT_BUTTON)) continue;
    const childStyle = getComputedStyle(el);
    if (childStyle.display === 'none' || childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
    if (line && el !== bar) {
      const box = el.getBoundingClientRect();
      if (box.bottom <= line.top + 1 || box.top >= line.bottom - 1) continue;
    }
    items += 1;
    if (el === bar || el === spacer) continue;
    const w = el.getBoundingClientRect().width;
    used += el === hint ? Math.min(w, RECALL_HINT_MIN_PX) : w;
  }
  const content = row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  return content - used - Math.max(0, items - 1) * gap;
}

export function ComposerControlsBar({ controls, className, handleRef }: ComposerControlsBarProps) {
  const routeShown = useContext(RouteShownContext) !== false;
  // On a phone the model pill's percentage gives way before Note and btw fold (foldDirectButtons).
  const phone = usePhoneLayout();
  const shownRef = useRef(routeShown);
  shownRef.current = routeShown;
  const present = useMemo(() => controls.filter((c) => !!c.node), [controls]);
  const inline = useMemo(() => present.filter((c) => !c.inAddMenu), [present]);
  const ids = useMemo(() => present.map((c) => c.id).join('|'), [present]);
  const barRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Last measured natural width per control id; hidden ones keep their last. */
  const widths = useRef(new Map<string, number>());
  /** Last measured width of a control's SHORT form (condensed row, detail excluded). */
  const shortWidths = useRef(new Map<string, number>());
  /** Last measured width of a control's detail, kept while the detail is hidden
   *  so the row can tell when there is room to bring it back. */
  const detailWidths = useRef(new Map<string, number>());
  /** Last measured width of each direct button beside the row, kept while it is
   *  folded so the row can tell when there is room to bring it back. */
  const directWidths = useRef(new Map<string, number>());
  const [folded, setFolded] = useState(false);
  const [overflow, setOverflow] = useState<string[]>([]);
  const overflowRef = useRef(overflow);
  overflowRef.current = overflow;
  const [condensed, setCondensed] = useState(false);
  const [showDetail, setShowDetail] = useState(true);
  const [pinned, setPinned] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const placement = useMenuPlacement(open, buttonRef, menuRef, {
    align: 'right', preferSide: 'up', minHeight: 120,
    onAnchorLost: () => setOpen(false),
  });

  /** Measures in the current burst; while `throttled`, only the one a frame runs (`inFrame`). */
  const burst = useRef({ start: 0, count: 0, deferred: 0, throttled: false, inFrame: false, warned: false });
  const measureRef = useRef<() => void>(() => {});

  const measure = useCallback(() => {
    const bar = barRef.current;
    if (!bar || !shownRef.current) return;
    const b = burst.current;
    const now = performance.now();
    if (now - b.start > BURST_WINDOW_MS) { b.start = now; b.count = 0; }
    if (!b.throttled && ++b.count > MAX_MEASURES_PER_BURST) {
      b.throttled = true;
      if (!b.warned) {
        b.warned = true;
        log.warn('composer', 'controls row kept changing its shape; measuring once a frame', { folded, condensed, showDetail });
      }
    }
    if (b.throttled && !b.inFrame) {
      if (!b.deferred) {
        b.deferred = requestAnimationFrame(() => {
          b.deferred = 0;
          b.inFrame = true;
          try { measureRef.current(); } finally { b.inFrame = false; }
        });
      }
      return;
    }
    for (const el of bar.querySelectorAll<HTMLElement>(OWN_CONTROL)) {
      const id = el.dataset.controlId!;
      const w = el.getBoundingClientRect().width;
      if (w <= 0) continue;
      if (!condensed) { widths.current.set(id, w); continue; }
      // A condensed row shows each control's short form, with or without its
      // detail. Record the two natural widths apart, so the decision below
      // never depends on which of them happens to be on the row right now.
      const detail = el.querySelector<HTMLElement>('[data-condensed-detail]');
      const detailW = detail?.getBoundingClientRect().width ?? 0;
      if (detailW > 0) detailWidths.current.set(id, detailW);
      // No detail while the row is showing details = the control has none any
      // more (the percentage went away); a remembered width would still be
      // charged to it and could push it into the menu for nothing.
      else if (showDetail) detailWidths.current.delete(id);
      shortWidths.current.set(id, w - detailW);
    }
    const spacer = rowItems(bar.parentElement, '.chat-input-controls-spacer')[0];
    // The composer's recall line ("2 of 15 back") gives its room up
    // first: it cuts its own words short rather than fold these controls.
    const hint = rowItems(bar.parentElement, '.chat-recall-hint')[0];
    const yielded = hint ? Math.max(0, hint.getBoundingClientRect().width - RECALL_HINT_MIN_PX) : 0;
    const available = bar.getBoundingClientRect().width + (spacer?.getBoundingClientRect().width ?? 0) + yielded;
    // The direct buttons (Note, btw) give their room up before a control leaves
    // the row or loses its detail. Their room is what they take while shown: their
    // remembered widths and a gap each. Only a button whose control is mounted
    // counts; the others take no room either way.
    const controlsRow = bar.parentElement;
    const rowGap = controlsRow ? parseFloat(getComputedStyle(controlsRow).columnGap) || 0 : 0;
    let directRoom = 0;
    for (const el of rowItems(controlsRow, DIRECT_BUTTON)) {
      const id = el.dataset.addControl ?? '';
      if (!bar.querySelector(`${ownControl(id)} button`)) continue;
      const w = el.getBoundingClientRect().width;
      if (w > 0) directWidths.current.set(id, w);
      const known = directWidths.current.get(id);
      if (known) directRoom += known + rowGap;
    }
    // The room the row would have with the buttons folded: the same number
    // whether they are folded now or not, so the decision cannot blink. Capped by
    // what the row itself leaves once its other items are placed: in a row that
    // overflows, the bar's box cannot shrink below its contents and reports room
    // the row does not have, and folding would then take that room back and give
    // it again on every frame.
    const roomFolded = Math.min(folded ? available : available + directRoom, rowRoom(bar, spacer ?? null, hint ?? null, rowGap));
    const naturalWidth = inline.reduce((total, control) => total + (widths.current.get(control.id) ?? 64), 0)
      + Math.max(0, inline.length - 1) * ROW_GAP;
    const buttonWidth = buttonRef.current?.getBoundingClientRect().width || 22;
    // A control's short width before the condensed row has been measured once:
    // the model pill as one family word.
    const assumedShort = (c: ComposerControl): number | undefined =>
      c.id === 'model' ? ASSUMED_SHORT_MODEL_WIDTH : widths.current.get(c.id);
    const shortOf = (c: ComposerControl) => shortWidths.current.get(c.id) ?? assumedShort(c) ?? 64;
    const rowShort = inline.reduce((total, c) => total + shortOf(c), 0) + Math.max(0, inline.length - 1) * ROW_GAP;
    const detailTotal = inline.reduce((total, c) => total + (detailWidths.current.get(c.id) ?? 0), 0);
    /** The row's shape in `room` px: condensed or not, with or without the detail
     *  (the model pill's percentage rides along only when the whole row still fits
     *  with it), and which controls go into the "..." menu. */
    const shapeIn = (room: number): RowShape & { compact: boolean } => {
      // Short forms only when the full ones do not fit. A fixed floor here (220px)
      // condensed a row that had room for the full name ("Opus 35%" with blank
      // space beside it, 2026-11-22) once the composer got its reading width.
      const compact = room < naturalWidth;
      const withDetail = !compact || detailFits(rowShort, detailTotal, room);
      const input: ControlFitInput[] = inline.map((c) => ({
        id: c.id,
        priority: pinned === c.id ? 0 : c.priority,
        width: compact
          ? shortOf(c) + (withDetail ? detailWidths.current.get(c.id) ?? 0 : 0)
          : widths.current.get(c.id),
      }));
      const options = { gap: ROW_GAP, overflowButtonWidth: buttonWidth };
      const result = pickVisibleControls(input, room, options);
      return { compact, withDetail, overflow: result.overflow, excess: rowExcess(input, result, room, options) };
    };
    // A laid-out row whose direct buttons leave nothing has 1px, not "not laid
    // out yet" (which shows every control and lets the buttons crush them).
    const shown = shapeIn(roomFolded > 0 ? Math.max(1, roomFolded - directRoom) : roomFolded - directRoom);
    const foldedShape = directRoom > 0 ? shapeIn(roomFolded) : shown;
    // A row with no room (not laid out yet, or hidden for a moment by a reflow) decides
    // nothing: its shape there means "show all", so the buttons keep where they are.
    const fold = roomFolded > 0 ? directRoom > 0 && foldDirectButtons(shown, foldedShape, { detailFirst: phone }) : folded;
    const next = fold ? foldedShape : shown;
    // The shape held: measures run as they come again.
    if (b.throttled && fold === folded && next.compact === condensed && next.withDetail === showDetail
      && next.overflow.length === overflowRef.current.length && next.overflow.every((id, i) => id === overflowRef.current[i])) {
      b.throttled = false;
      b.count = 0;
    }
    setFolded((prev) => prev === fold ? prev : fold);
    setCondensed((prev) => prev === next.compact ? prev : next.compact);
    setShowDetail((prev) => prev === next.withDetail ? prev : next.withDetail);
    setOverflow((prev) => (prev.length === next.overflow.length && prev.every((id, i) => id === next.overflow[i])
      ? prev : next.overflow));
    // Everything fits again: drop the pin, so a column that grew goes back to
    // the plain priority order instead of remembering one menu click forever.
    if (next.overflow.length === 0) setPinned((p) => (p === null ? p : null));
  }, [inline, pinned, condensed, showDetail, folded, phone]);
  measureRef.current = measure;
  useEffect(() => () => {
    cancelAnimationFrame(burst.current.deferred);
    burst.current.deferred = 0;
  }, []);

  useLayoutEffect(() => {
    if (!routeShown) return;
    measure();
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    // Measured on the next frame, never inside the observer's callback: condensing the
    // row there resizes what it watches and leaves its notifications undelivered.
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    ro.observe(bar);
    // The row only shrinks when the space around it does, and its own box stops
    // changing once it has collapsed — watch the whole controls row too.
    if (bar.parentElement) ro.observe(bar.parentElement);
    for (const el of bar.querySelectorAll<HTMLElement>(OWN_CONTROL)) ro.observe(el);
    // A direct button that appears (its control mounted late) takes room the row
    // has to hear about even when the row's own box does not change.
    for (const el of rowItems(bar.parentElement, DIRECT_BUTTON)) ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
    // `ids` covers "a control appeared or disappeared"; `measure` covers the rest.
  }, [measure, ids, routeShown]);

  useOverlayLayer({
    passOutsideClick: true,
    open,
    refs: [menuRef, buttonRef],
    onClose: (reason) => {
      setOpen(false);
      if (reason === 'escape') buttonRef.current?.focus({ preventScroll: true });
    },
  });

  // The control you last touched stays on the row (priority 0) until the column
  // grows enough for everything or you touch another one. Two things need it: a
  // picker portalled to <body> anchors to its pill, so hiding that pill during a
  // resize would leave the picker pointing at a zero rect; and a control you just
  // used is the one you are most likely to use again.
  const pinTouched = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement | null;
    // A press inside a nested composer (the side-thread drawer's) is that composer's.
    if (target?.closest?.('.chat-input-box') !== barRef.current?.closest('.chat-input-box')) return;
    const el = target?.closest?.('[data-control-id]') as HTMLElement | null;
    const id = el?.parentElement === barRef.current ? el?.dataset.controlId : undefined;
    if (id) setPinned((p) => (p === id ? p : id));
  }, []);

  const activate = useCallback((control: ComposerControl) => {
    const click = () => {
      const el = barRef.current?.querySelector<HTMLElement>(ownControl(control.id));
      (el?.querySelector<HTMLElement>('button, [role="button"]') ?? el)?.click();
    };
    if (control.inAddMenu) { click(); return; }
    if (!control.anchored) { click(); return; }
    setPinned(control.id);
    setOpen(false);
    requestAnimationFrame(() => requestAnimationFrame(click));
  }, []);

  useImperativeHandle(handleRef, () => ({
    activate: (id) => {
      const control = present.find((c) => c.id === id);
      if (control) activate(control);
    },
    button: (id) => barRef.current?.querySelector<HTMLButtonElement>(`${ownControl(id)} button`) ?? null,
    folded: (id) => folded && present.some((c) => c.id === id),
    state: (id) => {
      const button = barRef.current?.querySelector<HTMLElement>(`${ownControl(id)} button`);
      const ariaLabel = button?.getAttribute('aria-label');
      return id === 'output' ? ariaLabel?.replace(/^Output mode: /, '') ?? '' : ariaLabel ?? button?.textContent?.trim() ?? '';
    },
  }), [present, activate, folded]);

  const hidden = new Set(overflow);
  const fit = useMemo<ComposerRowFit>(() => ({ condensed, showDetail: condensed ? showDetail : true }), [condensed, showDetail]);
  return (
    <>
      <div
        ref={barRef}
        className={`composer-controls-bar${className ? ` ${className}` : ''}${condensed ? ' is-condensed' : ''}`}
        data-direct-folded={folded ? 'true' : undefined}
        onPointerDownCapture={pinTouched}
      >
        <ComposerRowFitContext.Provider value={fit}>
          {present.map((c) => (
            <span
              key={c.id}
              className="composer-control"
              data-control-id={c.id}
              data-hidden={hidden.has(c.id) || c.inAddMenu ? 'true' : 'false'}
              data-add-menu={c.inAddMenu ? 'true' : undefined}
            >
              {c.node}
            </span>
          ))}
        </ComposerRowFitContext.Provider>
        {overflow.length > 0 && (
          <button
            ref={buttonRef}
            type="button"
            className="btn btn-icon btn-sm composer-overflow-btn"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`More controls (${overflow.length})`}
            title="More controls"
            data-testid="composer-overflow-btn"
          >
            <span aria-hidden="true">···</span>
          </button>
        )}
      </div>
      {open && createPortal(
        <div
          ref={menuRef}
          className="composer-overflow-menu wn-overlay wn-menu"
          role="menu"
          style={menuPlacementStyle(placement)}
          // Portals escape clipping, not bubbling: without this the composer's
          // own drag/pointer handlers see these clicks.
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="composer-overflow-menu"
        >
          {overflow.map((id) => {
            const control = present.find((c) => c.id === id);
            if (!control) return null;
            return <OverflowRow key={id} control={control} barRef={barRef} onActivate={activate} />;
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * One menu row: the control's name, plus whatever its hidden pill currently
 * says. The state half is read from the DOM on open (and whenever the pill's
 * text changes) so the row cannot drift from the control: no second copy of
 * "Rich"/"MD", of the model name, or of the context percentage to keep in sync.
 */
function OverflowRow({ control, barRef, onActivate }: {
  control: ComposerControl;
  barRef: React.RefObject<HTMLDivElement | null>;
  onActivate: (control: ComposerControl) => void;
}) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    const el = barRef.current?.querySelector<HTMLElement>(ownControl(control.id));
    if (!el) return;
    const read = () => setLabel((el.textContent ?? '').replace(/\s+/g, ' ').trim());
    read();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(read);
    mo.observe(el, { subtree: true, characterData: true, childList: true });
    return () => mo.disconnect();
  }, [barRef, control.id]);
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // A control that shows its own name plus a count ("Side chat 2") keeps only the count.
  const value = !label || norm(label) === norm(control.name) ? ''
    : label.startsWith(control.name) ? label.slice(control.name.length).trim() : label;
  return (
    <button
      type="button"
      className="composer-overflow-item"
      role="menuitem"
      onClick={() => onActivate(control)}
      data-testid={`composer-overflow-item-${control.id}`}
    >
      <span className="composer-overflow-item-name">{control.name}</span>
      {value && <span className="composer-overflow-item-value">{value}</span>}
    </button>
  );
}
