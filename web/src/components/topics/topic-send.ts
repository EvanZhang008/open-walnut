/**
 * The rules of one send from the browser, kept pure so tests reach them (useTopics applies them):
 *
 *  - Which clientId a POST carries. The server answers a repeated clientId with the first result, so
 *    a send whose answer failed or was lost, sent again with the same words, reuses the clientId kept
 *    with those words; other words get a fresh one. Kept per topic until a send succeeds.
 *  - How the local copy drawn at once meets the server's. The server returns the clientId to its
 *    author, so a server message with the local copy's clientId (or its id) replaces it, whichever
 *    arrives first: the POST's answer or a read after `topic:updated`. One message is never drawn twice.
 */
import type { TopicMessage } from '@/api/topics';

/** A send not yet answered with success: its words and the clientId it went with. */
export interface PendingSend { text: string; clientId: string }

/** The clientId for sending `text`: the pending one when these are its words again (a retry), else a fresh one. */
export function sendClientId(pending: PendingSend | undefined, text: string, fresh: () => string): string {
  return pending && pending.text === text ? pending.clientId : fresh();
}

type Msg = Pick<TopicMessage, 'id' | 'clientId'> & { local?: 'sending' };

/** One message, by its id or by the clientId its send carried. */
const sameSend = (a: Msg, b: Msg): boolean => a.id === b.id || (!!a.clientId && a.clientId === b.clientId);

/** A fresh read of the topic, with the copies still on their way drawn after it: one the read holds already goes. */
export function withSending<M extends Msg>(read: readonly M[], before: readonly M[]): M[] {
  const sending = before.filter((m) => m.local && !read.some((x) => sameSend(x, m)));
  return sending.length ? [...read, ...sending] : [...read];
}

/**
 * The POST's answer in place of its local copy `localId` (found by id, or by clientId): where the copy
 * stood, or not again when a read already brought it.
 */
export function withAnswer<M extends Msg>(messages: readonly M[], answer: M, localId: string): M[] {
  const isCopy = (m: M) => !!m.local && (m.id === localId || sameSend(m, answer));
  const at = messages.findIndex(isCopy);
  const kept = messages.filter((m) => !isCopy(m));
  if (kept.some((m) => sameSend(m, answer))) return kept;
  const where = at === -1 ? kept.length : at;
  return [...kept.slice(0, where), answer, ...kept.slice(where)];
}
