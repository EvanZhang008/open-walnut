/**
 * The journal v2 kind `inbox-state` on the Mac (docs/plan/walnut-companion-unified-replica.md,
 * stage 3, slice 3c): a letter's read, pinned or archived flag the human set on the cloud
 * companion while this Mac was away.
 *
 * Applied as the companion's relayed replay was (human-inbox/relay.ts, store.ts
 * setLetterState with `since`): `since` is the human's moment on this Mac's clock (the
 * record's `madeAt` plus the measured offset), so a newer change made here (an agent reply
 * that flipped the letter unread) wins over the late one. A letter gone or a bad value is
 * skipped with a log line, as the queue dropped it: a letter about a read mark is not
 * something the user needs. A store failure is thrown (retried).
 */

import { log } from '../../logging/index.js';
import type { V2Context, V2Record } from './apply-v2.js';

const FIELDS = new Set(['read', 'pinned', 'archived']);

export async function applyInboxState(ctx: V2Context, record: V2Record): Promise<void> {
  const { letterId, field, value, madeAt } = record as { letterId?: unknown; field?: unknown; value?: unknown; madeAt?: unknown };
  const { LETTER_ID_RE } = await import('../human-inbox/normalize.js');
  if (typeof letterId !== 'string' || !LETTER_ID_RE.test(letterId) || typeof field !== 'string' || !FIELDS.has(field) || typeof value !== 'boolean') {
    log.notif.warn('offline handover: an inbox change it cannot read was skipped', { host: ctx.hostKey, seq: record.seq, opId: record.opId });
    ctx.result.skipped++;
    return;
  }
  const since = typeof madeAt === 'number' && Number.isFinite(madeAt) && madeAt > 0 ? madeAt + ctx.offset : ctx.at;
  const { setLetterState, LetterError } = await import('../human-inbox/store.js');
  try {
    const out = await setLetterState(letterId, field as 'read' | 'pinned' | 'archived', value, { since });
    if (out.superseded) ctx.result.skipped++; else ctx.result.replayed++;
  } catch (err) {
    if (!(err instanceof LetterError) || err.status >= 500) throw err;
    log.notif.info('offline handover: an inbox change for a letter the Mac no longer has was skipped', { host: ctx.hostKey, letterId, field, reason: err.message });
    ctx.result.skipped++;
  }
}
