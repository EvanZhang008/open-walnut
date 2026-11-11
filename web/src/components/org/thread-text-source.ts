/**
 * Where each piece of an Org thread's text came from, so a path in it opens on the machine that
 * wrote it (2026-11-07: a summary's path, and a picture in an answer, were read on the node's
 * current machine, though another session on another host wrote them). Every block has its own
 * writer, recorded by the server (src/core/org/threads-model.ts):
 *
 *   summary   `reply_by` / `reply_sid` / `reply_host`, set when the summary's words changed
 *   answer    `answer.sid` / `answer.host`: the transcript (or letter turn) it was read from
 *   opener    `opener.by` / `opener.sid` / `opener.host`
 *   his words the user's own: the primary
 *
 * Never the node's current session, and never a message's `sid` (where his words went, not who
 * answered): a block with no writer recorded reads `unknownSource`, so its paths open nowhere and
 * its pictures do not load until the user picks a machine.
 */
import type { AgentTextSource } from '@/utils/agent-text-source';
import type { OrgThread, OrgThreadMessage } from '@/api/org-threads';

const PRIMARY: AgentTextSource = { host: '__local__' };
const UNKNOWN: AgentTextSource = { unknownSource: true };

function bySession(sid: string | undefined, host: string | undefined): AgentTextSource {
  if (!sid) return UNKNOWN;
  return { sessionId: sid, ...(host ? { host } : {}) };
}

/** The user's own words in a thread (his messages, his pictures): this machine, the primary. */
export const THREAD_WORDS_SOURCE: AgentTextSource = PRIMARY;

/** Where a thread's summary came from: its recorded writer only. */
export function threadSummarySource(t: Pick<OrgThread, 'reply_by' | 'reply_sid' | 'reply_host'>): AgentTextSource {
  if (t.reply_by === 'human') return PRIMARY;
  return bySession(t.reply_sid, t.reply_host);
}

/** Where a node's answer came from: the session it was read from. */
export function threadAnswerSource(a: NonNullable<OrgThreadMessage['answer']>): AgentTextSource {
  return bySession(a.sid, a.host);
}

/** Where the first post of a thread the node opened came from. */
export function threadOpenerSource(o: NonNullable<OrgThread['opener']>): AgentTextSource {
  if (o.by === 'human') return PRIMARY;
  return bySession(o.sid, o.host);
}

/** A click that reached the thread list outside every block: no writer to name. */
export const THREAD_LIST_SOURCE: AgentTextSource = UNKNOWN;

/**
 * Where Walnut's stand-in summary line came from: it is the first sentence of a node's answer or
 * post, so it opens where that block was written. The thread's `ask` carries no recorded writer.
 */
export function threadStandInSource(
  t: Pick<OrgThread, 'opener'>,
  line: { from?: string; exchange?: { answer?: OrgThreadMessage['answer'] } },
): AgentTextSource {
  if (line.from === 'answer' && line.exchange?.answer) return threadAnswerSource(line.exchange.answer);
  if (line.from === 'opener' && t.opener) return threadOpenerSource(t.opener);
  return UNKNOWN;
}
