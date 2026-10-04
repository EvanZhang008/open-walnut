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
 * reply straight through to the client. The one addition: read / pin / archive
 * also carry `storeUpdatedAt` (and `superseded` on a refused late replay), which
 * the replica keeps for itself and strips before answering.
 */

import {
  agentReply,
  getLetter,
  listLetters,
  readLetterBodyRange,
  setLetterState,
  LetterError,
  type LetterStateWrite,
} from './store.js';
import { HUMAN_INBOX_CHUNK_BYTES } from './types.js';
import {
  answerLetterAndDeliver,
  humanReplyAndDeliver,
  sendLetterAsCaller,
} from './letter-ops.js';
import type { AgentReplyInput, NewLetter } from './types.js';

export { LetterError };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * How long a relayed answer or reply waits for its delivery before the primary
 * answers with the recorded turn and a `pending` delivery. Well inside the
 * replica route's own 12s deadline, which also has to cover the bridge round
 * trip: a replica that timed out first would tell the phone "try again" about a
 * reply the primary already threaded.
 */
const RELAY_DELIVERY_WAIT_MS = 7_000;

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

function sinceOf(p: Record<string, unknown>): { since?: number } {
  return typeof p.since === 'number' && Number.isFinite(p.since) && p.since > 0 ? { since: p.since } : {};
}

function stateWrite(write: LetterStateWrite): Record<string, unknown> {
  return {
    letter: write.letter,
    storeUpdatedAt: write.storeUpdatedAt,
    ...(write.superseded ? { superseded: true } : {}),
  };
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
    // One BOUNDED slice of a body document. This is the whole reason a letter's
    // html cap can be 100MB: a replica serving a phone's body request loops this
    // action, so the biggest thing that ever rides one bridge frame is a chunk —
    // not the document. `data` is base64 because a slice can split a UTF-8 char
    // (the caller reassembles bytes, then decodes), same contract as fs.readRange.
    case 'body': {
      const id = requireId(p);
      const turn = typeof p.turn === 'number' && Number.isInteger(p.turn) && p.turn >= 0 ? p.turn : undefined;
      const start = typeof p.start === 'number' && p.start >= 0 ? Math.trunc(p.start) : 0;
      const requested = typeof p.length === 'number' && p.length > 0 ? Math.trunc(p.length) : HUMAN_INBOX_CHUNK_BYTES;
      const slice = await readLetterBodyRange(id, {
        ...(turn !== undefined ? { turn } : {}),
        start,
        length: Math.min(requested, HUMAN_INBOX_CHUNK_BYTES),
      });
      if (!slice) throw new LetterError(`Letter body not found: ${id}`, 'not_found', 404);
      return {
        data: slice.data.toString('base64'),
        bytesRead: slice.bytesRead,
        fileSize: slice.fileSize,
        eof: slice.eof,
        format: slice.format,
      };
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
    // The reader's flags answer with the index clock the write stamped: that is
    // how the replica knows when its git-synced copy has caught up with it (see
    // replica-state.ts). `since` marks a replay of a change the human made while
    // this box was out of reach; a newer change on this box wins over it.
    case 'read':
      return stateWrite(await setLetterState(requireId(p), 'read', requireBool(p, 'read'), sinceOf(p)));
    case 'pin':
      return stateWrite(await setLetterState(requireId(p), 'pinned', requireBool(p, 'pinned'), sinceOf(p)));
    case 'archive':
      return stateWrite(await setLetterState(requireId(p), 'archived', requireBool(p, 'archived'), sinceOf(p)));
    case 'answer':
      // `'relay'`: this ran on the PRIMARY on behalf of a replica, so neither the console nor
      // the phone touched this box directly and claiming either would be a guess.
      return await answerLetterAndDeliver(requireId(p), {
        actionId: str(p.actionId),
        ...(typeof p.freeText === 'string' ? { freeText: p.freeText } : {}),
      }, 'relay', { answerBy: Date.now() + RELAY_DELIVERY_WAIT_MS }) as unknown as Record<string, unknown>;
    case 'human-reply':
      return await humanReplyAndDeliver(requireId(p), {
        text: str(p.text),
        ...(p.clientId !== undefined ? { clientId: str(p.clientId) } : {}),
      }, { answerBy: Date.now() + RELAY_DELIVERY_WAIT_MS }) as unknown as Record<string, unknown>;
    default:
      throw new LetterError(`unknown human-inbox action: ${sub}`, 'invalid', 400);
  }
}
