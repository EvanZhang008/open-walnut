/**
 * The journal v2 kind `inbox-reply` on the Mac: the human's reply to a letter, or the
 * option they picked on it, taken by the cloud companion while this Mac was away
 * (core/companion-journal.ts journalInboxReply; 2026-11-05, a voice reply on the phone
 * reached the Mac 1h45m late because the companion could only answer 503).
 *
 * Applied through the online route's own calls, as the human's own turn (no `by`), from
 * the phone: a reply is humanReplyAndDeliver with its `clientId`, an answer is
 * answerLetterAndDeliver. The drain waits for the delivery's outcome (one attempt is bounded
 * by the store's delivery timeout): the record is acked only once the words are in the
 * session's durable queue or the turn says why not (skipped, failed, as an online reply
 * shows). Acking on a `pending` delivery let a restart lose the words between the ledger row
 * and the queue (review, 2026-11-07). The read and unarchive a turn makes are stamped at the
 * human's moment (`flagsAt`), so a flag the human set after it while away still wins.
 *
 * Once: a reply is one turn per `clientId` in the store, and a redrain after a crash
 * between the apply and its ledger row finds the turn (delivering it again only when its
 * delivery is still pending or failed). An answer has no id, so a letter already answered by
 * the user with the same option and words (bounded as the store bounds them) at or after the
 * record's moment is this record's: its delivery is finished if it never was
 * (deliverPendingAnswer), and nothing is answered twice. A refusal the store makes (the letter is
 * gone, the option unknown, already answered otherwise) is a RefusedWrite: the drain
 * letters it, so the user learns the words did not arrive. Anything else is retried.
 *
 * `inbox-reply-pictures` is the same turn with pictures: `images` names them in order (the
 * companion's file names), each one's bytes a blob named by `image<i>`, fetched through the
 * journal door and saved in the images folder under the same name (never over another
 * file: a different picture already there gets the bytes beside it under a name carrying
 * their hash, apply-note-attachment.ts place), so the turn names the same picture on both
 * boxes and a redrain writes nothing more. A picture whose bytes the companion no longer
 * holds is refused with the turn (a RefusedWrite, lettered): the words never arrive
 * without the pictures sent with them.
 */

import path from 'node:path';
import { log } from '../../logging/index.js';
import { RefusedWrite } from './patch-check.js';
import type { V2Context, V2Record } from './apply-v2.js';

/**
 * The record's moment is the companion's clock plus the measured offset, an estimate: an
 * answer recorded this much before it still counts as this record's own (a redrain).
 */
const ANSWER_CLOCK_SLACK_MS = 60_000;

function excerpt(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length > 60 ? `${s.slice(0, 60)}...` : s;
}

/** The record's pictures saved here, in order: their file names in the images folder. */
async function savedPictures(ctx: V2Context, record: V2Record, what: string): Promise<string[]> {
  if (record.kind !== 'inbox-reply-pictures') return [];
  const { cleanPictureNames, MAX_ANSWER_PICTURES } = await import('../answer-pictures.js');
  const listed = Array.isArray(record.images) ? record.images : [];
  const names = cleanPictureNames(listed);
  if (names.length === 0 || names.length !== Math.min(listed.length, MAX_ANSWER_PICTURES)) {
    throw new RefusedWrite(`${what}: its pictures could not be read`);
  }
  if (!ctx.conn) throw new Error('a reply with pictures needs its host link for the bytes');
  const [{ fetchOfflineBlob }, { place }, { IMAGES_DIR }] = await Promise.all([
    import('./blob.js'), import('./apply-note-attachment.js'), import('../../constants.js'),
  ]);
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const sha = record[`image${i}`];
    if (typeof sha !== 'string' || !sha) throw new RefusedWrite(`${what}: a picture came without its bytes`);
    let bytes: Buffer;
    try {
      bytes = await fetchOfflineBlob(ctx.conn, sha);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'not_found') throw new RefusedWrite(`${what}: a picture's bytes are gone from the companion`);
      throw err;
    }
    const at = await place(path.join(IMAGES_DIR, names[i]), bytes);
    out.push(path.basename(at.at));
  }
  return out;
}

export async function applyInboxReply(ctx: V2Context, record: V2Record): Promise<void> {
  const { letterId, op, text, clientId, actionId, freeText, madeAt } = record as {
    letterId?: unknown; op?: unknown; text?: unknown; clientId?: unknown; actionId?: unknown; freeText?: unknown; madeAt?: unknown;
  };
  const what = op === 'answer'
    ? `your answer "${excerpt(actionId)}"${excerpt(freeText) ? ` ("${excerpt(freeText)}")` : ''} to a letter was not recorded`
    : `your reply ${excerpt(text) ? `"${excerpt(text)}"` : 'with pictures'} to a letter was not delivered`;
  const { LETTER_ID_RE, CLIENT_ID_RE } = await import('../human-inbox/normalize.js');
  const readable = typeof letterId === 'string' && LETTER_ID_RE.test(letterId) && (op === 'reply'
    ? typeof text === 'string' && typeof clientId === 'string' && CLIENT_ID_RE.test(clientId)
    : op === 'answer' && typeof actionId === 'string' && actionId.length > 0 && (freeText === undefined || typeof freeText === 'string'));
  // The human's words: never skipped quietly.
  if (!readable) throw new RefusedWrite(`${what}: the record could not be read`);
  const since = typeof madeAt === 'number' && Number.isFinite(madeAt) && madeAt > 0 ? madeAt + ctx.offset : ctx.at;
  const { humanReplyAndDeliver, answerLetterAndDeliver, deliverPendingAnswer, LetterError } = await import('../human-inbox/letter-ops.js');
  const { getLetter, repeatsRecordedTurn, boundThreadText } = await import('../human-inbox/store.js');
  try {
    // A letter that is gone (the store refuses the turn) gets no pictures saved for nothing.
    const letter = await getLetter(letterId as string, { deferBodies: true });
    if (op === 'reply') {
      const again = await repeatsRecordedTurn(letterId as string, { kind: 'reply', clientId });
      // A turn already on its letter keeps the pictures it has: nothing is saved twice.
      const images = again || !letter ? [] : await savedPictures(ctx, record, what);
      const out = await humanReplyAndDeliver(letterId as string, { text: text as string, clientId: clientId as string, flagsAt: since, ...(images.length ? { images } : {}) });
      log.notif.info('offline handover: a reply written on the companion is on its letter', {
        host: ctx.hostKey, seq: record.seq, opId: record.opId, letterId, delivery: out.delivery.status, ...(images.length ? { pictures: images.length } : {}), ...(again ? { duplicate: true } : {}),
      });
      if (again) ctx.result.skipped++; else ctx.result.replayed++;
      return;
    }
    const note = typeof freeText === 'string' ? freeText.trim() : '';
    const answered = letter?.answered;
    // The store keeps the note bounded: compare it the way it was kept.
    if (answered && !answered.by && answered.actionId === actionId && (answered.freeText ?? '') === boundThreadText(note)
      && answered.at >= since - ANSWER_CLOCK_SLACK_MS) {
      const finished = await deliverPendingAnswer(letterId as string);
      log.notif.info('offline handover: an answer from the companion is on its letter already', {
        host: ctx.hostKey, seq: record.seq, opId: record.opId, letterId, ...(finished ? { delivered: finished.status } : {}),
      });
      ctx.result.skipped++;
      return;
    }
    const images = letter ? await savedPictures(ctx, record, what) : [];
    const out = await answerLetterAndDeliver(letterId as string, { actionId: actionId as string, ...(note ? { freeText: note } : {}), flagsAt: since, ...(images.length ? { images } : {}) }, 'phone');
    log.notif.info('offline handover: an answer written on the companion is on its letter', {
      host: ctx.hostKey, seq: record.seq, opId: record.opId, letterId, delivery: out.delivery.status, ...(images.length ? { pictures: images.length } : {}),
    });
    ctx.result.replayed++;
  } catch (err) {
    if (err instanceof LetterError && err.status < 500) throw new RefusedWrite(`${what}: ${err.message}`);
    throw err;
  }
}
