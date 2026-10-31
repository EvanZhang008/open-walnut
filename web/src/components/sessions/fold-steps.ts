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
import type { ToolRunMember } from './tool-run-phrase';

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
  | { kind: 'notice'; error?: boolean };

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

/** The fold's line: counts only, "Received 12 messages · Sent 3 · Ran 8 tools",
 *  and the runtime's lines other than errors ("· 1 notice"; errors are the red count).
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
  for (const s of steps) {
    if (s.kind === 'received') received++;
    else if (s.kind === 'sent' || s.kind === 'inbox') sent++;
    else if (s.kind === 'calls') tools += s.tools.length;
    else if (s.kind === 'update') updates++;
    else if (s.kind === 'ack') acks++;
    else if (s.kind === 'notice') { if (s.error) errorNotices++; else notices++; }
  }
  const pieces: string[] = [];
  if (received > 0) pieces.push(`Received ${count(received, 'message', 'messages')}`);
  if (sent > 0) pieces.push(`Sent ${sent}`);
  if (tools > 0) pieces.push(`Ran ${count(tools, 'tool', 'tools')}`);
  if (notices > 0) pieces.push(count(notices, 'notice', 'notices'));
  if (pieces.length > 0) return pieces.join(' \u00b7 ');
  if (updates > 0) return updates === 1 ? 'An update' : `${updates} updates`;
  if (errorNotices > 0) return count(errorNotices, 'notice', 'notices');
  return acks > 0 ? 'Acknowledged' : 'Thinking';
}
