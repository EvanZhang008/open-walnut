/**
 * Human-inbox bridge relay (runs on the PRIMARY box).
 *
 * A cloud replica has the letters' data dir but not the daemons, so answering a
 * letter there could never reach the origin session. Every `/api/v1/human-inbox`
 * route on a replica therefore relays here over the `server.human-inbox.*`
 * control actions, and this file is the ONE place that maps an action name onto
 * the same functions the primary's own routes call.
 *
 * Shapes match the HTTP responses exactly (`{ letters, unreadCount }`,
 * `{ letter }`, `{ letter, delivery }`, `{ id }`), so the replica can pass the
 * reply straight through to the client.
 */

import {
  agentReply,
  getLetter,
  listLetters,
  setArchived,
  setPinned,
  setRead,
  LetterError,
} from './store.js';
import {
  answerLetterAndDeliver,
  humanReplyAndDeliver,
  sendLetterAsCaller,
} from './letter-ops.js';
import type { AgentReplyInput, NewLetter } from './types.js';

export { LetterError };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function requireId(p: Record<string, unknown>): string {
  const id = str(p.id).trim();
  if (!id) throw new LetterError('id is required', 'invalid', 400);
  return id;
}

function requireBool(p: Record<string, unknown>, field: string): boolean {
  const v = p[field];
  if (typeof v !== 'boolean') throw new LetterError(`${field} (boolean) is required`, 'invalid', 400);
  return v;
}

export async function handleHumanInboxRelayAction(
  sub: string,
  p: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (sub) {
    case 'list':
      return await listLetters({ archived: p.archived === true }) as unknown as Record<string, unknown>;
    case 'get': {
      const letter = await getLetter(requireId(p));
      if (!letter) throw new LetterError(`Letter not found: ${str(p.id)}`, 'not_found', 404);
      return { letter };
    }
    case 'send': {
      const { callerSid, ...input } = p;
      const letter = await sendLetterAsCaller(
        input as unknown as Omit<NewLetter, 'sender'>,
        typeof callerSid === 'string' ? callerSid : undefined,
      );
      return { id: letter.id };
    }
    case 'reply': {
      const { id, ...input } = p;
      return { letter: await agentReply(requireId({ id }), input as unknown as AgentReplyInput) };
    }
    case 'read':
      return { letter: await setRead(requireId(p), requireBool(p, 'read')) };
    case 'pin':
      return { letter: await setPinned(requireId(p), requireBool(p, 'pinned')) };
    case 'archive':
      return { letter: await setArchived(requireId(p), requireBool(p, 'archived')) };
    case 'answer':
      return await answerLetterAndDeliver(requireId(p), {
        actionId: str(p.actionId),
        ...(typeof p.freeText === 'string' ? { freeText: p.freeText } : {}),
      }) as unknown as Record<string, unknown>;
    case 'human-reply':
      return await humanReplyAndDeliver(requireId(p), { text: str(p.text) }) as unknown as Record<string, unknown>;
    default:
      throw new LetterError(`unknown human-inbox action: ${sub}`, 'invalid', 400);
  }
}
