/**
 * Back where you were after a reload (spec 4.5 "R", C80). iOS throws a hidden
 * tab away, and stale-assets reloads one that was hidden for 20 s after a
 * deploy, so on a phone the first return after a deploy is a cold start. On
 * `pagehide` and on visibility hidden the open session and the home list's
 * scrollTop are written to sessionStorage['walnut.phoneRestore']; the next boot
 * reopens the session through the deep-link rule (base entry replaced, layer
 * pushed), puts the home list back, and deletes the key.
 *
 * Where the reader was in the session's timeline is the reading place's
 * (components/sessions/reading-place.ts), kept for every box and every reload:
 * its rows, and whether the reader was at the end. This hook once anchored the
 * timeline on its first visible message too, over the reading place, and a
 * reader at the end came back with that message at the top: the end of the chat
 * (the workers line under a lead's chat) sat under the composer (2026-11-25, 390px).
 */
import { useEffect, useRef } from 'react';
import { isPhoneLayout } from './usePhoneLayout';
import { phoneOverlayIds } from './usePhoneOverlayHistory';
import { log } from '@/utils/log';

export const PHONE_RESTORE_KEY = 'walnut.phoneRestore';
/** A record older than this belongs to another visit, not to "a moment ago". */
export const PHONE_RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface PhoneRestoreRecord {
  v: 1;
  at: number;
  sessionId: string | null;
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
      const { sessionId, homeScrollTop } = rec;
      if (sessionId && !optsRef.current.isSessionOpen(sessionId)) optsRef.current.openSession(sessionId);
      if (homeScrollTop > 0) {
        const box = await waitFor(() => {
          const h = homeScroller();
          return h && h.scrollHeight - h.clientHeight >= homeScrollTop - 1 ? h : null;
        }, 8000, isCancelled);
        if (box) box.scrollTop = homeScrollTop;
      }
      log.info('phone-restore', 'restored', { sessionId, homeScrollTop });
      clearPhoneRestore();
    })();
    return () => { cancelled = true; };
  }, [o.ready]);
}
