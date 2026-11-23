/**
 * A guidance that fills what the sessions read is the node's to tidy (2026-11-23 audit: with the
 * hint's room spent, every new lesson of a day was dropped as "not added" and nobody heard). Once a
 * day, while lessons wait for room, the node is told which ones and where its file is; it merges or
 * deletes lines with the work's context, and the waiting lessons go in on the next passes
 * (guidance-merge.ts backfillDropped). The reflection never rewrites the file wholesale itself: a
 * model rewriting many lines at once changed their meaning (guidance-align.ts).
 */
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { normalizeForQuote } from './judge.js';
import { droppedLessons } from './guidance-merge.js';
import { sessionNowOf } from './candidates.js';
import { guidanceFileOf, readGuidance } from './records.js';
import { localDate, readReflectionState, updateReflectionState } from './state.js';
import { guidanceRoomLeft } from './team-guidance-hint.js';

/** Below this much free room a waiting lesson cannot go in (a line is about 150 characters). */
export const TIDY_ROOM_MIN = 200;
/** Waiting lessons named in one note. */
const TIDY_LISTED_MAX = 8;

export interface TidyDeps {
  send: (task: Task, text: string, title: string) => Promise<boolean>;
  confirmSend?: (node: Task, task: Task, sessionId: string) => Promise<boolean | string>;
  currentSession?: (task: Task) => Promise<string>;
}

export function tidyNote(file: string, roomLeft: number, waiting: readonly string[]): string {
  return [
    `Your team guidance fills what your sessions read (${roomLeft < 0 ? `${-roomLeft} characters over` : `${roomLeft} characters left`}), so ${waiting.length} lesson${waiting.length === 1 ? '' : 's'} of the last days could not go in:`,
    ...waiting.slice(0, TIDY_LISTED_MAX).map((l) => `- ${l}`),
    ...(waiting.length > TIDY_LISTED_MAX ? [`- ... and ${waiting.length - TIDY_LISTED_MAX} more`] : []),
    `Make room in ${file}: merge lines that say the same, shorten long ones (keep every point and condition), delete what no longer holds. A lesson already said by a line needs no room. The file is on the machine Walnut's server runs on: from a session on another host, edit it there (host_exec on __local__). The waiting lessons go in by themselves once there is room. No reply is needed.`,
  ].join('\n');
}

/** Ask the node once today when lessons wait for room. True when it was asked. */
export async function askTidy(node: Task, nodeName: string, deps: TidyDeps, nowMs: number): Promise<boolean> {
  const date = localDate(nowMs);
  const state = await readReflectionState(node.id, nowMs);
  if (state.tidyAsked === date) return false;
  const lines = await readGuidance(node.id);
  const room = guidanceRoomLeft(nodeName, lines.map((l) => l.text));
  if (room >= TIDY_ROOM_MIN) return false;
  const done = new Set([...(state.backfilled ?? []), ...state.removed, ...(state.mergedLessons ?? []).map((m) => m.lesson)]);
  const waiting = (await droppedLessons(node.id, nowMs)).filter((l) => !done.has(normalizeForQuote(l.text))).map((l) => l.text);
  if (!waiting.length) return false;
  const sessionId = await sessionNowOf(node, deps);
  if (deps.confirmSend && !['ok', 'session_changed', true].includes(await deps.confirmSend(node, node, sessionId).catch(() => false))) return false;
  // Marked first: a send that fails is not repeated today.
  await updateReflectionState(node.id, (s) => { s.tidyAsked = date; }, nowMs);
  const ok = await deps.send(node, tidyNote(guidanceFileOf(node.id), room, waiting), `Team guidance is full: ${waiting.length} lesson(s) wait for room`).catch(() => false);
  if (ok) log.task.info('reflection: the node was asked to make room in its guidance', { nodeId: node.id, waiting: waiting.length, room });
  return ok;
}
