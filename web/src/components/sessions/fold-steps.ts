/**
 * The line a fold of quiet steps reads.
 *
 * A coordinating session takes in notices and peer messages between its answers
 * and works through each with a tool call or a one-line acknowledgement. Every
 * such stretch between two answers is one folded row (SessionChatHistory), and
 * its line is counts only: "Received 12 messages \u00b7 Sent 3 \u00b7 Ran 8 tools".
 * The opened fold shows each step. 2026-10-28, the user, of a line that named
 * every sender, notice and command and ran past the screen: "you just received
 * so many messages, sent so many, ran so many tools, that's it". Pure: the caller
 * turns its rows into steps.
 */
import type { EnvelopeSegment, SessionEnvelopePeer } from '@open-walnut/history-session-envelope';
import { noticeTitle } from './message-fold';
import type { ToolRunMember } from './tool-run-phrase';

export type ReceivedKind = 'peer-note' | 'reply' | 'notification' | 'trigger' | 'other';

export type FoldStep =
  /** A message or notice the session received. `name`: who sent it, or for a
   *  notice whom it is about; `title`: its one-line TL;DR, when it has one. */
  | { kind: 'received'; from: ReceivedKind; name?: string; title?: string }
  /** Tool calls (not messages to someone). */
  | { kind: 'calls'; tools: ToolRunMember[] }
  /** A message the session sent to another task. */
  | { kind: 'sent' }
  /** A letter the session wrote to the person's inbox. */
  | { kind: 'inbox' }
  /** Reasoning with no words and no call. */
  | { kind: 'thought' }
  /** Context the CLI injected. */
  | { kind: 'context'; skill: boolean }
  /** The no-action line alone: the turn needed nothing. */
  | { kind: 'ack' }
  /** Words the session wrote on the way (folded before an answer). */
  | { kind: 'update' };

/** A received row's steps, one per envelope it holds; a row with none is one
 *  message from no one in particular. `nameOf` names a sender (peer-name.ts). */
export function envelopeSteps(
  segments: readonly EnvelopeSegment[] | null | undefined,
  nameOf: (peer: SessionEnvelopePeer) => string | undefined = (p) => p.title,
): FoldStep[] {
  const out: FoldStep[] = [];
  for (const s of segments ?? []) {
    if (s.kind !== 'envelope') continue;
    const e = s.envelope;
    const from = e.kind === 'peer-note' || e.kind === 'reply' || e.kind === 'notification' || e.kind === 'trigger' ? e.kind : 'other';
    // A notice's outcome sentence is its title; a trigger's note is only its clock.
    const title = e.kind === 'notification' ? noticeTitle(e.statusLine) : e.kind === 'trigger' ? undefined : e.title;
    // A trigger and an App are named by what they print, as their cards are.
    const name = e.kind === 'trigger' || e.kind === 'app-state' ? e.peer.title : nameOf(e.peer);
    out.push({ kind: 'received', from, ...(name ? { name } : {}), ...(title ? { title } : {}) });
  }
  return out.length > 0 ? out : [{ kind: 'received', from: 'other' }];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The fold's line: counts only, "Received 12 messages · Sent 3 · Ran 8 tools".
 *  What each step was is inside the fold, one row per step, when it is opened.
 *  A stretch with none of the three reads by what it was: an update, an
 *  acknowledgement, or "Thinking", the old empty-fold line. */
export function foldStepsPhrase(steps: readonly FoldStep[]): string {
  let received = 0;
  let sent = 0;
  let tools = 0;
  let updates = 0;
  let acks = 0;
  for (const s of steps) {
    if (s.kind === 'received') received++;
    else if (s.kind === 'sent' || s.kind === 'inbox') sent++;
    else if (s.kind === 'calls') tools += s.tools.length;
    else if (s.kind === 'update') updates++;
    else if (s.kind === 'ack') acks++;
  }
  const pieces: string[] = [];
  if (received > 0) pieces.push(`Received ${count(received, 'message', 'messages')}`);
  if (sent > 0) pieces.push(`Sent ${sent}`);
  if (tools > 0) pieces.push(`Ran ${count(tools, 'tool', 'tools')}`);
  if (pieces.length > 0) return pieces.join(' \u00b7 ');
  if (updates > 0) return updates === 1 ? 'An update' : `${updates} updates`;
  return acks > 0 ? 'Acknowledged' : 'Thinking';
}
