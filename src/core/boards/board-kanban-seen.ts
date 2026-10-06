/**
 * The user's "Changed since you last looked" baseline of a Board's kanban
 * (spec 8.4): kept on the server beside the board (`kanban_seen`), so every
 * window and device counts the same changes. Humans only: a session's write
 * is 403 human_only (it is the user's attention, not the leader's).
 *
 * A write names cards (a list, or 'all'), may carry the snapshot the browser
 * showed for some of them (those entries win: they are what the user saw), and
 * may end a visit. Listed cards without a snapshot entry are computed here with
 * the same rules the web uses (placeCard, displayedSummary, summaryHash). 'all'
 * or the end of a visit moves the old `at` to `previous_at` and starts a new
 * baseline time. Entries of tasks no longer on the team are dropped. The first
 * write creates the board file when there is none (html '', version 0).
 */

import { BoardError, emitChanged, emptyBoard, updateBoard, type BoardWriter } from './board-store.js';
import { teamSnapshot, teamTags } from './board-team.js';
import { placeTask } from './board-kanban.js';
import {
  displayedSummary, effectiveLanes, MAX_CARDS, placeCard, summaryHash,
  type BoardCard, type BoardKanbanSeen, type BoardKanbanSeenCard, type BoardLane,
} from './board-lanes.js';
import type { Task } from '../types.js';

export interface KanbanSeenInput {
  cards?: string[] | 'all';
  snapshot?: Record<string, BoardKanbanSeenCard>;
  /** The visit ended (pane hidden, window away): start a new baseline time. */
  visit_end?: boolean;
}

/** One card as the server would show it now: the baseline entry for a card with no snapshot. */
export function seenEntryFor(card: BoardCard | undefined, task: Task, lanes: readonly BoardLane[]): BoardKanbanSeenCard {
  const lane = placeCard(card, placeTask(task), lanes).lane;
  const entry: BoardKanbanSeenCard = { lane, summaryHash: summaryHash(displayedSummary(card, task.summary)?.text ?? '') };
  if (card?.output_at) entry.outputAt = card.output_at;
  entry.unread = !!task.unread;
  return entry;
}

function checkSnapshot(raw: unknown): Record<string, BoardKanbanSeenCard> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BoardError('bad_request', 400, undefined, '`snapshot` must be an object of card id to { lane, summaryHash }');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_CARDS) throw new BoardError('bad_request', 400, { max: MAX_CARDS }, `\`snapshot\` holds at most ${MAX_CARDS} cards`);
  const out: Record<string, BoardKanbanSeenCard> = {};
  for (const [id, v] of entries) {
    const e = v as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || typeof e.lane !== 'string' || typeof e.summaryHash !== 'string') {
      throw new BoardError('bad_request', 400, { task: id }, `snapshot["${id}"] must be { lane, summaryHash, outputAt?, unread? }`);
    }
    const entry: BoardKanbanSeenCard = { lane: e.lane, summaryHash: e.summaryHash };
    if (typeof e.outputAt === 'string' && e.outputAt) entry.outputAt = e.outputAt;
    if (typeof e.unread === 'boolean') entry.unread = e.unread;
    out[id] = entry;
  }
  return out;
}

export async function setKanbanSeen(
  ownerId: string,
  input: KanbanSeenInput,
  opts: { by: BoardWriter },
): Promise<{ kanban_seen: BoardKanbanSeen }> {
  if (opts.by !== 'human') throw new BoardError('human_only', 403, undefined, 'Only the user marks cards seen');
  const listed = input.cards;
  if (listed !== undefined && listed !== 'all'
    && (!Array.isArray(listed) || listed.some((id) => typeof id !== 'string'))) {
    throw new BoardError('bad_request', 400, undefined, '`cards` must be an array of task ids or "all"');
  }
  if (Array.isArray(listed) && listed.length > MAX_CARDS) throw new BoardError('bad_request', 400, { max: MAX_CARDS }, `\`cards\` holds at most ${MAX_CARDS} ids`);
  if (input.visit_end !== undefined && typeof input.visit_end !== 'boolean') throw new BoardError('bad_request', 400, undefined, '`visit_end` must be a boolean');
  const snapshot = checkSnapshot(input.snapshot);
  const snap = await teamSnapshot(ownerId);
  const next = await updateBoard(ownerId, (raw) => {
    const board = raw ?? emptyBoard(ownerId, 'human');
    const lanes = effectiveLanes(board.lanes, teamTags(snap), board.lanes_template).lanes;
    const prev = board.kanban_seen;
    const now = new Date().toISOString();
    const cards: Record<string, BoardKanbanSeenCard> = {};
    for (const [id, e] of Object.entries(prev?.cards ?? {})) if (snap.members.has(id)) cards[id] = e;
    const ids = listed === 'all' ? snap.children.map((t) => t.id) : (listed ?? []);
    for (const id of ids) {
      const task = snap.byId.get(id);
      if (!task || !snap.members.has(id) || snapshot[id]) continue;
      cards[id] = seenEntryFor(board.cards[id], task, lanes);
    }
    for (const [id, e] of Object.entries(snapshot)) if (snap.members.has(id)) cards[id] = e;
    const restart = !prev || listed === 'all' || input.visit_end === true;
    const seen: BoardKanbanSeen = { at: restart ? now : prev.at, cards };
    if (restart && prev?.at) seen.previous_at = prev.at;
    else if (!restart && prev?.previous_at) seen.previous_at = prev.previous_at;
    return { ...board, kanban_seen: seen };
  });
  emitChanged({ taskId: ownerId, kind: 'seen', kanban: true, version: next.version });
  return { kanban_seen: next.kanban_seen! };
}
