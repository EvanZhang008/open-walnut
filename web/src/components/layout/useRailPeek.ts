/**
 * The collapsed rail peeks open: hovering it (or tabbing into it) widens it over the
 * page so every icon shows its name, and leaving puts it back. The page never moves;
 * the wide rail floats over it (sidebar-peek.css). The timing and the rules live in
 * RailPeekController; this hook feeds it the rail's DOM events.
 */
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { RailPeekController, type RailPeekOptions, type RailPeekPhase } from './rail-peek-controller';

export type { RailPeekPhase } from './rail-peek-controller';

const ITEM_SELECTOR = 'a[href], button';
const PIN_SELECTOR = '.sidebar-collapse-btn';
// Focus a closing panel puts back on its rail button (Escape on the bell's panel) is not a
// keyboard visit: it would open the rail and pin it there. Keyboard focus right after
// Escape is that hand-back; any other focus-visible arrival is the keyboard's.
const ESCAPE_HANDBACK_MS = 1000;

/**
 * React bubbles events through portals by the COMPONENT tree, so the rail's handlers also
 * hear its context menu and its slide-out panels. Only events from the rail's own DOM count.
 */
function fromRail(e: React.SyntheticEvent): boolean {
  return e.currentTarget instanceof Node && e.target instanceof Node && e.currentTarget.contains(e.target);
}

function isFocusVisible(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return false; }
}

export function useRailPeek(options: RailPeekOptions) {
  const [state, setState] = useState<{ phase: RailPeekPhase; snap: boolean }>({ phase: 'closed', snap: false });
  const rail = useRef<HTMLElement | null>(null);
  const lastEscape = useRef(0);
  // Where the pointer last was, and whether the latest pointermove actually went somewhere:
  // browsers send moves (and overs) at the same spot when the page changes under a resting pointer.
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const ctl = useRef<RailPeekController | null>(null);
  if (ctl.current === null) {
    ctl.current = new RailPeekController((phase, snap, sync) => {
      // A click's snap commits before the click's own handlers run, so what they measure and
      // open (a popover beside its button, a panel at the rail's edge) sees the narrow rail.
      if (sync) flushSync(() => setState({ phase, snap }));
      else setState({ phase, snap });
    });
  }
  const peek = ctl.current;

  const { enabled, blocked, hold } = options;
  useEffect(() => {
    // A menu that closed under the pointer sends the rail no leave; ask the DOM where the pointer is.
    if (!hold && rail.current) peek.syncHover(rail.current.matches(':hover'));
    peek.setOptions({ enabled, blocked, hold });
  }, [peek, enabled, blocked, hold]);

  // Docking or undocking is the hamburger's own width animation, never a snap.
  useEffect(() => { setState((s) => (s.snap ? { ...s, snap: false } : s)); }, [enabled]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { lastEscape.current = e.key === 'Escape' ? Date.now() : 0; };
    // Capture on window runs before React's root listener, so the rail's onPointerMove reads this move's answer.
    const onMove = (e: PointerEvent) => {
      const last = lastPoint.current;
      moved.current = last !== null && (last.x !== e.clientX || last.y !== e.clientY);
      lastPoint.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointermove', onMove, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointermove', onMove, true);
      peek.dispose();
    };
  }, [peek]);

  const handlers = {
    onPointerEnter(e: React.PointerEvent<HTMLElement>) {
      rail.current = e.currentTarget;
      if (e.pointerType === 'touch' || !fromRail(e)) return;
      peek.pointerEnter();
    },
    // Not filtered: a leave that reaches the rail means the pointer is outside it and its portals.
    onPointerLeave(e: React.PointerEvent<HTMLElement>) {
      if (e.pointerType === 'touch') return;
      peek.pointerLeave();
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      rail.current = e.currentTarget;
      if (e.pointerType === 'touch' || !moved.current || !fromRail(e)) return;
      peek.pointerMove((e.target as Element).closest(ITEM_SELECTOR), e.buttons);
    },
    onFocus(e: React.FocusEvent<HTMLElement>) {
      if (!fromRail(e) || !isFocusVisible(e.target as Element)) return;
      if (Date.now() - lastEscape.current < ESCAPE_HANDBACK_MS) return;
      peek.keyboardFocus();
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
      const target = e.target as Element;
      peek.click(target.closest(ITEM_SELECTOR), target.closest(PIN_SELECTOR) !== null);
    },
  };

  return { phase: state.phase, snap: state.snap, handlers };
}
