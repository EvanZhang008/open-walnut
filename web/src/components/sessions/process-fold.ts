/**
 * The work between two pieces of an answer, folded into one row.
 *
 * A turn reads "Read 2 files ›", "Edited 2 files ›", then a "To Walnut lead"
 * card, each its own row, so the steps the model took outweigh what it said.
 * Consecutive PROCESS rows (finished tool runs and messages sent to other
 * tasks) become one folded row, "Read 2 files, edited 2 files, sent a message ›",
 * and the rows themselves sit inside it, unchanged, one click away.
 *
 * What stays out, on purpose:
 *  · every piece of text: narration between steps is part of the answer (a turn
 *    may hold several results), and only an explicit process type could ever
 *    say otherwise, which no row has today;
 *  · a failed tool, a question to the person, a plan, an agent card: each is
 *    something the reader must see, so it ends the group and renders as before;
 *  · the live tail: a run still receiving calls is the caller's to leave out
 *    (`isProcess` false), so it stays a running row until it is history.
 * A group of one plain tool run is left alone (it already is one folded row);
 * one that holds a sent message folds, since that card is the bulky part.
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
): ProcessItem<P>[] {
  const out: ProcessItem<P>[] = [];
  let run: P[] = [];
  let start = -1;
  let sent = false;
  const flush = () => {
    if (run.length >= 2 || (run.length === 1 && sent)) out.push({ kind: 'process', parts: run, start });
    else run.forEach((part, k) => out.push({ kind: 'one', part, index: start + k }));
    run = [];
    start = -1;
    sent = false;
  };
  parts.forEach((part, i) => {
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

/** The folded row's line: what the steps did, in the words a tool run uses. */
export function processPhrase(tools: readonly SessionHistoryTool[], isOutbound: (tool: SessionHistoryTool) => boolean): string {
  const calls = tools.filter((t) => !isOutbound(t));
  const sent = tools.length - calls.length;
  const pieces: string[] = [];
  if (calls.length > 0) pieces.push(toolRunPhrase(calls).replace(/^./, (c) => c.toLowerCase()));
  if (sent > 0) pieces.push(sent === 1 ? 'sent a message' : `sent ${sent} messages`);
  const phrase = pieces.join(', ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
