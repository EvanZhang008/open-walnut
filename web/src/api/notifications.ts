/**
 * Notification actions that aren't part of the feed's own lifecycle.
 *
 * (Read / dismiss / the feed itself live in the NotificationProvider, which owns
 * the optimistic state around them.)
 */
import { apiPost } from './client';
import { invalidateSelfRepair } from './config';

/**
 * The FIRST call on an npm install clones Walnut's source before it can start a
 * session, which takes minutes — the client waits that out rather than aborting
 * a request the server is going to finish anyway (the record gains its `fix`
 * server-side either way, so a give-up loses the deep link, not the session).
 */
const FIX_TIMEOUT_MS = 330_000;

export interface NotificationFixResult {
  taskId: string;
  sessionId?: string;
  /** true = the record already had a repair session; this is that one. */
  reused: boolean;
  cloned?: boolean;
}

export async function startNotificationFix(
  dedupKey: string,
  opts?: { restart?: boolean },
): Promise<NotificationFixResult> {
  const result = await apiPost<NotificationFixResult>(
    '/api/notifications/fix',
    { dedupKey, ...(opts?.restart ? { restart: true } : {}) },
    // 409 (cloud replica) and 503 (no source, no git) are designed answers the
    // card shows inline, not client faults for the error-log audit.
    { timeoutMs: FIX_TIMEOUT_MS, quietStatuses: [409, 503] },
  );
  // A clone just happened: the memoized "first click will clone" answer is stale.
  if (result.cloned) invalidateSelfRepair();
  return result;
}
