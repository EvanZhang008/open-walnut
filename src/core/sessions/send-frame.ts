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
import { parseSessionEnvelopes } from '../../lib/history-session-envelope.js';
import { buildPeerWrapper } from '../peers/peer-wrapper.js';
import { jobAppSender } from '../plugins/plugin-caller.js';
import { buildWalnutMessage, buildWalnutNote } from '../peers/walnut-message-tag.js';
import { hintBlocksIn } from '../hints/hint-format.js';
import { ambientAutomatedClient, automatedClientLabel } from './automated-client.js';
import { isPersonSource } from './send-sent-by.js';
import { walnutCommandFor } from './walnut-commands.js';

/** What the model is told about a framed line: it is a request to carry out, not the user's typing. */
const NOTE_WALNUT_SEND = 'automatic message from Walnut: carry it out as its text says; your user did not type it';

/** A source as a short human label (`routine-trigger` → "routine trigger"); `hook:<id>` keeps its id. */
function sourceLabel(source: string | undefined): string {
  const s = (source ?? '').trim();
  if (!s) return 'unknown source';
  return /^(automation:|caller:)/.test(s) ? s.slice(0, 120) : s.replace(/[_-]+/g, ' ').slice(0, 60);
}

/** True when the text, as stored, would read as a person's own message (no envelope frames all of it). */
export function readsAsPerson(text: string): boolean {
  return isHistoryUserTurn({ role: 'user', text });
}

/**
 * Wrap text that would read as a person's in a Walnut envelope naming `source`. Text an envelope
 * already frames (a peer note, a trigger, a notice) and empty text come back as they are.
 */
export function frameAsWalnut(text: string, source: string | undefined, label?: string): string {
  if (!readsAsPerson(text)) return text;
  // A slash command must reach the CLI byte-exact or it stops being one. Only text the user wrote
  // into his own hook or routine gets that pass: a command from any other sender is framed, because
  // the CLI records a command's arguments as typed words (an agent could put "approved" in them).
  if (text.trimStart().startsWith('/') && /^(hook:|routine)/.test(source ?? '')) return text;
  // Walnut's own commands (the idle compaction, the recovery of a full context) go out raw too:
  // only the listed line of each, whose own words say Walnut sent it (sessions/walnut-commands.ts).
  if (walnutCommandFor(source, text)) return text;
  return buildWalnutMessage({
    kind: 'peer-note',
    attrs: { from: `Walnut (${label ?? sourceLabel(source)})`, note: NOTE_WALNUT_SEND },
    body: text,
  });
}

/**
 * Walnut's own notes that ride in front of a message (session-message-queue.ts): every word of them
 * must sit inside an envelope, because words between or after envelopes are read as the person's
 * (transcript-sent-by.ts personTextOf). Loose text is framed in place; envelopes stay byte for
 * byte, so a note with nothing loose comes back identical. Class guard:
 * tests/core/sessions/rider-framing-guard.test.ts.
 */
export function frameLooseText(text: string): string {
  if (!text.trim()) return text;
  const segments = parseSessionEnvelopes(text) ?? [{ kind: 'text' as const, text }];
  let changed = false;
  const out = segments.map((s) => {
    if (s.kind === 'envelope') return s.envelope.raw;
    // Walnut's hint blocks (hints/hint-format.ts) are framed already: personTextOf reads past them.
    const blocks = hintBlocksIn(s.text);
    let rest = s.text;
    for (const b of blocks) rest = rest.replace(b, '');
    if (!rest.trim()) return s.text;
    changed = true;
    return [...blocks, buildWalnutNote(rest.trim())].join('\n\n');
  });
  return changed ? out.filter((t) => t.trim()).join('\n\n') : text;
}

/**
 * A row another queue already framed (the leader's queue row handed to the host that runs the
 * session, host-api.ts QueuedLine: its notes and hints already in the text). Its envelopes are that
 * queue's own framing, and any envelope a sender typed was escaped into words there, so they stay
 * byte for byte; only words outside them are framed, as Walnut's notes are (frameLooseText). A row
 * with no envelope is framed as a send of `source` is. Framing the whole row again put a second
 * envelope around the first and escaped it into words (2026-11-24: rows whose notes or hints sat
 * after their envelopes read as typed words, so the host wrapped each whole as "Walnut (peer)").
 */
export function frameQueuedRow(text: string, source: string | undefined): string {
  if (!readsAsPerson(text)) return text;
  const segments = parseSessionEnvelopes(text);
  return segments?.some((s) => s.kind === 'envelope') ? frameLooseText(text) : frameAsWalnut(text, source);
}

/**
 * What a send of `source` puts into the session: a person's text as typed, anything else framed. A
 * person's source sent by a browser under automation is not a person's (send-sent-by.ts).
 */
export function frameForSource(text: string, source: string | undefined): string {
  // A person's route reached by a browser under automation (automated-client.ts) is named as that.
  return isPersonSource(source) ? text : frameAsWalnut(text, source, automatedLabel());
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
 * start opened, which the envelope names (the reply trailer follows the envelope, as for a send). `job`: a
 * plugin job its host's daemon vouched for (plugin-jobs/job-caller.ts), whose start is its App's job's note.
 */
export function frameStartText(
  text: string,
  opts: { source: string; callerSid?: string; caller?: FramingCaller; requestId?: string; job?: { plugin: string; job: string; host: string } },
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
  if (opts.job) {
    return buildPeerWrapper(text, {
      title: '', shortId: '', anonymous: true, ...jobAppSender(opts.job),
      host: !opts.job.host || opts.job.host === '__local__' ? 'local' : opts.job.host,
    });
  }
  // A caller that named itself but did not resolve (a session id Walnut no longer knows) is still not a person.
  if (opts.callerSid?.trim()) return frameAsWalnut(text, `caller:${opts.callerSid.trim()}`);
  if (opts.source?.startsWith('automation:')) return buildPeerWrapper(text, {
    title: '', shortId: '', host: 'unknown', anonymous: true, automation: opts.source.slice('automation:'.length),
  });
  return frameForSource(text, opts.source);
}

/** The sender a browser under automation's framed text names, while its request is open. */
function automatedLabel(): string | undefined {
  const automated = ambientAutomatedClient();
  return automated ? automatedClientLabel(automated) : undefined;
}

/**
 * A start whose first message a person typed (the console's composer, a side question, the
 * companion's chat) says so, unless a browser under automation typed it (automated-client.ts): then
 * the runner frames it as Walnut's, named as that automation.
 */
export function attributedUnlessAutomated(source: string): { attributed?: true; attributionSource: string } {
  const automated = ambientAutomatedClient();
  return automated ? { attributionSource: automatedClientLabel(automated) } : { attributed: true, attributionSource: source };
}

/**
 * The one net under every way a task's first message is started (the bus event and the direct start
 * both pass it, claude-code-session.ts): unless the emitter says the text is attributed AND names
 * its source, text that would read as a person's is framed as Walnut's. The words the session is named from stay the
 * unframed ones (`namingMessage`), so a title never shows envelope markup.
 */
export function frameStartData<T extends { message?: string; namingMessage?: string; attributed?: true; attributionSource?: string }>(data: T, source?: string): T {
  // A boolean alone names nobody. A new path cannot opt out of framing by copying it.
  if ((data.attributed && data.attributionSource?.trim()) || !data.message) return data;
  const framed = frameAsWalnut(data.message, data.attributionSource ?? source);
  if (framed === data.message) return data;
  return { ...data, message: framed, namingMessage: data.namingMessage ?? data.message };
}
