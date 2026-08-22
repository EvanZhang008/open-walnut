/**
 * Startup reconcile: expire the notifications nobody can ever settle.
 *
 * Two families, one rule: a notification needs a lifecycle, and a notification
 * whose lifecycle can no longer advance must be STAMPED rather than left looking
 * live. For a permission that means "nobody can answer this" (below); for an
 * error it means "nothing can ever recover this" — its session is dead, or the
 * record predates recoveryKey entirely and no success signal can reach it.
 *
 * Original doc for the permission half:
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

import {
  listNotifications, resolvePermissionNotification,
  expireErrorNotifications, expireKeylessErrorNotifications,
  type NotificationRecord,
} from './store.js';
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

/**
 * Records older than this with NO recoveryKey are pre-lifecycle debris (W7).
 *
 * 48h, not "any age": every producer that can name a condition passes a key now,
 * so a keyless record is either legacy or a producer that genuinely has no
 * lifecycle (a true one-shot event). Both deserve to settle eventually, but a
 * keyless error that arrived minutes ago may be describing something happening
 * RIGHT NOW, and stamping it on the next boot would erase a live error the user
 * hasn't seen. Two days is long enough that "nobody acted on it and nothing can
 * ever resolve it" is the honest reading.
 */
export const KEYLESS_ERROR_DEBRIS_MS = 48 * 60 * 60 * 1000;

/** The session id an error record belongs to, from its `session:<sid>` key. */
function sessionIdOfErrorKey(record: NotificationRecord): string | null {
  if (!record.recoveryKey?.startsWith('session:')) return null;
  return record.recoveryKey.slice('session:'.length) || null;
}

/**
 * Startup reconcile: settle the error notifications whose lifecycle is over.
 *
 * Two independent sweeps, deliberately in this order:
 *
 * 1. DEAD SESSIONS. A `session:<sid>` error recovers when that session's next
 *    turn completes — so when the session is gone or terminal, its recovery
 *    signal will never arrive and the card would sit red forever (the live feed's
 *    session runtime/delivery/transport cards were exactly this). 'expired', not
 *    'recovered': the session died, it wasn't fixed, and claiming otherwise would
 *    be a lie the user acts on.
 *
 *    A session that is terminal but 'remote_unreachable' is EXEMPT, matching the
 *    permission sweep above: that "error" is a dropped tunnel, not death — the
 *    remote CLI may still be running and may still produce a clean result.
 *
 * 2. KEYLESS DEBRIS (W7). Records that predate recoveryKey entirely: no key, so
 *    no success can reach them, and their conditions are no longer verifiable.
 *    One age rule, no per-producer special-casing — see KEYLESS_ERROR_DEBRIS_MS.
 *
 * Returns the counts so the caller can log one line. Never throws: a reconcile
 * failing must not take down boot.
 */
export async function expireStaleErrorNotifications(
  now = Date.now(),
): Promise<{ deadSession: number; keylessDebris: number }> {
  let deadSession = 0;
  let keylessDebris = 0;
  try {
    const { feed } = await listNotifications();

    // ── 1. Errors belonging to sessions that can never report again ──
    // Collect keys first, then ONE store write: a per-record write would take the
    // cross-process file lock once per card (the feed cap is 200).
    const deadKeys = new Set<string>();
    const checkedSessions = new Map<string, boolean>(); // sid → is dead
    for (const record of feed) {
      if (record.kind !== 'operation-error' || record.resolved) continue;
      const sid = sessionIdOfErrorKey(record);
      if (!sid) continue;
      let dead = checkedSessions.get(sid);
      if (dead === undefined) {
        const session = await getSessionByClaudeId(sid).catch(() => null);
        dead = !session
          || (session.status_reason !== 'remote_unreachable'
            && (session.process_status === 'stopped' || session.process_status === 'error'));
        checkedSessions.set(sid, dead);
      }
      if (dead) deadKeys.add(record.recoveryKey!);
    }
    if (deadKeys.size > 0) {
      const { expired } = await expireErrorNotifications([...deadKeys]);
      deadSession = expired.length;
      for (const rec of expired) {
        log.notif.info('expired error notification for a dead session', {
          dedupKey: rec.dedupKey, recoveryKey: rec.recoveryKey ?? null,
        });
      }
    }

    // ── 2. Pre-lifecycle debris ──
    const { expired: debris } = await expireKeylessErrorNotifications(KEYLESS_ERROR_DEBRIS_MS, now);
    keylessDebris = debris.length;
    if (keylessDebris > 0) {
      log.notif.info('expired pre-lifecycle error debris (keyless, unresolvable)', {
        count: keylessDebris,
        // Titles, not the whole records: enough to recognise what was swept if
        // this ever eats something it shouldn't have.
        titles: debris.slice(0, 10).map(r => r.title),
      });
    }
  } catch (err) {
    log.notif.warn('error notification expiry reconcile failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (deadSession > 0 || keylessDebris > 0) {
    log.notif.info('startup: reconciled unresolved error notifications', { deadSession, keylessDebris });
  }
  return { deadSession, keylessDebris };
}
