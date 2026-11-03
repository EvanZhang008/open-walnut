/**
 * The system notification for an approval a script waits on: "Approve? <what>", whose click
 * brings Walnut forward with that request open (approvals-store.ts openApproval).
 *
 *  - In the Mac app: a macOS notification posted by the app (desktop/NotificationBridge.swift,
 *    the `walnutNotify` handler); its click comes back as the `walnut:open-approval` event.
 *    The app posts one notice per approval however many of its windows ask.
 *  - In a browser: a web Notification (a macOS one in Safari and Chrome on a Mac) once the
 *    person allowed them, whether or not the tab is in front: the script is blocked until
 *    someone answers, so this is not a nudge the open tab already covers.
 *
 * A notice is taken back as soon as its approval is answered, anywhere. Quiet mode holds it
 * back unless quiet lets permission prompts through (quietAllowsToast 'permission').
 */
import type { Approval } from '@/api/approvals';
import { log } from '@/utils/log';
import { currentQuiet } from '@/contexts/notifications/quiet';
import { quietAllowsToast } from '@/contexts/notifications/quiet-model';
import { getHostStatus } from '@/hooks/useHostStatus';
import { hostDisplayLabel } from '@/utils/host-display-label';

interface Handler { postMessage(body: unknown): Promise<unknown> }

function nativeHandler(): Handler | null {
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, Handler | undefined> } };
  return w.webkit?.messageHandlers?.walnutNotify ?? null;
}

export const OPEN_APPROVAL_EVENT = 'walnut:open-approval';

/** What the notice says: the step, then what to do and who asks. */
export function approvalNoticeText(a: Approval, hostName: string = hostDisplayLabel(a.requester.host, getHostStatus(a.requester.host)?.label)): { title: string; body: string } {
  const r = a.requester;
  const who = r.taskTitle ? `Task "${r.taskTitle}"` : r.command ? r.command : 'A script';
  const how = a.mode === 'biometric' ? 'Click to review it, then approve with Touch ID or Face ID.' : 'Click to approve or deny.';
  return { title: `Approve? ${a.what}`, body: `${who} on ${hostName} is waiting for you. ${how}` };
}

/** Whether this window can raise a system notice now, and what to offer when it cannot. */
export type NoticeAccess = 'native' | 'granted' | 'ask' | 'denied' | 'none';

export function noticeAccess(): NoticeAccess {
  if (nativeHandler()) return 'native';
  if (typeof Notification === 'undefined') return 'none';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.permission === 'denied' ? 'denied' : 'ask';
}

/** A browser's own permission prompt (needs the click that calls it). */
export async function askNoticePermission(): Promise<NoticeAccess> {
  if (typeof Notification === 'undefined') return 'none';
  try { await Notification.requestPermission(); } catch { /* an old Safari takes a callback */ }
  return noticeAccess();
}

const shown = new Map<string, Notification>();
let opener: ((id: string) => void) | null = null;

/** The store's openApproval, set once (a module cycle otherwise). */
export function setApprovalOpener(fn: (id: string) => void): void {
  opener = fn;
}

/** Raise the notice. false: quiet mode holds it back for now (the page asks again when quiet ends). */
export function showApprovalNotice(a: Approval): boolean {
  // Quiet mode (Walnut's Do Not Disturb) lets it through as it lets a permission prompt through:
  // a script is blocked on it. The row and the card inside the page show it either way.
  if (!quietAllowsToast(currentQuiet(), 'permission')) return false;
  const { title, body } = approvalNoticeText(a);
  const native = nativeHandler();
  if (native) {
    native.postMessage({ op: 'post', id: a.id, title, body })
      .then((r) => log.info('approvals', 'system notice posted', { approvalId: a.id, result: r as Record<string, unknown> }))
      .catch((err) => log.warn('approvals', 'system notice refused', { approvalId: a.id, error: String(err) }));
    return true;
  }
  if (noticeAccess() !== 'granted') return true;
  try {
    const n = new Notification(title, { body, tag: `approval-${a.id}`, requireInteraction: true });
    n.onclick = () => {
      window.focus();
      opener?.(a.id);
      n.close();
    };
    shown.set(a.id, n);
  } catch {
    // A browser that refuses notifications from this page.
  }
  return true;
}

/** The Mac app: take back every approval notice whose approval is not among `ids` (still waiting). */
export function keepApprovalNotices(ids: readonly string[]): void {
  nativeHandler()?.postMessage({ op: 'keep', ids }).catch(() => { /* an older app: no such op */ });
}

/** The Mac app: the approval whose notice was clicked before this page could hear it, once. */
export async function takeClickedApproval(): Promise<string | null> {
  const native = nativeHandler();
  if (!native) return null;
  try {
    const r = (await native.postMessage({ op: 'take' })) as { id?: string } | null;
    return typeof r?.id === 'string' && r.id ? r.id : null;
  } catch {
    return null;
  }
}

export function clearApprovalNotice(id: string): void {
  const native = nativeHandler();
  if (native) {
    native.postMessage({ op: 'clear', id }).catch(() => { /* an app quitting */ });
    return;
  }
  const n = shown.get(id);
  if (n) {
    shown.delete(id);
    try { n.close(); } catch { /* already gone */ }
  }
}

/** The Mac app's System Settings pane for its notifications (when the person turned them off). */
export function openNoticeSettings(): void {
  nativeHandler()?.postMessage({ op: 'settings' }).catch(() => {});
}

/** The app's own state of its notifications: allowed, not asked yet, or turned off. */
export async function nativeNoticeStatus(): Promise<'allowed' | 'ask' | 'off' | null> {
  const native = nativeHandler();
  if (!native) return null;
  try {
    const r = (await native.postMessage({ op: 'status' })) as { status?: string };
    return r.status === 'allowed' || r.status === 'off' ? r.status : 'ask';
  } catch {
    return null;
  }
}
