/**
 * The two pills a phone stacks above the composer (spec 4.5, 4.7; C35, C65,
 * C70), both sticky at the bottom of the timeline's own scroller:
 *
 * - The jump button is the shared ScrollToBottomButton (no second jump
 *   control): on a phone its badge counts the rows that arrived below the last
 *   one you had when you scrolled away (`Scroll to bottom, <n> new`).
 * - The prompt pill, `1 prompt waiting` / `N prompts waiting`, shows while the
 *   first unanswered card is out of view or the keyboard is up; a tap brings
 *   the card into view. It sits 8 px above the jump pill when both show.
 *
 * Both read the DOM of the scroller they live in, so they count exactly what
 * the timeline draws.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type RefObject } from 'react';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { ScrollToBottomButton, setJumpHidden } from '@/components/common/ScrollToBottomButton';

const ROW_SELECTOR = '[data-msg-role]';
const PROMPT_SELECTOR = '[data-prompt-pending="true"]';

/** Observe the scroller's subtree and its scroll; `read` recomputes. */
function useScrollerWatch(ref: RefObject<HTMLElement | null>, active: boolean, read: () => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; read(); });
    };
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-prompt-pending'] });
    el.addEventListener('scroll', schedule, { passive: true });
    const kb = new MutationObserver(schedule);
    kb.observe(document.documentElement, { attributes: true, attributeFilter: ['data-wn-keyboard'] });
    schedule();
    return () => {
      mo.disconnect();
      kb.disconnect();
      el.removeEventListener('scroll', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, active, read]);
}

/**
 * The jump button's phone count: rows that arrived below the last one on screen when the button
 * appeared (`3 new`), and N30, stepping aside while it would sit on an unanswered prompt card.
 */
export function useJumpCount(containerRef: RefObject<HTMLElement | null>, buttonRef: RefObject<HTMLElement | null>, visible: boolean): number {
  const phone = usePhoneLayout();
  const [count, setCount] = useState(0);
  const lastSeen = useRef<Element | null>(null);

  // The last row on screen when the button appeared: every row after it is new.
  useEffect(() => {
    if (!phone) return;
    if (!visible) { lastSeen.current = null; setCount(0); return; }
    const el = containerRef.current;
    const rows = el?.querySelectorAll(ROW_SELECTOR);
    lastSeen.current = rows && rows.length ? rows[rows.length - 1]! : null;
  }, [phone, visible, containerRef]);

  const read = useCallback(() => {
    const el = containerRef.current;
    // N30: the button steps aside while it would sit on an unanswered prompt card's
    // buttons (the card is what needs the tap; the bottom is a few pixels away).
    const btn = buttonRef.current;
    if (el && btn) {
      const over = overlapsPrompt(btn, el);
      if (over !== btn.hasAttribute('data-over-prompt')) {
        btn.toggleAttribute('data-over-prompt', over);
        // Stepped aside is hidden for the keyboard and screen readers too, not only the eye.
        setJumpHidden(btn, over);
      }
    }
    const seen = lastSeen.current;
    if (!el || !seen || !seen.isConnected) { setCount(0); return; }
    let n = 0;
    for (const row of el.querySelectorAll(ROW_SELECTOR)) {
      if (row === seen || row.contains(seen) || seen.contains(row)) continue;
      // eslint-disable-next-line no-bitwise
      if (seen.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) n += 1;
    }
    setCount(n);
  }, [containerRef, buttonRef]);
  useScrollerWatch(containerRef, phone && visible, read);

  useEffect(() => {
    if (visible) return;
    buttonRef.current?.removeAttribute('data-over-prompt');
  }, [visible, buttonRef]);

  return phone ? count : 0;
}

/** Whether the pill's box crosses an unanswered prompt card in the scroller. */
export function overlapsPrompt(pill: Element, scroller: Element): boolean {
  const p = pill.getBoundingClientRect();
  if (p.width === 0 || p.height === 0) return false;
  for (const card of scroller.querySelectorAll(PROMPT_SELECTOR)) {
    const r = card.getBoundingClientRect();
    if (r.bottom > p.top && r.top < p.bottom && r.right > p.left && r.left < p.right) return true;
  }
  return false;
}

export function promptsWaitingLabel(n: number): string {
  return `${n} prompt${n === 1 ? '' : 's'} waiting`;
}

/**
 * A card counts as seen when its answer buttons are (N2-11: a card cut off at
 * the bottom showed its title and no Allow / Deny, and no pill either), or when
 * the user is reading it: half the card, or half the timeline, is on screen
 * (R3-08: a tall question card filled the view and the pill sat on its fields).
 */
export function promptCardSeen(card: DOMRect, lastButton: DOMRect | null, box: DOMRect): boolean {
  const target = lastButton ?? card;
  if (target.top >= box.top - 1 && target.bottom <= box.bottom + 1) return true;
  const visible = Math.min(card.bottom, box.bottom) - Math.max(card.top, box.top);
  return visible > 0 && visible >= Math.min(card.height, box.height) * 0.5;
}

function inView(card: Element, box: HTMLElement): boolean {
  const buttons = card.querySelectorAll('button');
  const last = buttons.length > 0 ? buttons[buttons.length - 1]!.getBoundingClientRect() : null;
  return promptCardSeen(card.getBoundingClientRect(), last, box.getBoundingClientRect());
}

export function PromptWaitingPill({ containerRef, stacked }: { containerRef: RefObject<HTMLElement | null>; stacked: boolean }) {
  const phone = usePhoneLayout();
  const [state, setState] = useState<{ n: number; show: boolean }>({ n: 0, show: false });
  const read = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cards = el.querySelectorAll(PROMPT_SELECTOR);
    const n = cards.length;
    const keyboard = document.documentElement.dataset.wnKeyboard === 'open';
    const show = n > 0 && (keyboard || !inView(cards[0]!, el));
    setState((s) => (s.n === n && s.show === show ? s : { n, show }));
  }, [containerRef]);
  useScrollerWatch(containerRef, phone, read);

  // A seen pill stays in the timeline, hidden: unmounting it shrank the scroll
  // height (the timeline's flex gap) in the middle of the pill's own smooth
  // scroll, and WebKit stopped that scroll there, the buttons still cut off.
  if (!phone || state.n === 0) return null;
  const go = (e: MouseEvent<HTMLButtonElement>) => {
    // Let go of focus first: the pill hides once the card shows, and React puts
    // focus back on a hidden focused button by restoring its scroller's
    // scrollTop, which stops this smooth scroll halfway (Chromium).
    e.currentTarget.blur();
    const card = containerRef.current?.querySelector<HTMLElement>(PROMPT_SELECTOR);
    // Land with the buttons on screen: the end of a tall card, its top otherwise.
    const buttons = card?.querySelectorAll<HTMLElement>('button');
    const last = buttons && buttons.length > 0 ? buttons[buttons.length - 1]! : null;
    if (last && card && card.getBoundingClientRect().height > (containerRef.current?.clientHeight ?? 0) * 0.8) last.scrollIntoView({ block: 'end', behavior: 'smooth' });
    else card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  return (
    <button
      type="button"
      className={`btn btn-primary phone-prompt-pill${stacked ? ' is-stacked' : ''}${state.show ? '' : ' is-seen'}`}
      data-testid="phone-prompt-pill"
      aria-hidden={state.show ? undefined : true}
      tabIndex={state.show ? undefined : -1}
      onClick={go}
    >
      {promptsWaitingLabel(state.n)}
    </button>
  );
}

/** One boolean the timeline writes and only the pills below read. */
export interface FlagStore {
  get: () => boolean;
  set: (next: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * The jump pill's "is the newest row off screen" flag, held outside the
 * timeline's state: it flips on a scroll (every push and pop of a Question stack
 * lands the page somewhere new), and as timeline state each flip re-rendered the
 * whole transcript for one class name (C38: 13 to 18 ms of main thread a step).
 */
export function useFlagStore(): FlagStore {
  return useMemo(() => {
    let value = false;
    const listeners = new Set<() => void>();
    return {
      get: () => value,
      set: (next: boolean) => {
        if (next === value) return;
        value = next;
        for (const l of listeners) l();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
  }, []);
}

/** The prompt pill and the jump button, at the timeline's bottom. */
export function TimelineBottomPills({ containerRef, arrow, onJump }: {
  containerRef: RefObject<HTMLElement | null>;
  arrow: FlagStore;
  onJump: () => void;
}) {
  const visible = useSyncExternalStore(arrow.subscribe, arrow.get, arrow.get);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const count = useJumpCount(containerRef, buttonRef, visible);
  return (
    <>
      <PromptWaitingPill containerRef={containerRef} stacked={visible} />
      <ScrollToBottomButton
        ref={buttonRef}
        visible={visible}
        onClick={onJump}
        label={count > 0 ? `Scroll to bottom, ${count} new` : 'Scroll to bottom'}
        badge={count > 0 ? count : null}
      />
    </>
  );
}
