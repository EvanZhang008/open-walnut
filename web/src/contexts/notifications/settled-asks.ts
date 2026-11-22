/**
 * The bell and the notification center count an ask as answered the moment it is answered,
 * wherever (2026-11-19: answered from its timeline card or its toast, the bell kept its number
 * until the server's `session:permission-resolved` came back).
 *
 * A permission request's state lives in ONE store (stores/permission-request-store.ts), which
 * every answer path writes before its request leaves. The feed's own `resolved` stamp is the
 * server's; until it arrives, the store's settled status is laid over the feed entry here, so
 * every count derived from the feed (attentionBadgeCount, sectionCounts) follows the store in the
 * same frame, and a refused answer (the store rolls back to pending) brings the entry back.
 */
import type { PermissionRequestState } from '@/stores/permission-request-store';
import type { Notification } from './types';
import { requestIdOf } from './notification-model';

const STAMP: Record<string, Notification['resolved']> = { allowed: 'allowed', denied: 'denied', expired: 'expired', stale: 'stale' };

/** The feed with each unstamped permission entry the store holds settled stamped as such; the
 *  same array when none is. */
export function withSettledAsks(feed: Notification[], stateOf: (requestId: string) => PermissionRequestState | undefined): Notification[] {
  let out: Notification[] | null = null;
  feed.forEach((n, i) => {
    if (n.kind !== 'permission' || n.resolved) return;
    const id = requestIdOf(n);
    const resolved = id ? STAMP[stateOf(id)?.status ?? ''] : undefined;
    if (!resolved) return;
    out ??= feed.slice();
    out[i] = { ...n, resolved, severity: resolved === 'allowed' ? 'success' : 'info' };
  });
  return out ?? feed;
}

/**
 * The dedupKeys a Clear of `list` dismisses (the notification center's header): every settled
 * entry, never an ask still waiting for its answer. Dismissing a pending permission request removes
 * its only card in the bell while the session stays stuck on it (2026-11-22 review: "Clear asks"
 * did exactly that), so an unanswered ask leaves only by being answered, or by its own x.
 */
export function clearableKeys(list: readonly Notification[]): string[] {
  return list.filter((n) => !(n.kind === 'permission' && !n.resolved)).map((n) => n.dedupKey);
}
