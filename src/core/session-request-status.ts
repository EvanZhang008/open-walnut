/**
 * What a reply does to a session request in each status: a leaf module (no store, no I/O), read
 * by the request store (session-requests.ts), the replica's requests copy (replication/kinds/
 * requests.ts) and its away fold (replica/away-requests.ts). The host daemon's offline core
 * inlines the same `late` list (providers/offline-host-core.ts settleHere), pinned by
 * tests/core/session-request-late-reply.test.ts.
 */
import type { SessionRequestStatus } from './session-requests.js';

/**
 * What a reply does to a request in each status (one table, so a new status must say it):
 * `settles` it opens to the answer (pending), `answered` it already has one (a later answer is a
 * repeat or a second answer, delivered but never settling it), `late` it was settled WITHOUT an
 * answer (a turn end, a deadline, its asker's close), so an answer that comes later still settles
 * it as replied (`lateFrom`). 2026-11-22: a late answer after `notified` stayed `notified`.
 */
export const REPLY_TO_STATUS = {
  pending: 'settles',
  replied: 'answered',
  notified: 'late',
  expired: 'late',
  withdrawn: 'late',
} as const satisfies Record<SessionRequestStatus, 'settles' | 'answered' | 'late'>;

/** The statuses a late answer still turns into replied (REPLY_TO_STATUS `late`). */
export type LateAnswerFrom = { [K in keyof typeof REPLY_TO_STATUS]: (typeof REPLY_TO_STATUS)[K] extends 'late' ? K : never }[keyof typeof REPLY_TO_STATUS];

/** Whether an answer to a request in this status settles it late (settled before, without an answer). */
export function answersLate(status: SessionRequestStatus | string | undefined): status is LateAnswerFrom {
  return !!status && (REPLY_TO_STATUS as Record<string, string>)[status] === 'late';
}
