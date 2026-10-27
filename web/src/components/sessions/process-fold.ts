/**
 * The work between two pieces of an answer, folded into one row.
 *
 * A turn reads "Read 2 files ›", "Edited 2 files ›", then a "To Walnut lead"
 * card, each its own row, so the steps the model took outweigh what it said.
 * Consecutive PROCESS rows (finished tool runs, messages sent to other tasks,
 * the messages and notices the session received: a peer's note, a reply,
 * Walnut's notifications, and the context the CLI injected: a loaded skill, a
 * re-invocation note) become one folded row, "Received a message, read 2
 * files, sent a message ›", and the rows themselves sit inside it, unchanged,
 * one click away. 2026-10-26, the user, of five such rows in a row: "we want
 * all these combine into one if they are neighbor".
 *
 * What stays out, on purpose:
 *  · every piece of text: narration between steps is part of the answer (a turn
 *    may hold several results), and only an explicit process type could ever
 *    say otherwise, which no row has today;
 *  · a failed tool, a question to the person, a plan, an agent card: each is
 *    something the reader must see, so it ends the group and renders as before;
 *  · the live tail: a run still receiving calls is the caller's to leave out
 *    (`isProcess` false), so it stays a running row until it is history.
 * A group of one plain tool run or one injected-context row is left alone (it
 * already is one folded row); one that holds a sent or received message folds,
 * since that card is the bulky part.
 * Pure: the caller says which rows are process and how to read their tools.
 */
import type { SessionHistoryTool } from '@/types/session';
import { toolRunPhrase } from './tool-run-phrase';

export interface ProcessParts<P> {
  kind: 'process';
  /** The rows, in order, rendered unchanged inside the fold. */
  parts: P[];
  /** Index of the first row in the input. */
  start: number;
}

export type ProcessItem<P> = { kind: 'one'; part: P; index: number } | ProcessParts<P>;

/**
 * Group consecutive process rows. `toolsOf` returns a row's tools when it is a
 * process row, `null` when it is not (text, an error, a question, the live tail).
 * `isOutbound` tells a sent message from a tool call.
 */
export function groupProcessParts<P>(
  parts: readonly P[],
  toolsOf: (part: P) => SessionHistoryTool[] | null,
  isOutbound: (tool: SessionHistoryTool) => boolean,
  /** A message the session received (a card row, no person's words in it). */
  isInbound: (part: P) => boolean = () => false,
  /** Context the CLI injected (a loaded skill, a note): already a folded row. */
  isContext: (part: P) => boolean = () => false,
  /** Reasoning alone (a "Thinking ›" row): it joins a group that holds a message
   *  or context, so a turn receiving notices while it works reads as one row; among
   *  tool runs alone it keeps its own row, as before. */
  isQuiet: (part: P) => boolean = () => false,
): ProcessItem<P>[] {
  const out: ProcessItem<P>[] = [];
  let run: P[] = [];
  let start = -1;
  let sent = false;
  let context = false;
  const emit = (members: P[], from: number) => {
    if (members.length >= 2 || (members.length === 1 && sent)) out.push({ kind: 'process', parts: members, start: from });
    else members.forEach((part, k) => out.push({ kind: 'one', part, index: from + k }));
  };
  const flush = () => {
    if (!sent && !context && run.some(isQuiet)) {
      // Nothing received, sent or injected: the reasoning splits the steps, as before.
      let sub: P[] = [];
      let subStart = start;
      run.forEach((part, k) => {
        if (!isQuiet(part)) { if (sub.length === 0) subStart = start + k; sub.push(part); return; }
        emit(sub, subStart);
        sub = [];
        out.push({ kind: 'one', part, index: start + k });
      });
      emit(sub, subStart);
    } else emit(run, start);
    run = [];
    start = -1;
    sent = false;
    context = false;
  };
  parts.forEach((part, i) => {
    if (isInbound(part)) {
      if (run.length === 0) start = i;
      run.push(part);
      sent = true;
      return;
    }
    if (isContext(part)) {
      if (run.length === 0) start = i;
      run.push(part);
      context = true;
      return;
    }
    if (isQuiet(part)) {
      if (run.length === 0) start = i;
      run.push(part);
      return;
    }
    const tools = toolsOf(part);
    if (!tools || tools.length === 0) {
      flush();
      out.push({ kind: 'one', part, index: i });
      return;
    }
    if (run.length === 0) start = i;
    run.push(part);
    if (tools.some(isOutbound)) sent = true;
  });
  flush();
  return out;
}

/** Injected-context rows in a fold, by kind (`injectedContextKind`). */
export interface ContextCounts { skills: number; other: number }

/** The folded row's line: what the steps did, in the words a tool run uses. */
export function processPhrase(
  tools: readonly SessionHistoryTool[],
  isOutbound: (tool: SessionHistoryTool) => boolean,
  received = 0,
  context: ContextCounts = { skills: 0, other: 0 },
): string {
  const calls = tools.filter((t) => !isOutbound(t));
  const sent = tools.length - calls.length;
  const pieces: string[] = [];
  if (received > 0) pieces.push(received === 1 ? 'received a message' : `received ${received} messages`);
  if (calls.length > 0) pieces.push(toolRunPhrase(calls).replace(/^./, (c) => c.toLowerCase()));
  if (context.skills > 0) pieces.push(context.skills === 1 ? 'loaded a skill' : `loaded ${context.skills} skills`);
  if (context.other > 0) pieces.push(context.other === 1 ? 'injected context' : `injected context ${context.other}\u00d7`);
  if (sent > 0) pieces.push(sent === 1 ? 'sent a message' : `sent ${sent} messages`);
  const phrase = pieces.join(', ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
