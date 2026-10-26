/**
 * The collapsed rail's item peek: hovering (or tabbing to) one icon grows that one item
 * out over the page with its name; the other icons stay plain. RailPeekController owns
 * the rules and timing; this hook feeds it the rail's DOM events and says which row is
 * up. RailItemPill draws it.
 */
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { RailPeekController, type RailPeekOptions } from './rail-peek-controller';

/** The rows that peek: every rail entry (apps, Home's toggles, Org, status items, Voice, the bell). */
export const RAIL_ITEM_SELECTOR = '.sidebar-link';
// Focus a closing panel puts back on its rail button (Escape on the bell's panel) is not a
// keyboard visit. Keyboard focus right after Escape is that hand-back.
const ESCAPE_HANDBACK_MS = 1000;

/**
 * React bubbles events through portals by the COMPONENT tree, so the rail's handlers also
 * hear its pill, its context menu and its slide-out panels. Only events from the rail's
 * own DOM count as rail events.
 */
function fromRail(e: React.SyntheticEvent): boolean {
  return e.currentTarget instanceof Node && e.target instanceof Node && e.currentTarget.contains(e.target);
}

function isFocusVisible(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return false; }
}

function rowOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(RAIL_ITEM_SELECTOR) : null;
}

export interface RailPeekState { item: HTMLElement | null; grow: boolean }

export function useRailPeek(options: RailPeekOptions) {
  const [state, setState] = useState<RailPeekState>({ item: null, grow: false });
  const rail = useRef<HTMLElement | null>(null);
  const pill = useRef<HTMLElement | null>(null);
  const lastEscape = useRef(0);
  // Where the pointer last was, and whether the latest pointermove actually went somewhere:
  // browsers send moves (and overs) at the same spot when the page changes under a resting pointer.
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const ctl = useRef<RailPeekController | null>(null);
  if (ctl.current === null) {
    ctl.current = new RailPeekController((item, grow, sync) => {
      const next = { item: item as HTMLElement | null, grow };
      // A click's close commits before the click's own handlers run, so what they open
      // (a panel at the rail's edge, a popover beside its button) is never under the pill.
      if (sync) flushSync(() => setState(next));
      else setState(next);
    });
  }
  const peek = ctl.current;

  const { enabled, blocked, hold } = options;
  useEffect(() => {
    // A menu that closed under the pointer sends the rail no leave; ask the DOM where the pointer is.
    if (!hold) peek.syncHover(!!(rail.current?.matches(':hover') || pill.current?.matches(':hover')));
    peek.setOptions({ enabled, blocked, hold });
  }, [peek, enabled, blocked, hold]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { lastEscape.current = e.key === 'Escape' ? Date.now() : 0; };
    // Capture on window runs before React's root listener, so the rail's onPointerMove reads this move's answer.
    const onMove = (e: PointerEvent) => {
      const last = lastPoint.current;
      moved.current = last !== null && (last.x !== e.clientX || last.y !== e.clientY);
      lastPoint.current = { x: e.clientX, y: e.clientY };
    };
    // A resize moves the rows under a resting pointer: that pointer's pill goes.
    const onResize = () => peek.reset();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('resize', onResize);
      peek.dispose();
    };
  }, [peek]);

  const handlers = {
    // Entering opens nothing by itself (see pointerMove); a leave that reaches the rail
    // means the pointer is outside the rail and its pill, so it is not filtered.
    onPointerLeave(e: React.PointerEvent<HTMLElement>) {
      if (e.pointerType === 'touch') return;
      peek.pointerLeave();
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      rail.current = e.currentTarget;
      if (e.pointerType === 'touch' || !moved.current || !fromRail(e)) return;
      peek.pointerMove(rowOf(e.target), e.buttons);
    },
    onFocus(e: React.FocusEvent<HTMLElement>) {
      if (!fromRail(e) || !isFocusVisible(e.target as Element)) return;
      if (Date.now() - lastEscape.current < ESCAPE_HANDBACK_MS) return;
      const row = rowOf(e.target);
      if (row) peek.keyboardFocus(row);
      else peek.focusLeft();
    },
    onBlur(e: React.FocusEvent<HTMLElement>) {
      if (!fromRail(e)) return;
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      peek.focusLeft();
    },
    onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
      if (e.key === 'Escape' && fromRail(e)) peek.escape();
    },
    onClickCapture(e: React.MouseEvent<HTMLElement>) {
      if (!fromRail(e)) return;
      peek.click(rowOf(e.target));
    },
    onScroll() { peek.reset(); },
  };

  const pillHandlers = {
    ref: pill,
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      if (e.pointerType !== 'touch') peek.pillHover();
    },
  };

  // The pill's row went away, or the wheel turned on the pill: the rows are leaving the pointer.
  const pillGone = (why: 'gone' | 'wheel') => { if (why === 'gone') peek.drop(); else peek.reset(); };

  return { item: state.item, grow: state.grow, handlers, pillHandlers, pillGone };
}
