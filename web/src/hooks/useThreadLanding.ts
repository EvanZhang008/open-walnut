/**
 * Where a stack page lands (spec 5.5; C4, C40, C51). Runs in the timeline, next
 * to the scroll container and the passage locator.
 *
 * Leaving a page records `{scrollTop, sentenceTop}` (the passage the next page
 * hangs off, relative to the scroll box). Coming back, BEFORE PAINT, the page
 * gets its scrollTop, the passage is measured again and corrected once, then
 * flashed. Never a smooth scroll. Only when the row is not loaded or the drift
 * stays over 8px does it fall back to `jumpToPlace(..., { armBack: false })`,
 * which loads the full history first and never arms the outline's Back. A
 * passage that cannot be found (rewritten by /compact) lands on the answer row
 * and says so.
 *
 * Also: the push / pop slide on the SAME scroll box (no DOM copy), first entry
 * at the top, and the page's scroll remembered 300ms after scrolling stops.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { SessionPinnedQuote } from '@/types/session';
import type { ThreadStackApi } from '@/contexts/SessionThreadsContext';
import type { ThreadPendingPage, ThreadToastApi } from '@/components/sessions/thread-ui-contract';
import type { ThreadTree } from '@/utils/thread-tree';
import { isPendingKey, landingCorrection, landingTarget, needsFallbackJump, type PageLanding } from '@/utils/thread-stack-state';
import { flashRange } from '@/utils/pin-highlights';
import { log } from '@/utils/log';

export const PASSAGE_GONE_TEXT = "Couldn't find the exact passage. Showing the answer it came from.";

type Passage = { msgId: string; quote?: SessionPinnedQuote };

export interface UseThreadLandingArgs {
  sessionId: string;
  enabled: boolean;
  /**
   * Conversation Mode: the stack path is the composer's TARGET, not a page, so a
   * navigation (an Ask, a sidebar row, a turn label, a drawer row) must never
   * move the timeline. Without this every push landed "a first entry at the
   * top" and the whole conversation jumped to its first message (2026-09-30).
   */
  targetOnly: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  stack: ThreadStackApi;
  tree: ThreadTree;
  locatePassage: (p: Passage) => Range | null;
  jumpToPlace: (msgId: string, quote: SessionPinnedQuote | undefined, via: string, opts?: { armBack?: boolean }) => void;
  toast: ThreadToastApi;
  isAtBottom: MutableRefObject<boolean>;
}

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Re-apply `top` every frame until the box can hold it (up to 3s), unless the
 *  reader scrolls first. Returns the cleanup. */
export function holdScroll(el: HTMLElement, top: number, ms = 3000): () => void {
  let raf = 0;
  let stopped = false;
  const until = performance.now() + ms;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    for (const t of HOLD_STOPPERS) el.removeEventListener(t, stop);
  };
  for (const t of HOLD_STOPPERS) el.addEventListener(t, stop, { passive: true });
  const tick = () => {
    if (stopped) return;
    el.scrollTop = top;
    if (Math.abs(el.scrollTop - top) <= 1 || performance.now() > until) { stop(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
const HOLD_STOPPERS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** The page slide (C44): push 220ms from the right, pop 180ms from the left,
 *  reduced motion a 120ms fade. Web Animations on the scroll box itself. */
function slide(el: HTMLElement, direction: 'push' | 'pop') {
  if (typeof el.animate !== 'function') return;
  if (prefersReducedMotion()) {
    el.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
    return;
  }
  if (direction === 'push') {
    el.animate(
      [{ transform: 'translateX(24px)', opacity: 0.6 }, { transform: 'translateX(0)', opacity: 1 }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  } else {
    el.animate([{ transform: 'translateX(-16px)' }, { transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

/** Where the reader's view starts inside the scroll box: 8px down, or just
 *  under the panel's glass header on the root page, where the transcript runs
 *  under it and the box's top padding is the header's room. */
export function visibleTopOf(el: HTMLElement): number {
  const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
  return Math.max(8, pad - 4);
}

function rowOf(el: HTMLElement, msgId: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(msgId)}"]`);
}

function rangeTop(el: HTMLElement, range: Range | null): number | undefined {
  const rect = range?.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return undefined;
  return rect.top - el.getBoundingClientRect().top;
}

export function useThreadLanding(args: UseThreadLandingArgs): void {
  const { enabled, containerRef, stack } = args;
  const argsRef = useRef(args);
  argsRef.current = args;
  /** The passage each page was left for (the pending page's lives only here). */
  const passages = useRef(new Map<string, Passage>());

  const passageOf = useCallback((childKey: string, pending?: ThreadPendingPage): Passage | undefined => {
    if (pending && pending.pageKey === childKey) {
      return { msgId: pending.parentMsgId, ...(pending.quote ? { quote: pending.quote } : {}) };
    }
    const node = argsRef.current.tree.byKey.get(childKey);
    if (node?.parent) return { msgId: node.parent, ...(node.quote ? { quote: node.quote } : {}) };
    return undefined;
  }, []);

  // Capture: the page being left, right before its rows are swapped out.
  // Registered whether or not the stack is on: the very first Ask in a session
  // without questions (or an Ask from Conversation Mode) leaves root while the
  // stack is still off, and the way back needs root's place.
  useEffect(() => {
    stack.setCapture((from, to, pending) => {
      const el = containerRef.current;
      if (!el) return;
      const rec: PageLanding = { scrollTop: el.scrollTop, boxTop: el.getBoundingClientRect().top };
      const passage = passageOf(to, pending);
      if (passage && rowOf(el, passage.msgId)) {
        const top = rangeTop(el, argsRef.current.locatePassage(passage));
        if (top !== undefined) rec.sentenceTop = top;
        passages.current.set(from, passage);
      }
      argsRef.current.stack.landings.set(from, rec);
    });
    return () => stack.setCapture(null);
  }, [stack, containerRef, passageOf]);

  /** Coming back to `to` from `child`: restore, measure, correct once, flash. */
  const landPop = useCallback((el: HTMLElement, to: string, child: string) => {
    const a = argsRef.current;
    const rec = a.stack.landings.get(to);
    const passage = passageOf(child) ?? passages.current.get(to);
    if (rec) el.scrollTop = rec.scrollTop;
    if (!passage) return;
    const row = rowOf(el, passage.msgId);
    const via = `stack-pop:${to || 'root'}`;
    if (!row) { a.jumpToPlace(passage.msgId, passage.quote, via, { armBack: false }); return; }
    let range = a.locatePassage(passage);
    let top = rangeTop(el, range);
    if (top === undefined && passage.quote) {
      // Passage gone (a rewrite): the answer it came from, flashed, and a word why.
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - visibleTopOf(el);
      row.classList.add('user-messages-highlight');
      setTimeout(() => row.classList.remove('user-messages-highlight'), 1500);
      a.toast.show({ text: PASSAGE_GONE_TEXT, ms: 4000 });
      log.info('threads', 'pop landing: passage not found, landed on the answer', { sessionId: a.sessionId, msgId: passage.msgId });
      return;
    }
    if (top === undefined) return;
    const target = (rec ? landingTarget(rec, el.getBoundingClientRect().top, el.clientHeight) : undefined) ?? Math.max(0, el.clientHeight / 3);
    const want = { scrollTop: el.scrollTop, sentenceTop: target };
    const delta = landingCorrection(want, top) ?? 0;
    if (Math.abs(delta) > 0.5) el.scrollTop += delta;
    range = a.locatePassage(passage);
    top = rangeTop(el, range);
    // Only when the position would otherwise stay off, or the passage cannot be
    // measured any more (and there was a place to go back to): the full jump,
    // Back unarmed. The same rule the unit tier pins (needsFallbackJump).
    const measured = top !== undefined;
    if (rec?.sentenceTop !== undefined && needsFallbackJump(measured ? landingCorrection(want, top) : null, measured)) {
      a.jumpToPlace(passage.msgId, passage.quote, via, { armBack: false });
      return;
    }
    if (range) flashRange(range);
  }, [passageOf]);

  // Land before paint on every navigation, and on the way back from Show all in
  // order (the page he left, at the scroll he left it: no slide, no flash).
  // A fresh navigation lands even when the stack is off in this commit: Esc out
  // of the first Ask's pending page pops to root AND ends the stack at once.
  // Mounted with the stack off, an old navigation is not fresh (a remount must
  // not replay it over the usual scroll to the bottom).
  const wasEnabled = useRef(enabled);
  const handledSeq = useRef<number | undefined>(enabled ? undefined : stack.nav?.seq);
  const targetOnly = args.targetOnly;
  useLayoutEffect(() => {
    const nav = stack.nav;
    const el = containerRef.current;
    const reenabled = enabled && !wasEnabled.current;
    wasEnabled.current = enabled;
    if (!el) return;
    const fresh = !!nav && nav.seq !== handledSeq.current;
    if (nav) handledSeq.current = nav.seq;
    // A target change is not a page change: consumed (so a later switch to Tree
    // Mode does not replay it) and otherwise ignored.
    if (targetOnly) return;
    if (!enabled && !fresh) return;
    if (!fresh || !nav) {
      const rec = reenabled ? stack.landings.get(stack.currentKey) : undefined;
      if (!rec) return;
      argsRef.current.isAtBottom.current = false;
      el.scrollTop = rec.scrollTop;
      return holdScroll(el, rec.scrollTop);
    }
    argsRef.current.isAtBottom.current = false;
    if (nav.direction !== 'none') slide(el, nav.direction);
    if (nav.direction === 'pop') {
      const child = nav.popped[nav.popped.length - 1];
      if (child) landPop(el, nav.to, child);
      return;
    }
    const rec = stack.landings.get(nav.to);
    if (nav.firstEntry || !rec) {
      el.scrollTop = 0;
      return;
    }
    el.scrollTop = rec.scrollTop;
    // The page's rows can arrive a commit later (a reload restore, or rows revealed
    // into the render window): hold the position until the box is tall enough.
    if (Math.abs(el.scrollTop - rec.scrollTop) > 1) return holdScroll(el, rec.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per navigation
  }, [stack.nav?.seq, enabled, targetOnly]);

  // Scroll memory: 300ms after scrolling stops, this page's scrollTop is saved
  // (and the stack persisted, so a reload lands here).
  const currentKey = stack.currentKey;
  useEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const s = argsRef.current.stack;
        if (isPendingKey(currentKey) && currentKey !== s.currentKey) return;
        s.landings.set(currentKey, { scrollTop: el.scrollTop });
        s.persist();
      }, 300);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(timer); el.removeEventListener('scroll', onScroll); };
  }, [enabled, containerRef, currentKey]);

  useEffect(() => { passages.current.clear(); }, [args.sessionId]);
}
