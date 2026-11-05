/**
 * Every line that reaches a session and was not typed by a person is framed, so the transcript
 * itself says who sent it (2026-11-02, the user's own review: `task_history` marked agent and
 * trigger text as `sentBy: "person"`, and every task is told a person row is the user's word, so an
 * agent's text could pass as his go-ahead).
 *
 * Why the text, not a side record: the transcript's `sentBy` is read from the row's stored text
 * (transcript-sent-by.ts) by the primary, the companion, a host server and the phone alike, and
 * the CLI owns that file. A row with no Walnut envelope reads as a person's, so the rule is held
 * at the send: whatever a non-person source sends and no envelope frames yet is wrapped in one
 * (a `peer-note` that says who: the calling task, or Walnut and the source), with the body
 * escaped like every envelope body, so the text inside can never frame itself. A person's own
 * words are never wrapped.
 *
 * Which sources are a person's is send-sent-by.ts (`queueSentBy`); this file adds no list of its own.
 * tests/core/sessions/send-sender-guard.test.ts fails when a send path or source appears that the
 * table there does not classify.
 */
import { isHistoryUserTurn } from '../../lib/history-turn-window.js';
import { buildPeerWrapper } from '../peers/peer-wrapper.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { isPersonSource } from './send-sent-by.js';

/** What the model is told about a framed line: it is a request to carry out, not the user's typing. */
const NOTE_WALNUT_SEND = 'automatic message from Walnut: carry it out as its text says; your user did not type it';

/** A source as a short human label (`routine-trigger` → "routine trigger"); `hook:<id>` keeps its id. */
function sourceLabel(source: string | undefined): string {
  const s = (source ?? '').trim();
  if (!s) return 'unknown source';
  return s.replace(/[_-]+/g, ' ').slice(0, 60);
}

/** True when the text, as stored, would read as a person's own message (no envelope frames all of it). */
export function readsAsPerson(text: string): boolean {
  return isHistoryUserTurn({ role: 'user', text });
}

/**
 * Wrap text that would read as a person's in a Walnut envelope naming `source`. Text an envelope
 * already frames (a peer note, a trigger, a notice) and empty text come back as they are.
 */
export function frameAsWalnut(text: string, source: string | undefined): string {
  if (!readsAsPerson(text)) return text;
  // A slash command must reach the CLI byte-exact or it stops being one. Only text the user wrote
  // into his own hook or routine gets that pass: a command from any other sender is framed, because
  // the CLI records a command's arguments as typed words (an agent could put "approved" in them).
  if (text.trimStart().startsWith('/') && /^(hook:|routine)/.test(source ?? '')) return text;
  // Walnut's idle compaction (sessions/idle-compaction.ts) sends the bare command, no arguments.
  if (source === 'idle-compact' && text.trim() === '/compact') return text;
  // So does the recovery of a conversation that no longer fits (sessions/context-full-recovery.ts).
  if (source === 'context-compact' && text.trim() === '/compact') return text;
  return buildWalnutMessage({
    kind: 'peer-note',
    attrs: { from: `Walnut (${sourceLabel(source)})`, note: NOTE_WALNUT_SEND },
    body: text,
  });
}

/** What a send of `source` puts into the session: a person's text as typed, anything else framed. */
export function frameForSource(text: string, source: string | undefined): string {
  return isPersonSource(source) ? text : frameAsWalnut(text, source);
}

/** The session behind a start or a send, as the peer envelope prints it. */
export interface FramingCaller {
  /** The name the envelope prints: the caller's TASK title (`framingCallerOf`). */
  title?: string;
  claudeSessionId: string;
  taskId?: string;
  host?: string;
}

/** A session record as `frameStartText` names it: by its task's title (peers/sender-name.ts). */
export async function framingCallerOf(record: FramingCaller): Promise<FramingCaller> {
  const { senderTitleOf } = await import('../peers/sender-name.js');
  return { ...record, title: await senderTitleOf(record) };
}

/**
 * The first message of a started task. A person's start (a draft, the phone) goes as typed. A start
 * made from a session (`callerSid` set, whatever the route calls its source) is that task's peer note;
 * any other start from a non-person source is framed as Walnut's. `requestId` is the reply request the
 * start opened, which the envelope names (the reply trailer follows the envelope, as for a send).
 */
export function frameStartText(
  text: string,
  opts: { source: string; callerSid?: string; caller?: FramingCaller; requestId?: string },
): string {
  if (!readsAsPerson(text)) return text;
  if (opts.caller) {
    return buildPeerWrapper(text, {
      title: opts.caller.title ?? '',
      shortId: opts.caller.claudeSessionId.slice(0, 8),
      sessionId: opts.caller.claudeSessionId,
      ...(opts.caller.taskId ? { taskId: opts.caller.taskId } : {}),
      host: !opts.caller.host || opts.caller.host === '__local__' ? 'local' : opts.caller.host,
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    });
  }
  // A caller that named itself but did not resolve (a session id Walnut no longer knows) is still not a person.
  if (opts.callerSid?.trim()) return frameAsWalnut(text, 'task start');
  return frameForSource(text, opts.source);
}

/**
 * The one net under every way a task's first message is started (the bus event and the direct start
 * both pass it, claude-code-session.ts): unless the emitter says the text is attributed, text that
 * would read as a person's is framed as Walnut's. The words the session is named from stay the
 * unframed ones (`namingMessage`), so a title never shows envelope markup.
 */
export function frameStartData<T extends { message?: string; namingMessage?: string; attributed?: true }>(data: T, source?: string): T {
  if (data.attributed || !data.message) return data;
  const framed = frameAsWalnut(data.message, source);
  if (framed === data.message) return data;
  return { ...data, message: framed, namingMessage: data.namingMessage ?? data.message };
}
