/**
 * The ONE way the web app raises a notice outside Walnut's window: a macOS notification the
 * Mac app posts (desktop/NotificationBridge.swift, the `walnutNotify` handler) or a web
 * Notification in a browser. tests/web/notice-single-exit.test.ts fails on a `new
 * Notification(` or a `walnutNotify` post anywhere else.
 *
 * Quiet mode (Walnut's Do Not Disturb: a focus block, macOS Focus mirrored by Rhythm, the
 * person's own toggle) holds EVERY one of them, asks included: what needs the person stays in
 * the bell, the inbox and the page, and nothing pops up outside the window until quiet ends.
 * Then ONE notice says what waited (the one item itself when it is a single one), never one
 * per item (2026-11-17, the user: "why it even send me notification even I am in focus mode").
 * A state not heard from the server yet (the page just loaded) holds too, until it is known.
 * In-window toasts are notify()'s, gated by quietAllowsToast.
 */
import { log } from '@/utils/log';
import { OPEN_CENTER_EVENT } from '@/utils/open-anywhere';
import { currentQuiet, onQuietState } from './quiet';
import { effectiveQuiet, quietLetsTaskThrough, type QuietState } from './quiet-model';
import type { ScopeTaskLookup } from '@open-walnut/focus-scope';

export interface SystemNotice {
  /** One notice per tag: a second post with the same tag replaces it. */
  tag: string;
  title: string;
  body?: string;
  /** Stays on screen until clicked (an approval a script waits on). */
  requireInteraction?: boolean;
  /** A web Notification's click (the Mac app routes its clicks by `nativeId`). */
  onClick?: () => void;
  /** The Mac app's notice id: its click comes back as `walnut:open-approval` with this id. */
  nativeId?: string;
  /** The task it is about: a quiet hold whose scope holds it lets it through (a focus block on it). */
  taskId?: string;
  lookup?: ScopeTaskLookup;
}

/** shown: posted now. held: quiet holds it; the reminder after quiet covers it. off: no way to post. */
export type SystemNoticeResult = 'shown' | 'held' | 'off';

/** The Mac app's id for the one reminder after quiet: its click opens the notification center. */
export const QUIET_CATCHUP_ID = 'quiet-catchup';

interface Handler { postMessage(body: unknown): Promise<unknown> }

export function nativeNoticeHandler(): Handler | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, Handler | undefined> } };
  return w.webkit?.messageHandlers?.walnutNotify ?? null;
}

/** May a notice go outside the window right now? Never during quiet, nor before it is known. */
export function systemNoticeAllowed(q: QuietState, now = Date.now(), n?: Pick<SystemNotice, 'taskId' | 'lookup'>): boolean {
  if (q.unknown) return false;
  return !effectiveQuiet(q, now).active || quietLetsTaskThrough(q, n?.taskId, n?.lookup, now);
}

const held = new Map<string, SystemNotice>();
const shown = new Map<string, Notification>();
/** Something was held by real quiet (not only while the state was unknown): the end says what waited. */
let heldByQuiet = false;

/** The Mac app's post: checks quiet itself, as it may run after a clear (the reminder's id). */
function postNative(native: Handler, n: SystemNotice, q: QuietState): void {
  if (!systemNoticeAllowed(q, Date.now(), n)) return;
  void native.postMessage({ op: 'post', id: n.nativeId, title: n.title, body: n.body ?? '' })
    .then((r) => log.info('notifications', 'system notice posted', { tag: n.tag, result: r as Record<string, unknown> }))
    .catch((err) => log.warn('notifications', 'system notice refused', { tag: n.tag, error: String(err) }));
}

/** Post now under the quiet state `q` that allows it (every caller passes the state it checked). */
function post(n: SystemNotice, q: QuietState): SystemNoticeResult {
  if (!systemNoticeAllowed(q, Date.now(), n)) return 'held';
  const native = nativeNoticeHandler();
  if (native && n.nativeId) {
    // The app posts an id once per run: the reminder's id is taken back first, so a later one shows.
    if (n.nativeId === QUIET_CATCHUP_ID) void native.postMessage({ op: 'clear', id: n.nativeId }).catch(() => null).then(() => postNative(native, n, q));
    else postNative(native, n, q);
    return 'shown';
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 'off';
  try {
    const note = new Notification(n.title, {
      ...(n.body ? { body: n.body } : {}), tag: n.tag, ...(n.requireInteraction ? { requireInteraction: true } : {}),
    });
    if (n.onClick) {
      const click = n.onClick;
      note.onclick = () => { window.focus(); click(); note.close(); };
    }
    shown.set(n.tag, note);
    return 'shown';
  } catch {
    // A browser that refuses notifications from this page.
    return 'off';
  }
}

/** Raise a notice outside the window, or hold it while quiet lasts. */
export function postSystemNotice(n: SystemNotice): SystemNoticeResult {
  const q = currentQuiet();
  if (!systemNoticeAllowed(q, Date.now(), n)) {
    held.set(n.tag, n);
    if (!q.unknown) heldByQuiet = true;
    return 'held';
  }
  // Quiet ended while its event was missed (a dropped socket; effectiveQuiet saw the end time).
  if (held.size > 0) releaseHeldNotices(q);
  return post(n, q);
}

/** Its reason is gone (the approval was answered): take it back, or drop it from what waits. */
export function withdrawSystemNotice(tag: string): void {
  held.delete(tag);
  if (held.size === 0) heldByQuiet = false;
  const note = shown.get(tag);
  if (note) {
    shown.delete(tag);
    try { note.close(); } catch { /* already gone */ }
  }
}

function openCenter(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CENTER_EVENT));
}

/** The one notice after quiet: the item itself when only one waited, else how many and what. */
export function catchUpNotice(items: readonly SystemNotice[]): SystemNotice | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0]!;
  const titles = items.slice(0, 2).map((i) => i.title);
  const more = items.length > 2 ? `, and ${items.length - 2} more` : '';
  return {
    tag: 'walnut-quiet-catchup',
    nativeId: QUIET_CATCHUP_ID,
    title: `${items.length} things waited for you`,
    body: `${titles.join('; ')}${more}. They are in Walnut's notifications.`,
    onClick: openCenter,
  };
}

/**
 * Quiet just ended: the one reminder for what it held. Held only while the state was not
 * known yet (the page just loaded, not in quiet): each goes out as itself, as it would have.
 */
export function releaseHeldNotices(q: QuietState = currentQuiet()): SystemNoticeResult | null {
  if (!systemNoticeAllowed(q)) return null;
  const items = [...held.values()];
  const summary = heldByQuiet;
  held.clear();
  heldByQuiet = false;
  if (!summary) {
    let last: SystemNoticeResult | null = null;
    for (const n of items) last = post(n, q);
    return last;
  }
  const one = catchUpNotice(items);
  return one ? post(one, q) : null;
}

/** What quiet holds now (tests and the reminder). */
export function heldSystemNotices(): SystemNotice[] {
  return [...held.values()];
}

onQuietState((state) => {
  if (held.size > 0 && systemNoticeAllowed(state)) releaseHeldNotices(state);
});
