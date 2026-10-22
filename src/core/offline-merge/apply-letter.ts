/**
 * The journal v2 kind `letter` on the Mac: a session's letter to the user
 * (human_inbox_send) that its host saved while this Mac was away
 * (providers/offline-host-core.ts opLetter).
 *
 * Sent the way the online op sends one: the op's own argument parse and size caps, then
 * sendLetterAsCaller (the sender stamped from the session, the per-run letter budget, the
 * store's checks, the inbox envelope, the phone push and the events). It keeps the id the
 * host gave the session (a taken id gets a new one) and the time the session sent it, on
 * this Mac's clock. Once: the letter keeps the record's op id (`createdByOp`), so a redrain
 * after a crash between the send and its ledger row finds it and sends nothing. A letter
 * the store refuses (the answer the same call online gets), or one whose body the host no
 * longer holds, is refused into the drain's letter and the session is told.
 */

import { log } from '../../logging/index.js';
import { RefusedWrite } from './patch-check.js';
import type { V2Context, V2Record } from './apply-v2.js';

function oneLine(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length > 80 ? `${s.slice(0, 80)}...` : s || '(no subject)';
}

export async function applyLetter(ctx: V2Context, record: V2Record): Promise<void> {
  const args = record.args && typeof record.args === 'object' && !Array.isArray(record.args) ? record.args as Record<string, unknown> : null;
  const format = record.format === 'html' || record.format === 'markdown' ? record.format : null;
  const letterId = typeof record.letterId === 'string' ? record.letterId : '';
  const what = `the letter "${oneLine(args?.subject)}"${letterId ? ` (${letterId})` : ''} was not sent`;
  if (!args || !format || typeof record.bodyBlob !== 'string' || !record.bodyBlob) throw new RefusedWrite(`${what}: the record is not a whole letter`);
  if (!ctx.conn) throw new Error('a letter record needs its host link for the body');
  const { fetchOfflineBlob } = await import('./blob.js');
  let body: string;
  try {
    body = (await fetchOfflineBlob(ctx.conn, record.bodyBlob)).toString('utf8');
  } catch (err) {
    // Gone from the host: no later drain reads it either. Anything else is retried.
    if ((err as { code?: unknown }).code === 'not_found') throw new RefusedWrite(`${what}: its text is gone from the host`);
    throw err;
  }
  const { getOp, parseOpArgs } = await import('../../ops/index.js');
  const op = getOp('human_inbox_send');
  if (!op) throw new Error('human_inbox_send is not an op on this server');
  const parsed = parseOpArgs(op, { ...args, [format]: body });
  if (!parsed.ok) throw new RefusedWrite(`${what}: ${parsed.message}`);
  const { createLetterCheck } = await import('../human-inbox/letter-check.js');
  const over = createLetterCheck().oversize({ [format]: body, text: parsed.args.text });
  if (over) throw new RefusedWrite(`${what}: ${over.name} is over the ${over.max}-byte letter cap`);
  const sid = record.actor?.kind === 'session' ? record.actor.sid : undefined;
  const { sendLetterAsCallerOnce, LetterError } = await import('../human-inbox/letter-ops.js');
  let out: Awaited<ReturnType<typeof sendLetterAsCallerOnce>>;
  try {
    out = await sendLetterAsCallerOnce(parsed.args as never, sid, {
      ...(letterId ? { id: letterId } : {}),
      // The moment the session sent it (never later than now: the store caps it).
      createdAt: ctx.at,
      ...(record.opId ? { opKey: record.opId } : {}),
    });
  } catch (err) {
    if (err instanceof LetterError && err.status < 500) throw new RefusedWrite(`${what}: ${err.message}`);
    throw err;
  }
  log.notif.info('offline handover: a letter written while away is in the inbox', {
    host: ctx.hostKey, seq: record.seq, opId: record.opId, letterId: out.letter.id, givenId: letterId,
    sessionId: sid, duplicate: out.duplicate,
  });
  if (out.duplicate) ctx.result.skipped++; else ctx.result.replayed++;
}
