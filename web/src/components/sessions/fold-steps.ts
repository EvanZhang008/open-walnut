/**
 * The line a fold of quiet steps reads.
 *
 * A coordinating session takes in notices and peer messages between its answers
 * and works through each with a tool call or a one-line acknowledgement. Every
 * such stretch between two answers is one folded row (SessionChatHistory), and
 * its line counts what came in, went out and ran: "Received 12 messages \u00b7
 * Sent 2 \u00b7 Ran 8 tools". The opened fold shows each step, who sent it and
 * where it went. 2026-10-28, the user, of a line that named every sender, notice
 * and command and ran past the screen: "you just received so many messages, sent
 * so many, ran so many tools, that's it". 2026-10-31, the user again, of a line
 * that named its senders: "just Received 1 message", so the line names no one;
 * the names live in the opened rows. Pure: the caller turns its rows into steps.
 */
import type { EnvelopeSegment } from '@open-walnut/history-session-envelope';
import { noticeTitle } from './message-fold';
import { COMPACTED_MESSAGE, COMPACTING_MESSAGE, COMPACTION_FAILED_MESSAGE, COMPACTION_STOPPED_MESSAGE } from '@open-walnut/compaction-notice';
import { isIdleCompactLine } from '../../../../src/core/sessions/prompt-cache';
import { walnutNoticeKind } from '../../../../src/core/sessions/walnut-commands';
import type { ToolRunMember } from './tool-run-phrase';

/** The variant a row of Claude Code's own error reply ("Prompt is too long") draws with: an error line in the notice grey. */
export const CLI_ERROR_VARIANT = 'cli-error';

/** The variant a saved system row draws with. */
export function systemRowVariant(m: { systemVariant?: string; cliError?: true }): string {
  return m.cliError ? CLI_ERROR_VARIANT : m.systemVariant ?? 'info';
}

export type ReceivedKind = 'peer-note' | 'reply' | 'notification' | 'trigger' | 'other';

export type FoldStep =
  /** A message or notice the session received; `title`: its one-line TL;DR, when
   *  it has one. No sender: the line names no one, and a notice's `about` is its
   *  subject, not its sender (2026-10-31: Main's fold read "from CEO", itself). */
  | { kind: 'received'; from: ReceivedKind; title?: string }
  /** Tool calls (not messages to someone). */
  | { kind: 'calls'; tools: ToolRunMember[] }
  /** A message the session sent to another task, one per target; `to`: the
   *  target task's title when the call names it (send-targets.ts). */
  | { kind: 'sent'; to?: string }
  /** A letter the session wrote to the person's inbox. */
  | { kind: 'inbox' }
  /** Reasoning with no words and no call. */
  | { kind: 'thought' }
  /** Context the CLI injected. */
  | { kind: 'context'; skill: boolean }
  /** The no-action line alone: the turn needed nothing. */
  | { kind: 'ack' }
  /** Words the session wrote on the way (folded before an answer). */
  | { kind: 'update' }
  /** A line the session's runtime wrote (an API error, a retry, a compaction).
   *  An error one is counted by the fold's red "N failed", not on its line. */
  | { kind: 'notice'; error?: boolean; compact?: CompactLine };

/** A received row's steps, one per envelope it holds; a row with none is one
 *  message from no one in particular. */
export function envelopeSteps(segments: readonly EnvelopeSegment[] | null | undefined): FoldStep[] {
  const out: FoldStep[] = [];
  for (const s of segments ?? []) {
    if (s.kind !== 'envelope') continue;
    const e = s.envelope;
    const from = e.kind === 'peer-note' || e.kind === 'reply' || e.kind === 'notification' || e.kind === 'trigger' ? e.kind : 'other';
    // A notice's outcome sentence is its title; a trigger's note is only its clock.
    const title = e.kind === 'notification' ? noticeTitle(e.statusLine) : e.kind === 'trigger' ? undefined : e.title;
    out.push({ kind: 'received', from, ...(title ? { title } : {}) });
  }
  return out.length > 0 ? out : [{ kind: 'received', from: 'other' }];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A runtime row that is part of a compaction's story: the compaction itself (`cli`), or Walnut's
 *  line saying it sent one, while idle (`idle`) or for a conversation that no longer fit (`context`;
 *  `walnut` for a wording this release does not know). */
export type CompactLine = 'cli' | 'idle' | 'context' | 'walnut';

/** Which Walnut compaction line a row is, if any (sessions/walnut-commands.ts, prompt-cache.ts). */
export function walnutCompactLine(text: string | undefined): Exclude<CompactLine, 'cli'> | undefined {
  if (isIdleCompactLine(text)) return 'idle';
  const kind = walnutNoticeKind(text);
  return kind === 'context' ? 'context' : kind === 'other' ? 'walnut' : kind;
}

/** A finished compaction's name: who made it and why, when Walnut did. */
function compactedName(lines: ReadonlySet<CompactLine>): string {
  if (lines.has('idle')) return 'Compacted by Walnut while idle';
  if (lines.has('context')) return 'Compacted by Walnut to fit the context window';
  return lines.has('walnut') ? 'Compacted by Walnut' : 'Context compacted';
}

/** The fold's line: counts only, "Received 12 messages · Sent 3 · Ran 8 tools",
 *  and the runtime's lines other than errors ("· 1 notice"; errors are the red count);
 *  a compaction by name ("Context compacted", "Compacted by Walnut while idle").
 *  What each step was is inside the fold, one row per step, when it is opened.
 *  A stretch with none of the three reads by what it was: an update, a
 *  runtime notice, an acknowledgement, or "Thinking", the old empty-fold line. */
export function foldStepsPhrase(steps: readonly FoldStep[]): string {
  let received = 0;
  let sent = 0;
  let tools = 0;
  let updates = 0;
  let acks = 0;
  let notices = 0;
  let errorNotices = 0;
  let compacted = false;
  const walnutLines = new Set<CompactLine>();
  for (const s of steps) {
    if (s.kind === 'received') received++;
    else if (s.kind === 'sent' || s.kind === 'inbox') sent++;
    else if (s.kind === 'calls') tools += s.tools.length;
    else if (s.kind === 'update') updates++;
    else if (s.kind === 'ack') acks++;
    else if (s.kind === 'notice') {
      if (s.compact === 'cli') compacted = true;
      else if (s.compact) { walnutLines.add(s.compact); notices++; }
      else if (s.error) errorNotices++;
      else notices++;
    }
  }
  // Walnut's own line about its compaction is the compaction's when one came, else a notice (a
  // compaction stopped halfway made none).
  if (compacted) notices -= steps.filter((s) => s.kind === 'notice' && s.compact && s.compact !== 'cli').length;
  const pieces: string[] = [];
  // A compaction is said by name, never counted as a notice (2026-11-04 review: "2 notices" hid it).
  if (compacted) pieces.push(compactedName(walnutLines));
  if (received > 0) pieces.push(`Received ${count(received, 'message', 'messages')}`);
  if (sent > 0) pieces.push(`Sent ${sent}`);
  if (tools > 0) pieces.push(`Ran ${count(tools, 'tool', 'tools')}`);
  if (notices > 0) pieces.push(count(notices, 'notice', 'notices'));
  if (pieces.length > 0) return pieces.join(' \u00b7 ');
  if (updates > 0) return updates === 1 ? 'An update' : `${updates} updates`;
  if (errorNotices > 0) return count(errorNotices, 'notice', 'notices');
  return acks > 0 ? 'Acknowledged' : 'Thinking';
}

/**
 * The rows a run shows when opened: all of them, except the finished compaction's own row when its
 * line names Walnut's compaction with the size (one finished compaction, its size known), since that
 * line already says it. Walnut's notice of why stays.
 */
export function systemRunShows<T extends { variant: string; message: string; detail?: string }>(members: readonly T[]): readonly T[] {
  const done = members.filter((m) => m.variant === 'compact' && m.message === COMPACTED_MESSAGE);
  if (done.length !== 1 || !done[0]!.detail || !members.some((m) => walnutCompactLine(m.message))) return members;
  return members.filter((m) => m !== done[0]);
}

/**
 * A run of runtime rows' line. A compaction says so by name, with its size change and the count of
 * the other rows. Only one that made its boundary says compacted ("Context compacted"); one still
 * running says compacting, and one stopped halfway ("Compaction stopped") says stopped.
 */
export function systemRunLabel(members: readonly { variant: string; message: string; detail?: string }[]): string {
  const lines = new Set<CompactLine>(members.flatMap((m) => { const l = walnutCompactLine(m.message); return l ? [l] : []; }));
  const walnut = members.filter((m) => walnutCompactLine(m.message)).length;
  const compacts = members.filter((m) => m.variant === 'compact');
  const done = compacts.filter((m) => m.message === COMPACTED_MESSAGE);
  const more = (named: number) => {
    const n = members.length - named - walnut;
    return n > 0 ? ` \u00b7 ${n} more` : '';
  };
  if (done.length > 0) {
    const size = done[done.length - 1]!.detail;
    return `${compactedName(lines)}${size ? ` \u00b7 ${size}` : ''}${more(done.length)}`;
  }
  const last = compacts[compacts.length - 1]?.message;
  if (last === COMPACTING_MESSAGE) return `${lines.has('idle') ? 'Compacting while idle' : lines.has('context') ? 'Compacting to fit the context window' : 'Compacting context'}${more(compacts.length)}`;
  if (last === COMPACTION_STOPPED_MESSAGE) return `Compaction stopped${more(compacts.length)}`;
  if (last === COMPACTION_FAILED_MESSAGE) return `Compaction failed${more(compacts.length)}`;
  // Walnut asked for a compaction and an error came instead of its boundary.
  const errors = members.filter((m) => m.variant === 'error' || m.variant === CLI_ERROR_VARIANT).length;
  if (lines.size > 0 && errors > 0) return `Compaction failed${more(errors)}`;
  return `${members.length} system messages`;
}
