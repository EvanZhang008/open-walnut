/**
 * The question toast (spec 6.8): rendered INSIDE the session panel that acted,
 * just above its composer, centered, unless that spot covers the rows that just
 * changed or the drawer's rows (then beside the drawer, or at the top of the
 * transcript: utils/thread-toast-place.ts), never in the global NotificationToaster
 * (that queue is shared with permission and cron toasts and sits over the third
 * column). One toast per panel: a newer one replaces it (the old action counts
 * as committed). Hover pauses the timer. It never takes focus and binds no
 * Cmd+Z (the composer's own undo keeps working).
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { ThreadToastApi, ThreadToastInput } from '@/components/sessions/thread-ui-contract';
import { THREAD_OVERLAY_ATTR } from '@/components/sessions/ThreadConfirm';
import { log } from '@/utils/log';
import { placeToast, type PlaceBox, type ToastPlace } from '@/utils/thread-toast-place';
import { visibleTopOf } from '@/hooks/useThreadLanding';
import '@/styles/thread-stack.css';

const NOOP_API: ThreadToastApi = {
  show: (t) => log.info('threads', 'toast without a provider', { text: t.text }),
  dismiss: () => {},
};

const ThreadToastContext = createContext<ThreadToastApi>(NOOP_API);

/** The toast api of the panel this component is inside. */
export function useThreadToast(): ThreadToastApi {
  return useContext(ThreadToastContext);
}

interface ShownToast extends ThreadToastInput {
  id: number;
}

/** Gap kept between the toast and the composer's top edge. */
const COMPOSER_GAP = 8;
/** Bottom offset when no composer is mounted (read-only panel). */
const DEFAULT_BOTTOM = 16;

export interface ThreadToastProviderProps {
  panelRef: RefObject<HTMLElement | null>;
  composerRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function ThreadToastProvider({ panelRef, composerRef, children }: ThreadToastProviderProps) {
  const [toast, setToast] = useState<ShownToast | null>(null);
  const seq = useRef(0);

  const show = useCallback((t: ThreadToastInput) => {
    seq.current += 1;
    setToast({ ...t, id: seq.current });
  }, []);
  const dismiss = useCallback(() => setToast(null), []);
  const api = useMemo<ThreadToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ThreadToastContext.Provider value={api}>
      {children}
      {toast && (
        <ThreadToastView key={toast.id} toast={toast} panelRef={panelRef} composerRef={composerRef} onDone={dismiss} />
      )}
    </ThreadToastContext.Provider>
  );
}

/**
 * The toast's timer, paused while hovered. `running` guards both ends: a
 * pointerenter that lands before the timer started (the toast mounted under a
 * resting pointer) must not subtract "now minus 0" and end the toast at once,
 * and a second enter must not count the same stretch twice. Pure for tests.
 */
export function toastClock(ms: number): { start: (now: number) => number; pause: (now: number) => void } {
  let remaining = ms;
  let startedAt = 0;
  let running = false;
  return {
    start(now) { running = true; startedAt = now; return Math.max(0, remaining); },
    pause(now) {
      if (!running) return;
      running = false;
      remaining -= now - startedAt;
    },
  };
}

/** Distance from the panel's bottom edge to just above the composer. Pure for tests. */
export function toastBottomOffset(panel: DOMRect | null, composer: DOMRect | null): number {
  if (!panel || !composer || composer.height === 0) return DEFAULT_BOTTOM;
  return Math.max(DEFAULT_BOTTOM, Math.round(panel.bottom - composer.top + COMPOSER_GAP));
}

/** What the toast must leave visible: the rows that just changed and the
 *  drawer's rows (capped, so a huge tree costs a bounded measure). */
const AVOID_SELECTOR = '.thread-asked-row, .thread-strip, .thread-drawer .thread-tree-row';
/** Never covered while another spot is clear of it (N14). */
const HARD_SELECTOR = '.thread-drawer[data-state="open"] .thread-drawer-head';
const MAX_AVOID = 120;

function boxOf(r: DOMRect): PlaceBox {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function measureToastPlace(panel: HTMLElement, toastSize: { width: number; height: number }, composer: HTMLElement | null): ToastPlace {
  const panelBox = boxOf(panel.getBoundingClientRect());
  const history = panel.querySelector<HTMLElement>('.session-history');
  const drawer = panel.querySelector<HTMLElement>('.thread-drawer[data-state="open"] .thread-drawer-body');
  const view = history ? boxOf(history.getBoundingClientRect()) : panelBox;
  const avoid: PlaceBox[] = [];
  for (const node of Array.from(panel.querySelectorAll<HTMLElement>(AVOID_SELECTOR)).slice(0, MAX_AVOID)) {
    const r = boxOf(node.getBoundingClientRect());
    // A transcript row only counts where the scroll box shows it.
    const clip = history && history.contains(node) ? view : panelBox;
    const top = Math.max(r.top, clip.top);
    const bottom = Math.min(r.bottom, clip.bottom);
    if (bottom > top) avoid.push({ left: r.left, right: r.right, top, bottom });
  }
  const hard = Array.from(panel.querySelectorAll<HTMLElement>(HARD_SELECTOR)).map((n) => boxOf(n.getBoundingClientRect()));
  const composerRect = composer?.getBoundingClientRect();
  return placeToast({
    hard,
    panel: panelBox,
    composer: composerRect && composerRect.height > 0 ? boxOf(composerRect) : null,
    // Where reading starts, not the box edge: on the root page the transcript runs
    // under the glass session header and the box's top padding is that header.
    contentTop: history ? history.getBoundingClientRect().top + visibleTopOf(history) : panelBox.top,
    toast: toastSize,
    drawer: drawer ? boxOf(drawer.getBoundingClientRect()) : null,
    avoid,
  });
}

function ThreadToastView({ toast, panelRef, composerRef, onDone }: {
  toast: ShownToast;
  panelRef: RefObject<HTMLElement | null>;
  composerRef?: RefObject<HTMLElement | null>;
  onDone: () => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [bottom, setBottom] = useState(DEFAULT_BOTTOM);
  const [place, setPlace] = useState<ToastPlace | null>(null);
  const toastRef = useRef<HTMLDivElement | null>(null);
  const natural = useRef<{ width: number; height: number } | null>(null);
  const clock = useRef(toastClock(toast.ms));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    setHost(panel);
    if (!panel) return;
    setBottom(toastBottomOffset(panel.getBoundingClientRect(), composerRef?.current?.getBoundingClientRect() ?? null));
  }, [panelRef, composerRef]);

  // Place it where it covers the least of what just changed (N14). The rows
  // settle a frame or two after the action (Done pops the page, the takeaway
  // line mounts, the landing scrolls), so the spot is re-measured then too.
  useLayoutEffect(() => {
    const el = toastRef.current;
    if (!host || !el) return;
    // Placed on the toast's NATURAL size, read once before any max-width: a
    // spot that narrows the toast must not change the input of the next
    // measure, or the toast flips between two spots forever (it never holds
    // still long enough to be clicked).
    const measure = () => {
      if (!natural.current) natural.current = { width: el.offsetWidth, height: el.offsetHeight };
      setPlace(measureToastPlace(host, natural.current, composerRef?.current ?? null));
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const late = setTimeout(measure, 300);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(host);
    ro?.observe(el);
    return () => { cancelAnimationFrame(raf); clearTimeout(late); ro?.disconnect(); };
  }, [host, composerRef]);

  const start = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onDoneRef.current(), clock.current.start(Date.now()));
  }, []);
  const pause = useCallback(() => {
    clearTimeout(timer.current);
    clock.current.pause(Date.now());
  }, []);

  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
  }, [start]);

  if (!host) return null;
  const action = toast.action;
  return createPortal(
    <div
      className="thread-toast"
      role="status"
      aria-live="polite"
      {...{ [THREAD_OVERLAY_ATTR]: 'toast' }}
      ref={toastRef}
      style={place ? { top: place.top, left: place.centerX, bottom: 'auto', ...(place.maxWidth ? { maxWidth: place.maxWidth } : {}) } : { bottom }}
      onPointerEnter={pause}
      onPointerLeave={start}
      onPointerDown={(e) => e.stopPropagation()}
      // Never take focus from the composer or the tree.
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <span className="thread-toast-text">{toast.text}</span>
      {action && (
        <button
          type="button"
          className="thread-toast-action"
          onClick={(e) => { e.stopPropagation(); onDoneRef.current(); action.run(); }}
        >
          {action.label}
        </button>
      )}
    </div>,
    host,
  );
}
