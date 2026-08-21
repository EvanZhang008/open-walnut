/**
 * Startup reconcile: expire permission notifications nobody can ever answer.
 *
 * A permission lives in TWO places — the session record's `pendingPermission`
 * and a durable notification keyed `perm:<requestId>`. Every death path clears
 * the record's copy (the terminal-transition clear + healStalePendingPermissions
 * in session-tracker.ts), but until the expiry work landed nothing ever stamped
 * the NOTIFICATION, so an unanswered request stayed `resolved: undefined`. The
 * panel reads that as "still pending": a permanent phantom in the Needs Action
 * rail whose Approve/Deny buttons 404 against a session that died days ago.
 *
 * Both live paths now stamp as they clear, so this reconcile exists for the
 * BACKLOG — records already orphaned before that shipped (the live prod one had
 * been sitting on a dead Error session), plus anything a crash left half-done.
 * It runs once at startup, right after the record-side heal so it observes
 * healed state.
 *
 * Lives in its own module (rather than inside server.ts) so it is unit-testable
 * without booting a server. It may import session code freely — the direction
 * that must stay clean is store.ts, which imports only leaves.
 */

import { listNotifications, resolvePermissionNotification } from './store.js';
import { getSessionByClaudeId } from '../session-tracker.js';
import { log } from '../../logging/index.js';

/** The request id a permission record is about; legacy rows only have dedupKey. */
function requestIdOf(record: { requestId?: string; dedupKey: string }): string | null {
  if (record.requestId) return record.requestId;
  if (record.dedupKey.startsWith('perm:')) return record.dedupKey.slice(5) || null;
  return null;
}

/**
 * Stamp `expired` on every unresolved permission notification whose request can
 * no longer be answered. Returns how many it expired.
 *
 * Expires when the session is GONE, when it is terminal (stopped/error), or when
 * it is alive but has moved on to a different (or no) pending request — that last
 * case is the ask being superseded, which is just as unanswerable.
 *
 * Leaves alone: a live session still holding THIS exact request (genuinely
 * pending — the whole point of the rail), and a session in the
 * `remote_unreachable` carve-out, where "error" means the tunnel dropped rather
 * than the CLI died, so the remote process may still be waiting on this very
 * question. Same carve-out both record-side clears use.
 */
export async function expireOrphanedPermissionNotifications(): Promise<number> {
  let expired = 0;
  let checked = 0;
  try {
    const { feed } = await listNotifications();
    for (const record of feed) {
      if (record.kind !== 'permission' || record.resolved) continue;
      const requestId = requestIdOf(record);
      if (!requestId) continue;
      checked++;

      let reason: string | null = null;
      if (!record.sessionId) {
        // No deep-link target at all — nothing to answer against.
        reason = 'no_session_id';
      } else {
        const session = await getSessionByClaudeId(record.sessionId);
        if (!session) reason = 'session_missing';
        else if (session.status_reason === 'remote_unreachable') reason = null;
        else if (session.process_status === 'stopped' || session.process_status === 'error') {
          reason = 'session_terminal';
        } else if (session.pendingPermission?.requestId !== requestId) {
          reason = 'request_superseded';
        }
      }
      if (!reason) continue;

      await resolvePermissionNotification(requestId, 'expired');
      expired++;
      log.notif.info('expired orphaned permission notification', {
        dedupKey: record.dedupKey, requestId, sessionId: record.sessionId ?? null, reason,
      });
    }
  } catch (err) {
    log.notif.warn('permission notification expiry reconcile failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (checked > 0) {
    log.notif.info('startup: reconciled unresolved permission notifications', { checked, expired });
  }
  return expired;
}
