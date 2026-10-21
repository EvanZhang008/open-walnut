/**
 * The journal v2 kind `chat-turn` on the Mac (docs/plan/walnut-companion-unified-replica.md,
 * stage 3, slice 3e): a Personal AI chat turn the cloud companion answered itself while
 * this Mac did not answer.
 *
 * Adopted exactly as the companion's outbox hands one over (cloud-chat-outbox.ts
 * handlePrimaryChatAdopt: the route's own checks, the conversation's row ensured, the turn
 * inserted by time, once by turn id), with its texts read from the companion
 * (`offline.blob`) and its times moved onto this Mac's clock. A turn the outbox already
 * handed over is `already-present`, a no-op. A record whose ids or words are not a turn's
 * is refused into the letter; one whose answer the companion lost lands as a failed turn
 * (the user's words and an error), never as nothing.
 */

import { log } from '../../logging/index.js';
import { RefusedWrite } from './patch-check.js';
import type { V2Context, V2Record } from './apply-v2.js';

/** A body the companion no longer holds (a text that is the word "lost" stays a text). */
const LOST = Symbol('lost');

function shifted(iso: unknown, offset: number): string | null {
  if (typeof iso !== 'string') return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at + offset).toISOString() : null;
}

export async function applyChatTurn(ctx: V2Context, record: V2Record): Promise<void> {
  if (!ctx.conn) throw new Error('a chat-turn record needs its host link for the texts');
  const { fetchOfflineBlob } = await import('./blob.js');
  const text = async (sha: unknown): Promise<string | typeof LOST | undefined> => {
    if (typeof sha !== 'string' || !sha) return undefined;
    try {
      return (await fetchOfflineBlob(ctx.conn!, sha)).toString('utf8');
    } catch (err) {
      // Gone from the companion: no later drain reads it either. Anything else is retried.
      if ((err as { code?: unknown }).code === 'not_found') return LOST;
      throw err;
    }
  };
  const userText = await text(record.userBlob);
  if (typeof userText !== 'string') {
    throw new RefusedWrite('the words of this chat turn are gone from the cloud companion, so it was not added to its conversation');
  }
  const answer = await text(record.answerBlob);
  const userAt = shifted(record.userAt, ctx.offset) ?? new Date(ctx.at).toISOString();
  const payload: Record<string, unknown> = {
    v: 1, turnId: record.turnId, agentId: record.agentId, conversationId: record.conversationId,
    userText, userAt, engine: record.engine,
  };
  if (typeof answer === 'string') {
    payload.answerText = answer;
    payload.answeredAt = shifted(record.answeredAt, ctx.offset) ?? userAt;
  } else {
    payload.error = answer === LOST
      ? 'The cloud companion answered this turn, but its answer was lost before your Mac took it.'
      : typeof record.error === 'string' && record.error ? record.error : 'The cloud companion did not answer this turn.';
  }
  const { handlePrimaryChatAdopt, CloudTurnAdoptError } = await import('../cloud-chat-outbox.js');
  let out: Record<string, unknown>;
  try {
    out = await handlePrimaryChatAdopt(payload);
  } catch (err) {
    if (err instanceof CloudTurnAdoptError && err.statusCode < 500) throw new RefusedWrite(`a chat turn from the cloud companion was refused: ${err.message}`);
    throw err;
  }
  log.agent.info('offline handover: chat turn from the cloud companion adopted', {
    host: ctx.hostKey, seq: record.seq, opId: record.opId, turnId: record.turnId, conversationId: record.conversationId,
    duplicate: out.duplicate === true, answered: typeof answer === 'string',
  });
  if (out.duplicate === true) ctx.result.skipped++; else ctx.result.replayed++;
}
