/**
 * Back where you were after a reload (spec 4.5 "R", C80). iOS throws a hidden
 * tab away, and stale-assets reloads one that was hidden for 20 s after a
 * deploy, so on a phone the first return after a deploy is a cold start. On
 * `pagehide` and on visibility hidden the open session, the timeline's first
 * visible message (an id, never a pixel offset) and the home list's scrollTop
 * are written to sessionStorage['walnut.phoneRestore']; the next boot reopens
 * the session through the deep-link rule (base entry replaced, layer pushed),
 * anchors the timeline on that message, puts the home list back, and deletes
 * the key.
 */
import { useEffect, useRef } from 'react';
import { isPhoneLayout } from './usePhoneLayout';
import { phoneOverlayIds } from './usePhoneOverlayHistory';
import { log } from '@/utils/log';
import { READER_SCROLL_EVENT } from '@/components/sessions/phone-session-layer';

export const PHONE_RESTORE_KEY = 'walnut.phoneRestore';
/** A record older than this belongs to another visit, not to "a moment ago". */
export const PHONE_RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface PhoneRestoreRecord {
  v: 1;
  at: number;
  sessionId: string | null;
  anchorMessageId: string | null;
  homeScrollTop: number;
}

export function parsePhoneRestore(raw: string | null, now: number): PhoneRestoreRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<PhoneRestoreRecord>;
    if (!r || r.v !== 1 || typeof r.at !== 'number') return null;
    if (now - r.at > PHONE_RESTORE_MAX_AGE_MS || r.at - now > 60_000) return null;
    return {
      v: 1,
      at: r.at,
      sessionId: typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null,
      anchorMessageId: typeof r.anchorMessageId === 'string' && r.anchorMessageId ? r.anchorMessageId : null,
      homeScrollTop: typeof r.homeScrollTop === 'number' && Number.isFinite(r.homeScrollTop) && r.homeScrollTop > 0
        ? Math.round(r.homeScrollTop) : 0,
    };
  } catch {
    return null;
  }
}

/** The open session of a layer stack (top-most session layer wins). */
export function sessionFromLayerIds(ids: readonly string[]): string | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    if (id.startsWith('session:')) return id.slice('session:'.length) || null;
  }
  return null;
}

const SESSION_URL_PARAM = /^[st]\d+$/;

/**
 * The home URL a deep-linked session layer goes back to: the same page with
 * the session column params (s1..sN, t1..tN) removed. undefined when the URL
 * opens no session.
 */
export function deepLinkBaseUrl(href: string): string | undefined {
  let u: URL;
  try { u = new URL(href); } catch { return undefined; }
  if (u.pathname !== '/') return undefined;
  const keys = [...u.searchParams.keys()];
  if (!keys.some((k) => /^s\d+$/.test(k))) return undefined;
  const sp = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!SESSION_URL_PARAM.test(k)) sp.append(k, v);
  const q = sp.toString();
  return `/${q ? `?${q}` : ''}`;
}

/** The home list's scroll box (the navigation layout or the plain list). */
export function homeScroller(): HTMLElement | null {
  const boxes = document.querySelectorAll<HTMLElement>('.main-page-todo .home-navigation-scroll, .main-page-todo .todo-panel-list');
  for (const el of boxes) if (el.scrollHeight > el.clientHeight + 1) return el;
  return boxes[0] ?? null;
}

/** First message whose top is inside the open session's timeline. */
export function firstVisibleMessageId(sessionId: string): string | null {
  const panel = document.querySelector<HTMLElement>(`.session-panel[data-session-id="${CSS.escape(sessionId)}"]`);
  const scroller = panel?.querySelector<HTMLElement>('.session-history');
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > top + 1) return el.dataset.messageId ?? null;
  }
  return null;
}

export function readPhoneRestore(): PhoneRestoreRecord | null {
  try { return parsePhoneRestore(sessionStorage.getItem(PHONE_RESTORE_KEY), Date.now()); } catch { return null; }
}

export function clearPhoneRestore(): void {
  try { sessionStorage.removeItem(PHONE_RESTORE_KEY); } catch { /* storage off */ }
}

export function savePhoneRestore(): void {
  if (!isPhoneLayout()) return;
  const sessionId = sessionFromLayerIds(phoneOverlayIds());
  const rec: PhoneRestoreRecord = {
    v: 1,
    at: Date.now(),
    sessionId,
    anchorMessageId: sessionId ? firstVisibleMessageId(sessionId) : null,
    homeScrollTop: homeScroller()?.scrollTop ?? 0,
  };
  try { sessionStorage.setItem(PHONE_RESTORE_KEY, JSON.stringify(rec)); } catch { /* storage off */ }
}

/** Resolve when `get()` returns something, polling each frame, or null at the deadline. */
function waitFor<T>(get: () => T | null, ms: number, cancelled: () => boolean): Promise<T | null> {
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (cancelled()) { resolve(null); return; }
      const v = get();
      if (v) { resolve(v); return; }
      if (performance.now() > end) { resolve(null); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function anchorTimeline(sessionId: string, messageId: string): boolean {
  const panel = document.querySelector<HTMLElement>(`.session-panel[data-session-id="${CSS.escape(sessionId)}"]`);
  const scroller = panel?.querySelector<HTMLElement>('.session-history');
  const el = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!scroller || !el) return false;
  const r = el.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  if (r.top >= s.top - 1 && r.top < s.bottom - 40) return true;
  // The reader's own place, not an echo the timeline should undo.
  scroller.dispatchEvent(new Event(READER_SCROLL_EVENT));
  scroller.scrollTop += r.top - s.top - 8;
  return true;
}

export interface UsePhoneRestoreOptions {
  /** The home list has its rows (tasks loaded). */
  ready: boolean;
  isSessionOpen: (sessionId: string) => boolean;
  openSession: (sessionId: string) => void;
}

/** Save on hide, restore once on boot (phone layout only). */
export function usePhoneRestore(o: UsePhoneRestoreOptions): void {
  const recRef = useRef<PhoneRestoreRecord | null | undefined>(undefined);
  if (recRef.current === undefined) recRef.current = isPhoneLayout() ? readPhoneRestore() : null;
  const optsRef = useRef(o);
  optsRef.current = o;

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') savePhoneRestore();
      // Back without a reload: the record was for a reload that did not happen.
      else if (recRef.current === null) clearPhoneRestore();
    };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) clearPhoneRestore(); };
    window.addEventListener('pagehide', savePhoneRestore);
    window.addEventListener('pageshow', onShow);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', savePhoneRestore);
      window.removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    const rec = recRef.current;
    if (!rec || !o.ready) return undefined;
    let cancelled = false;
    const isCancelled = () => cancelled;
    void (async () => {
      // StrictMode runs this effect twice in a row: only the run that survives
      // one microtask acts (an open is not idempotent).
      await Promise.resolve();
      if (cancelled) return;
      recRef.current = null;
      const { sessionId, anchorMessageId, homeScrollTop } = rec;
      if (sessionId && !optsRef.current.isSessionOpen(sessionId)) optsRef.current.openSession(sessionId);
      if (homeScrollTop > 0) {
        const box = await waitFor(() => {
          const h = homeScroller();
          return h && h.scrollHeight - h.clientHeight >= homeScrollTop - 1 ? h : null;
        }, 8000, isCancelled);
        if (box) box.scrollTop = homeScrollTop;
      }
      if (sessionId && anchorMessageId) {
        const ok = await waitFor(() => (anchorTimeline(sessionId, anchorMessageId) ? true : null), 10_000, isCancelled);
        // The timeline settles in steps (cache, then the fetch): hold the anchor.
        for (const delay of [250, 800, 1600]) {
          await new Promise((r) => setTimeout(r, delay));
          if (cancelled) break;
          anchorTimeline(sessionId, anchorMessageId);
        }
        log.info('phone-restore', 'restored', { sessionId, anchorMessageId, anchored: !!ok, homeScrollTop });
      } else {
        log.info('phone-restore', 'restored', { sessionId, homeScrollTop });
      }
      clearPhoneRestore();
    })();
    return () => { cancelled = true; };
  }, [o.ready]);
}
