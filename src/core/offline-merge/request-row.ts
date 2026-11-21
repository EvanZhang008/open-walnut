/**
 * A reply request a host's daemon opened while the Mac was away (the journal's `row` record,
 * providers/offline-host-core.ts OfflineRequestRow), as the Mac's request store holds it: the
 * Mac's drain imports it in this shape (offline-handover.ts), and a host replica shows it in the
 * same shape before the drain (replica/away-requests.ts).
 */
import type { SessionRequest } from '../session-requests.js';
import type { OfflineRequestRow } from '../../providers/offline-host-core.js';

export function requestOfRow(row: OfflineRequestRow): SessionRequest {
  return {
    id: row.id,
    fromSessionId: row.fromSessionId,
    toSessionId: row.toSessionId,
    ...(row.toTaskId ? { toTaskId: row.toTaskId } : {}),
    preview: row.preview,
    status: row.status,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    ...(row.settledAt ? { settledAt: row.settledAt } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(typeof row.messageId === 'string' ? { messageId: row.messageId } : {}),
    ...(typeof row.reachedAt === 'string' ? { reachedAt: row.reachedAt } : {}),
  };
}
