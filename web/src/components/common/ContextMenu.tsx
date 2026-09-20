/**
 * ContextMenu — Walnut's OWN right-click menu, for any surface that is an app
 * object rather than a document (tabs, rows, icons, message bubbles).
 *
 * Why a shared one: four surfaces had each hand-rolled a portal + clamp + Escape
 * + backdrop (notes tree, session file tree, code view, calendar), and every new
 * surface either copied ~80 lines or shipped the browser menu instead. This is
 * the same behaviour once:
 *
 *   · placed by `useMenuPlacement` (measured flip + viewport clamp + height cap,
 *     so a long menu near the bottom edge scrolls instead of hanging off it),
 *   · portalled to <body> so a scroll container can't clip it,
 *   · a backdrop that swallows the NEXT right-click too (a second right-click
 *     elsewhere moves the menu instead of stacking two),
 *   · Escape / outside-click / scroll dismissal — a cursor anchor is a frozen
 *     viewport point, so once the page scrolls it no longer points at its row,
 *   · arrow-key + Home/End navigation with Enter to run the focused item.
 *
 * `useContextMenu` is the call-site half: it holds the target and applies the
 * keep-the-native-menu rules (`utils/context-menu.ts`). Typical use is two lines:
 *
 *   const menu = useContextMenu<Row>()
 *   <div onContextMenu={(e) => menu.open(e, row)} />
 *   {menu.state && <ContextMenu point={menu.state.point} items={…} onClose={menu.close} />}
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import {
  keepNativeContextMenu,
  normalizeContextMenuItems,
  selectionForGesture,
  type ContextMenuItem,
  type PressSelection,
} from '@/utils/context-menu';

export { normalizeContextMenuItems };
export type { ContextMenuItem };

export interface ContextMenuPoint {
  x: number;
  y: number;
}

interface ContextMenuProps {
  point: ContextMenuPoint;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Accessible name — say what the menu acts on ("Note tab actions"). */
  ariaLabel?: string;
  testId?: string;
  /**
   * Extra class on the box, for a surface that wants ONE width for every object it opens on.
   *
   * The default box is content-sized between `min-width` and `max-width`, which is right for a menu
   * whose rows are all labels; it is wrong where a row carries the object's own title, because then the
   * panel edge moved by up to 105px between two right-clicks in one triage pass (measured on a mail
   * list) and a flipped-left menu moved every item's x with it.
   */
  className?: string;
  /**
   * The element the gesture started on, refocused when ESCAPE closes the menu.
   *
   * Without it `document.activeElement` was `<body>` after Escape, so a keyboard user's place in a
   * fifty-row list restarted at the top of the document. Escape only, deliberately: an outside click has
   * already focused what it landed on, an item can open a composer or navigate, and a window blur means
   * focus left the window. See the Escape handler for what that narrowness is protecting.
   */
  returnFocus?: HTMLElement | null;
}

/**
 * Which rows the highlight walks, which now INCLUDES the disabled ones.
 *
 * A disabled item carries the reason it is disabled, and that reason used to ride in `title` alone: a
 * mouse could hover it, a keyboard could never reach it, so four greyed-out lines on a send-less account
 * read as inactive with no reachable explanation. The highlight is a class plus `aria-activedescendant`
 * on the container rather than DOM focus, so a `disabled` button can hold it perfectly well; only
 * RUNNING one is refused (`canRunItem`).
 */
export const contextMenuNavigable = (item: ContextMenuItem) =>
  !item.divider && !item.section && !item.info && (!!item.onSelect || !!item.disabled);

/** May Enter run this row? The disabled ones are reachable, never runnable. */
export const contextMenuRunnable = (item: ContextMenuItem) =>
  contextMenuNavigable(item) && !item.disabled && !!item.onSelect;

const isFocusable = contextMenuNavigable;
const canRunItem = contextMenuRunnable;

/**
 * Does focus leaving the menu end it? The decision the `onBlur` below makes, on its own so it can be
 * graded without a DOM (this tier has no jsdom, and the answer is the whole rule).
 *
 * Three cases, and only the first closes. A real element outside the menu means focus has walked into
 * the page behind (Tab), and leaving the menu mounted there is the failure this exists for: an
 * `inset: 0` backdrop still over everything, swallowing the next click, while the arrow keys steer a
 * menu nothing is focused in. A node INSIDE the menu is ordinary navigation between its own items. A
 * null `relatedTarget` means focus went nowhere, which is exactly what pressing a <button> does in
 * WebKit (macOS does not focus buttons on mousedown), so closing on it would unmount the menu between
 * the press and the click on every single item.
 */
export function closeContextMenuOnBlur(
  next: Node | null,
  menu: { contains(node: Node): boolean } | null,
): boolean {
  if (!next) return false;
  return !menu?.contains(next);
}

/**
 * Does this key move the highlight, and by how much? `0` means it is not ours.
 *
 * TAB IS OURS, and that is the whole point of this function. The items are real `<button>`s, so Tab
 * walked DOM FOCUS through them while the highlight (a class) stayed where the arrows left it: Enter
 * then ran the item the browser had focused and not the one the human could see highlighted, which on
 * a mail row menu is a provider write against the wrong message. Captured here, Tab is just another
 * step of the same single focusIndex, and the two engines stop disagreeing (WebKit's first Tab used to
 * blur the menu and close it, Chromium's walked eight items and closed on the ninth).
 */
export function contextMenuStep(key: string, shift: boolean): number {
  if (key === 'ArrowDown') return 1;
  if (key === 'ArrowUp') return -1;
  if (key === 'Tab') return shift ? -1 : 1;
  return 0;
}

/**
 * Which `info` rows END a run of adjacent info rows, so the run can be drawn as a TITLE BLOCK.
 *
 * A mail row's menu opens with two info lines (the message, then its account), and styled like the rows
 * under them they read as two disabled items: the account line sat 1px above the first action with no
 * rule between them, so the line immediately above the item people aim for looked like a menu line and
 * swallowed the click. The last row of the run carries the rule (see `heading-end` in globals.css).
 */
export function contextMenuHeadingEnds(rows: ContextMenuItem[]): Set<number> {
  const out = new Set<number>();
  rows.forEach((row, index) => {
    if (!row.info) return;
    const next = rows[index + 1];
    if (!next || !next.info) out.add(index);
  });
  return out;
}

/**
 * Where the "why is this disabled" sentence goes: AFTER the last row of each run of adjacent disabled
 * rows that share one reason, as its own row.
 *
 * Drawn once per run, because the three send items share one capability gate and three copies of one
 * sentence is a wall rather than an explanation. Its own row rather than a second line inside the first
 * one, which is what made one of three grouped rows 52px tall next to two 30px siblings, and what
 * indented the sentence 22px for an icon column this menu never draws.
 */
export function contextMenuReasonRows(rows: ContextMenuItem[]): Map<number, string> {
  const out = new Map<number, string>();
  let why = '';
  let at = -1;
  const flush = () => { if (why && at >= 0) out.set(at, why); };
  rows.forEach((row, index) => {
    // A rule or a heading between two disabled rows does not restart the run: they are still the same
    // group as far as the eye is concerned.
    if (row.divider || row.section || row.info) return;
    const next = row.disabled ? (row.title ?? '') : '';
    if (next !== why) { flush(); why = next; at = -1; }
    if (next) at = index;
  });
  flush();
  return out;
}

export function ContextMenu({
  point, items, onClose, ariaLabel, testId, className, returnFocus,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  // useMenuPlacement takes a trigger ref for the button path; a context menu has
  // no trigger element, only the cursor, so the ref stays empty by design.
  const noTrigger = useRef<HTMLElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(-1);
  const rows = useMemo(() => normalizeContextMenuItems(items), [items]);
  // align 'left' = the menu's LEFT edge sits at the cursor and it opens
  // rightward, which is the platform convention (and never covers the row the
  // click landed on). The hook still flips/clamps at the viewport edges.
  const placement = useMenuPlacement(true, noTrigger, menuRef, { anchorPoint: point, align: 'left', gap: 2 });

  // Held in a ref so the Escape handler below does not have to be rebuilt when the prop identity moves.
  const back = useRef<HTMLElement | null>(returnFocus ?? null);
  back.current = returnFocus ?? back.current;

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // Dismissal. Scroll closes outright: the anchor is a viewport point, so after
  // a scroll the menu would describe a row that has moved out from under it.
  //
  // The scroll dismisser arms ONE FRAME LATE, and that delay is load-bearing: it
  // is what stops the menu from dismissing ITSELF on its own opening. Opening a
  // menu re-renders its host row, and when that row lives in a scroll container
  // the commit can clamp the container's scrollTop, which fires `scroll` — so the
  // menu vanished a few milliseconds after it appeared. Measured on the main
  // list's project header (menu mounted at t=4175ms, `scroll` on
  // `.todo-panel-list` at t=4183, menu gone at t=4186), where it surfaced as a
  // right-click that intermittently produced no menu at all, and as a menu whose
  // rows a test could see and then not find. The settle scroll belongs to the
  // mount commit's own frame, so anything arriving in a LATER frame is a real
  // scroll and still closes; a user cannot scroll inside the frame in which their
  // own right-click opened the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
      // ESCAPE ONLY, and that narrowness is the design. Escape is the one dismissal whose whole point is
      // "put me back where I was": without this `document.activeElement` was `<body>`, so a keyboard user
      // in a fifty-row list restarted at the top of the document. The other dismissals must NOT do this:
      // an outside click has already focused whatever it landed on, a window blur means focus left the
      // window, and restoring in an unmount cleanup fires on React's StrictMode double-mount, which
      // focused the row while the menu was still opening and closed the menu through its own `onBlur`.
      // `isConnected`, because a sync can have dropped the row in the meantime.
      const row = back.current;
      if (row?.isConnected) row.focus({ preventScroll: true });
    };
    let scrollArmed = false;
    const arm = requestAnimationFrame(() => { scrollArmed = true; });
    const onScroll = (e: Event) => {
      if (!scrollArmed) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      cancelAnimationFrame(arm);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  // Did the KEYBOARD move the highlight? Only then may the box scroll to it (see the effect below): a
  // hovered item is visible by definition, and scrolling under the pointer moves the row out from under
  // the press that is landing on it.
  const followKey = useRef(false);

  const move = useCallback((delta: number) => {
    followKey.current = true;
    setFocusIndex((current) => {
      const focusables = rows.map((row, index) => (isFocusable(row) ? index : -1)).filter((i) => i >= 0);
      if (!focusables.length) return -1;
      const position = focusables.indexOf(current);
      const next = position === -1
        ? (delta > 0 ? 0 : focusables.length - 1)
        : (position + delta + focusables.length) % focusables.length;
      return focusables[next];
    });
  }, [rows]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const step = contextMenuStep(e.key, e.shiftKey);
    if (step !== 0) { e.preventDefault(); move(step); return; }
    if (e.key === 'Home') {
      e.preventDefault();
      followKey.current = true;
      setFocusIndex(rows.findIndex(isFocusable));
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      followKey.current = true;
      const last = [...rows].reverse().findIndex(isFocusable);
      setFocusIndex(last === -1 ? -1 : rows.length - 1 - last);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const row = rows[focusIndex];
      // A disabled row can hold the highlight (so its reason is reachable) and must not run.
      if (row && isFocusable(row)) {
        e.preventDefault();
        if (!canRunItem(row)) return;
        row.onSelect?.();
        onClose();
      }
    }
  };

  // The highlight stays INSIDE the clamped box. `useMenuPlacement` caps the height in a short window,
  // and the arrows walked the highlight straight off the visible edge: the seventh ArrowDown highlighted
  // an item 7px below the box, End highlighted one 37px below it, `scrollTop` never moved, and Enter then
  // ran an item nobody could see. Scrolled by hand rather than with `scrollIntoView`, which in WebKit
  // walks up and scrolls the page behind a fixed box.
  useLayoutEffect(() => {
    const box = menuRef.current;
    const byKey = followKey.current;
    followKey.current = false;
    // HOVER never scrolls. The item under the pointer is already visible, and a box that nudges itself
    // by a pixel of rounding moves the row out from under the click that is landing on it (measured: a
    // menu press took 1.5s to settle while the pointer and the box chased each other).
    if (!box || focusIndex < 0 || !byKey) return;
    // By ID, never `box.children[focusIndex]`: the box also holds rows that are not items (a title
    // block, a disabled group's reason), so the index of a row in `rows` is not its index in the DOM.
    // An attribute selector rather than `#id`, because `useId` produces ids holding `:`.
    const item = box.querySelector<HTMLElement>(`[id="${itemId(focusIndex)}"]`);
    if (!item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }, [focusIndex]);

  // Is anything past the bottom edge, and is the box already down there? `useMenuPlacement` caps the
  // height, so a short window hid 42% of the items behind a flush-cut border with no scrollbar track,
  // no arrow and no fade: the menu read as one that simply did not have those items. Measured after
  // every placement change, because the cap is what creates the overflow.
  const [more, setMore] = useState(false);
  // A LAYOUT effect, so the attribute is on the box in the same paint the capped menu first appears in:
  // measured through a dev server against real data, an ordinary effect left the fade off for the first
  // few frames, which is exactly when somebody is looking at the menu they just opened.
  useLayoutEffect(() => {
    const box = menuRef.current;
    if (!box) return;
    const read = () => {
      const over = box.scrollHeight - box.clientHeight;
      setMore(over > 1 && box.scrollTop < over - 1);
    };
    read();
    // Read again on the next few frames, and whenever the box resizes. The cap arrives from a MEASURED
    // placement, so the effect can run in a commit where `maxHeight` has not become a smaller
    // `clientHeight` yet: a single read then saw no overflow and nothing would ever re-run it, which
    // showed up as the affordance missing about one open in ten.
    let frame = 0;
    let left = 3;
    const tick = () => {
      read();
      if (left > 0) { left -= 1; frame = requestAnimationFrame(tick); }
    };
    frame = requestAnimationFrame(tick);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
    observer?.observe(box);
    box.addEventListener('scroll', read);
    return () => {
      cancelAnimationFrame(frame);
      left = 0;
      observer?.disconnect();
      box.removeEventListener('scroll', read);
    };
  }, [placement, rows.length]);

  // The reason a row is disabled is drawn ONCE per run of adjacent disabled rows that share it: the
  // three send items share one capability gate, and three copies of one sentence is a wall rather than
  // an explanation. Each of those rows still carries it in `title`, so hovering any of them says it too.
  const reasonRows = useMemo(() => contextMenuReasonRows(rows), [rows]);
  // The info rows that close a title block, so the block gets a rule under it (R3-01).
  const headingEnds = useMemo(() => contextMenuHeadingEnds(rows), [rows]);

  const itemId = (index: number) => `${baseId}-item-${index}`;
  // EVERY heading line, so a screen reader hears what the menu is about (a mail row's menu names the
  // message on one line and its account on the next). `info` rows are not focusable, so nothing else
  // would ever announce them.
  const infoIds = rows
    .map((row, index) => (row.info ? `${baseId}-info-${index}` : ''))
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <>
      <div
        className="wn-context-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        // A WHEEL over the page behind CLOSES the menu, which is the same rule the `scroll` listener
        // above already states: the anchor is a frozen viewport point, so once the list moves the menu
        // no longer points at its row. The backdrop is `inset: 0` and takes the wheel before any
        // scroller sees it, so without this a flick over the list neither scrolled the list nor closed
        // the menu and the gesture was silently inert. The menu is a SIBLING of this, so a wheel over
        // the menu itself still scrolls the menu.
        onWheel={onClose}
      />
      <div
        ref={menuRef}
        className={`wn-context-menu${className ? ` ${className}` : ''}`}
        style={menuPlacementStyle(placement)}
        role="menu"
        aria-label={ariaLabel}
        // The container holds focus and the highlight is a class, so the highlighted item has to be
        // NAMED for anything but a sighted user: without this the arrows moved and assistive tech was
        // told nothing at all.
        {...(focusIndex >= 0 ? { 'aria-activedescendant': itemId(focusIndex) } : {})}
        {...(infoIds ? { 'aria-describedby': infoIds } : {})}
        data-testid={testId}
        data-more={more ? 'true' : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        // Focus LEAVING the menu ends it. Tab is answered above now, so this is the backstop for every
        // other way focus can walk out into the page behind while this stays mounted: an `inset: 0`
        // backdrop over everything, swallowing clicks, and arrow keys that no longer reach the menu they
        // are steering. The window's own `blur` (above) does not cover it, because focus never left the
        // window.
        //
        // Which blurs count is `closeContextMenuOnBlur` above, in one place because that is the rule
        // a test can grade.
        onBlur={(e) => {
          if (closeContextMenuOnBlur(e.relatedTarget as Node | null, menuRef.current)) onClose();
        }}
        // A right-click INSIDE the menu must not open the browser's menu on top
        // of ours, and must not close it either (that reads as a mis-click).
        onContextMenu={(e) => e.preventDefault()}
        // Menu-portal hard rule (web/src/AGENTS.md): React events bubble through
        // portals into the OWNING component tree, so without this a press inside
        // the menu reaches a dnd-kit activator row and arms a drag of that row.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {rows.map((row, index) => {
          if (row.divider) return <div key={row.key ?? `div-${index}`} className="wn-context-menu-divider" />;
          if (row.section) {
            return (
              <div key={row.key ?? `sec-${index}`} className="wn-context-menu-section">{row.label}</div>
            );
          }
          if (row.info) {
            return (
              <div
                key={row.key ?? `info-${index}`}
                id={`${baseId}-info-${index}`}
                className={`wn-context-menu-info${headingEnds.has(index) ? ' heading-end' : ''}`}
                // No role of its own, deliberately: `role="menu"` allows only menuitem-ish children, so
                // a `note` here would be an invalid structure. The menu points `aria-describedby` at
                // this line instead, which is what makes a screen reader say what the menu is about.
                title={row.title}
              >
                {row.icon && <span className="wn-context-menu-icon">{row.icon}</span>}
                <span className="wn-context-menu-label">{row.label}</span>
              </div>
            );
          }
          const why = reasonRows.get(index);
          return (
            <Fragment key={row.key ?? `item-${index}`}>
              <button
                id={itemId(index)}
                type="button"
                role="menuitem"
                // OUT of the tab order: Tab is answered above as a step of the same highlight, and a
                // tabbable item is what let DOM focus and the highlight point at different rows.
                tabIndex={-1}
                className={`wn-context-menu-item${row.danger ? ' danger' : ''}${focusIndex === index ? ' focused' : ''}`}
                disabled={row.disabled}
                title={row.title}
                onMouseEnter={() => setFocusIndex(index)}
                onClick={(e) => {
                  e.stopPropagation();
                  row.onSelect?.();
                  onClose();
                }}
              >
                {row.icon && <span className="wn-context-menu-icon">{row.icon}</span>}
                <span className="wn-context-menu-label">{row.label}</span>
              </button>
              {/* WHY the group above is disabled, for anyone not holding a mouse: the reason used to live
                  in `title` alone, so it was a hover tooltip and nothing else. UNDER the group rather than
                  inside its first row, which made one of three grouped rows 52px tall and indented the
                  sentence for an icon column this menu does not draw. Each row still carries it in
                  `title`, so hovering any of them says it too. */}
              {why && (
                <div className="wn-context-menu-reason" data-testid="wn-context-menu-reason">{why}</div>
              )}
            </Fragment>
          );
        })}
      </div>
    </>,
    document.body,
  );
}

export interface ContextMenuState<T> {
  point: ContextMenuPoint;
  payload: T;
  /**
   * The row the gesture started on (the event's `currentTarget`), for `ContextMenu`'s `returnFocus`.
   *
   * Taken here rather than read from `document.activeElement` at mount: a right-press does not focus
   * the element in every engine (WebKit does not focus on mousedown at all), so the active element at
   * mount is usually `<body>` and restoring it would be the bug this exists to fix.
   */
  origin: HTMLElement | null;
}

/**
 * Call-site half of the pair: holds the open menu's cursor point + payload and
 * enforces the native-menu exemptions. `open` returns false when it deliberately
 * let the browser menu through, so a caller can log/branch on it.
 */
/**
 * The selection as the right-press found it, recorded once for the whole app.
 *
 * ONE capture listener, because the answer is a property of the gesture and not of a row: a listener
 * per menu would record the same thing N times. It runs in the capture phase, so it sees the selection
 * BEFORE the press's default action replaces it, which is the entire point (see `selectionForGesture`).
 */
let pressSelection: PressSelection | null = null;
let pressWatched = false;

function watchPressSelection(): void {
  if (pressWatched || typeof document === 'undefined') return;
  pressWatched = true;
  document.addEventListener('pointerdown', () => {
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = selection && !selection.isCollapsed ? selection.toString() : '';
    pressSelection = { text, at: Date.now() };
  }, true);
}

export function useContextMenu<T = undefined>(
  options: { overrideLinks?: boolean; ignorePressSelection?: boolean } = {},
) {
  const { overrideLinks, ignorePressSelection } = options;
  const [state, setState] = useState<ContextMenuState<T> | null>(null);
  // Armed only for surfaces that asked: the listener is harmless, but a surface that never consults
  // the snapshot has no reason to add one.
  useEffect(() => { if (ignorePressSelection) watchPressSelection(); }, [ignorePressSelection]);

  const open = useCallback((event: ReactMouseEvent | MouseEvent, payload: T): boolean => {
    const target = event.target as Element | null;
    const scope = (event.currentTarget as Element | null) ?? null;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const live = selection && !selection.isCollapsed ? selection.toString() : '';
    if (keepNativeContextMenu(target, {
      selectionText: ignorePressSelection
        ? selectionForGesture(live, pressSelection, Date.now())
        : live,
      selectionAnchor: selection?.anchorNode ?? null,
      scope,
      overrideLinks,
    })) {
      return false;
    }
    // A gesture-created selection is also not something to leave lit up behind the menu.
    if (ignorePressSelection && live && !selectionForGesture(live, pressSelection, Date.now())) {
      selection?.removeAllRanges();
    }
    event.preventDefault();
    // Don't let an ancestor row open its own menu for the same click — the
    // innermost surface owns the gesture (nested rows: message inside a column).
    event.stopPropagation();
    setState({
      point: { x: event.clientX, y: event.clientY },
      payload,
      origin: scope instanceof HTMLElement ? scope : null,
    });
    return true;
  }, [overrideLinks]);

  const close = useCallback(() => setState(null), []);

  return { state, open, close, isOpen: state !== null };
}
