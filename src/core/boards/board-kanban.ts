/**
 * Kanban writes of a Board (spec: lanes, cards, moves, suggestions, cards
 * made from a lane). The pure rules live in board-lanes.ts (the web places
 * cards with the same code); this file is the locked server half.
 *
 * Every write goes through board-store's `updateBoard` (one lock per board)
 * and emits BOARD_CHANGED with kind 'lanes' or 'card'. None bumps `version`
 * (that counts html only), so a leader's expectVersion is never broken by a
 * drag. A board with no file yet is CREATED by the first write here (html '',
 * version 0), and the first lane or card write materializes the lane template
 * the team's tags pick, so a placement always names a lane that exists.
 *
 * Who wins (4.3): a session (`by: task:<id>`) changing the lane of a card the
 * user placed is 409 status_set_by_user unless overrideUser; the refusal is
 * not silent: the session's lane is kept on the card as `lane_suggested` in the
 * same lock, for the user to accept or dismiss. Same for a session rewriting
 * lanes the user wrote. Summary, waiting_on and rank: the last writer wins.
 */

import type { Task } from '../types.js';
import { BoardError, emitChanged, emptyBoard, updateBoard, type BoardFile, type BoardWriter } from './board-store.js';
import { teamSnapshot, teamTags, type TeamSnapshot } from './board-team.js';
import {
  laneById, makeLaneId, MAX_CARDS, MAX_SUMMARY, MAX_WAITING_ON, pickLaneTemplate, placeCard, templateLanes,
  validateLanes, type BoardCard, type BoardLane, type LaneTemplateId, type PlaceTask,
} from './board-lanes.js';

export interface KanbanWriteOpts {
  by: BoardWriter;
  /** A session replacing the user's pick (lane, lanes). */
  overrideUser?: boolean;
  /** The `*_at` the writer saw when it opened its editor ('' = there was none): a later one is 409 changed_since. */
  ifUnchangedSince?: string;
  /** A board still on its template keeps this one (the lanes the writer saw), not the one the team's tags pick now. */
  template?: LaneTemplateId;
}

/** The facts placement reads from a task ("had a session" only ever grows). */
export function placeTask(t: Pick<Task, 'phase' | 'completed_at' | 'session_ids' | 'session_id' | 'exec_session_id' | 'plan_session_id'>): PlaceTask {
  const hasHadSession = (t.session_ids?.length ?? 0) > 0 || !!t.session_id || !!t.exec_session_id || !!t.plan_session_id;
  return { phase: t.phase, ...(t.completed_at ? { completed_at: t.completed_at } : {}), hasHadSession };
}

function isLater(a: string | undefined, b: string | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a), tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? a > b : ta > tb;
}

const laneName = (lanes: readonly BoardLane[], id: string | undefined) => laneById(lanes, id)?.name ?? id ?? '';
const writerTaskId = (by: BoardWriter) => (by === 'human' ? '' : by.slice('task:'.length));

/**
 * The board a kanban write starts from: the file (or a new empty one), its
 * lanes materialized from the template when it has none, and card keys that
 * are no longer on the team dropped (a deleted task, a task moved away).
 */
export function prepareKanbanBoard(
  raw: BoardFile | null, ownerId: string, snap: TeamSnapshot, by: BoardWriter, keepTemplate?: LaneTemplateId,
): BoardFile {
  const board = raw ?? emptyBoard(ownerId, by);
  let lanes = board.lanes;
  let template = board.lanes_template;
  if (!lanes || lanes.length === 0) {
    template = keepTemplate ?? pickLaneTemplate(teamTags(snap));
    lanes = templateLanes(template);
  }
  const cards: Record<string, BoardCard> = {};
  for (const [id, card] of Object.entries(board.cards)) if (snap.members.has(id)) cards[id] = card;
  return { ...board, lanes, ...(template ? { lanes_template: template } : {}), cards };
}

/** The lane a card shows in right now. */
export function laneEffective(board: Pick<BoardFile, 'lanes'>, card: BoardCard | undefined, task: Task | undefined): string {
  return placeCard(card, task ? placeTask(task) : {}, board.lanes ?? []).lane;
}

/** A card id the route named: a task below the owner, never the owner itself. */
export function requireCardTask(ownerId: string, cardId: string, snap: TeamSnapshot): Task {
  if (cardId === ownerId) throw new BoardError('owner_is_not_a_card', 400, { task: cardId }, 'The board\'s own task is not a card on it');
  const task = snap.byId.get(cardId);
  if (!task || !snap.members.has(cardId)) {
    throw new BoardError('not_in_team', 404, { task: cardId }, `Task ${cardId} is not on this board's team (a subtask of ${ownerId})`);
  }
  return task;
}

/** Resolve an id or unique prefix to a full task id (unknown ids pass through for the team check to refuse). */
export async function fullTaskId(raw: string): Promise<string> {
  const { getTask } = await import('../task-manager.js');
  return getTask(raw).then((t) => t.id, () => raw);
}

function lanesEqual(a: readonly BoardLane[], b: readonly BoardLane[]): boolean {
  return a.length === b.length && a.every((l, i) => l.id === b[i].id && l.name === b[i].name && l.kind === b[i].kind
    && !!l.complete_on_drop === !!b[i].complete_on_drop);
}

/**
 * Replace the whole lane table: order is column order, an entry with no id is
 * a new lane (`ln-` + 8 hex), an old id left out is deleted. Deleting a lane
 * clears the explicit lane and the rank of its cards in the same write (they
 * go back to automatic placement), and drops suggestions and auto lanes that
 * named it. Returns the cards that lost their explicit lane.
 */
export async function setBoardLanes(
  ownerId: string,
  input: unknown,
  opts: KanbanWriteOpts,
): Promise<{ lanes: BoardLane[]; cards_unplaced: string[] }> {
  const checked = validateLanes(input, { newId: () => makeLaneId() });
  if (!checked.ok) {
    throw new BoardError(checked.reason, 400, checked.max !== undefined ? { max: checked.max } : undefined, checked.message);
  }
  const snap = await teamSnapshot(ownerId);
  const unplaced: string[] = [];
  const next = await updateBoard(ownerId, (raw) => {
    unplaced.length = 0;
    const board = prepareKanbanBoard(raw, ownerId, snap, opts.by);
    const before = board.lanes ?? [];
    if (opts.ifUnchangedSince !== undefined && isLater(board.lanes_at, opts.ifUnchangedSince)) {
      throw new BoardError('changed_since', 409, { current: before, at: board.lanes_at, by: board.lanes_by },
        'The lanes changed since you opened them: keep yours by writing again without if_unchanged_since, or use theirs.');
    }
    if (lanesEqual(before, checked.lanes) && raw?.lanes) return { ...board };
    if (opts.by !== 'human' && board.lanes_by === 'human' && !opts.overrideUser) {
      throw new BoardError('status_set_by_user', 409, { lanes_at: board.lanes_at },
        `The user set this board's lanes${board.lanes_at ? ` ${readableAt(board.lanes_at)}` : ''}. `
        + 'Leave the lanes as they are to keep their setup, or pass override_user: true to replace it.');
    }
    const kept = new Set(checked.lanes.map((l) => l.id));
    const cards: Record<string, BoardCard> = {};
    for (const [id, card] of Object.entries(board.cards)) {
      const c: BoardCard = { ...card };
      if (c.lane && !kept.has(c.lane)) {
        delete c.lane; delete c.lane_at; delete c.lane_by;
        unplaced.push(id);
      }
      if (c.rank_lane && !kept.has(c.rank_lane)) { delete c.rank; delete c.rank_lane; }
      if (c.lane_auto && !kept.has(c.lane_auto.lane)) delete c.lane_auto;
      if (c.lane_suggested && !kept.has(c.lane_suggested.lane)) delete c.lane_suggested;
      cards[id] = c;
    }
    return { ...board, lanes: checked.lanes, lanes_at: new Date().toISOString(), lanes_by: opts.by, cards };
  });
  emitChanged({ taskId: ownerId, kind: 'lanes', version: next.version });
  return { lanes: next.lanes ?? [], cards_unplaced: [...unplaced] };
}

export interface CardInput {
  /** A lane id; '' clears the explicit placement (back to automatic). */
  lane?: string;
  /** <= MAX_SUMMARY chars; '' clears the card's summary. */
  summary?: string;
  /** <= MAX_WAITING_ON chars; '' clears it. */
  waiting_on?: string;
}

function checkText(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new BoardError('bad_request', 400, { field }, `\`${field}\` must be a string ("" clears it)`);
  const text = v.trim();
  if (text.length > max) throw new BoardError('bad_request', 400, { field, max }, `\`${field}\` has at most ${max} characters`);
  return text;
}

/** 409 changed_since when a field the writer edits was written after `since` (G31). */
function checkUnchanged(card: BoardCard | undefined, fields: Array<'lane' | 'summary' | 'waiting_on'>, since: string | undefined): void {
  if (since === undefined || !card) return;
  for (const f of fields) {
    const at = card[`${f}_at`];
    if (at && at !== since && isLater(at, since)) {
      throw new BoardError('changed_since', 409, { field: f, current: card[f] ?? '', at, by: card[`${f}_by`] },
        `The card's ${f === 'waiting_on' ? 'waiting on' : f} changed since you opened it.`);
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * N16: when, in words a leader may repeat to the user (`today at 05:34`,
 * `yesterday at 22:10`, `on Oct 3 at 09:00`), in the server's local time, on
 * the board's 24 hour clock. A raw ISO stamp was quoted to users verbatim.
 */
export function readableAt(iso: string | undefined, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'earlier';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return `today at ${hm}`;
  if (days === 1) return `yesterday at ${hm}`;
  return `on ${MONTHS[d.getMonth()]} ${d.getDate()} at ${hm}`;
}

/** A session moving a card the user placed (4.3): the 409 message, or null when the write may go ahead. */
function laneRefusal(lanes: readonly BoardLane[], cardId: string, card: BoardCard | undefined, lane: string, opts: KanbanWriteOpts): BoardError | null {
  if (opts.by === 'human' || opts.overrideUser || card?.lane_by !== 'human' || (card.lane ?? '') === lane) return null;
  const suggestion = lane ? ` Your suggestion to move it to "${laneName(lanes, lane)}" was recorded on the card; the user can accept it.` : '';
  return new BoardError('status_set_by_user', 409, { task: cardId, lane: card.lane, lane_at: card.lane_at },
    `The user placed this card in "${laneName(lanes, card.lane)}" ${readableAt(card.lane_at)}. `
    + `Leave lane out to keep their pick, or pass override_user: true to replace it.${suggestion}`);
}

function requireLane(lanes: readonly BoardLane[], lane: string): void {
  if (lane && !laneById(lanes, lane)) {
    throw new BoardError('lane_not_found', 409, { lane, lanes: lanes.map((l) => ({ id: l.id, name: l.name, kind: l.kind })) },
      `No lane "${lane}" on this board (another window may have just deleted it)`);
  }
}

function checkCardRoom(cards: Record<string, BoardCard>, id: string): void {
  if (!cards[id] && Object.keys(cards).length >= MAX_CARDS) {
    throw new BoardError('bad_request', 400, { max: MAX_CARDS }, `A board keeps at most ${MAX_CARDS} cards`);
  }
}

/** Put the card in `lane` explicitly (a human's move also settles any suggestion). */
function placed(card: BoardCard, lane: string, by: BoardWriter, at: string): BoardCard {
  const c: BoardCard = { ...card };
  if (!lane) { delete c.lane; delete c.lane_at; delete c.lane_by; return c; }
  // C12: every placement is a new event (latest event wins over a later
  // completion), so lane_at moves even for the same lane. The one exception is
  // a session writing the lane the user already picked: their pick and its
  // time stay, so the next refusal still quotes when the user placed it.
  if (!(c.lane === lane && c.lane_by === 'human' && by !== 'human')) { c.lane = lane; c.lane_at = at; c.lane_by = by; }
  if (by === 'human' || c.lane_suggested?.lane === lane) delete c.lane_suggested;
  return c;
}

/**
 * Write one card: lane, summary, waiting_on (each optional; '' clears). All or
 * nothing: a refused lane refuses the whole write, but the refused lane is kept
 * as the card's `lane_suggested` (same lock) before the 409 is thrown.
 */
export async function setBoardCard(
  ownerId: string,
  cardId: string,
  input: CardInput,
  opts: KanbanWriteOpts,
): Promise<{ card: BoardCard; lane_effective: string }> {
  const lane = checkText(input.lane, 'lane', 64);
  const summary = checkText(input.summary, 'summary', MAX_SUMMARY);
  const waitingOn = checkText(input.waiting_on, 'waiting_on', MAX_WAITING_ON);
  if (lane === undefined && summary === undefined && waitingOn === undefined) {
    throw new BoardError('bad_request', 400, undefined, 'Give lane, summary or waiting_on');
  }
  const snap = await teamSnapshot(ownerId);
  const task = requireCardTask(ownerId, cardId, snap);
  const out: { refused?: BoardError; card?: BoardCard } = {};
  const next = await updateBoard(ownerId, (raw) => {
    out.refused = undefined;
    const board = prepareKanbanBoard(raw, ownerId, snap, opts.by, opts.template);
    const lanes = board.lanes ?? [];
    const now = new Date().toISOString();
    const current = board.cards[cardId];
    checkCardRoom(board.cards, cardId);
    if (lane) requireLane(lanes, lane);
    const fields = ([['lane', lane], ['summary', summary], ['waiting_on', waitingOn]] as const)
      .filter(([, v]) => v !== undefined).map(([f]) => f);
    checkUnchanged(current, [...fields], opts.ifUnchangedSince);
    const refusal = lane !== undefined ? laneRefusal(lanes, cardId, current, lane, opts) : null;
    if (refusal) {
      if (!lane) throw refusal; // a refused clear has nothing to suggest: write nothing
      out.refused = refusal;
      const suggested: BoardCard = { ...current, lane_suggested: { lane, by: writerTaskId(opts.by), at: now } };
      return { ...board, cards: { ...board.cards, [cardId]: suggested } };
    }
    let c: BoardCard = { ...current };
    if (lane !== undefined) c = placed(c, lane, opts.by, now);
    if (summary !== undefined) {
      if (summary) c.summary = summary; else delete c.summary;
      c.summary_at = now; c.summary_by = opts.by;
    }
    if (waitingOn !== undefined) {
      if (waitingOn) c.waiting_on = waitingOn; else delete c.waiting_on;
      c.waiting_on_at = now; c.waiting_on_by = opts.by;
    }
    out.card = c;
    return { ...board, cards: { ...board.cards, [cardId]: c } };
  });
  emitChanged({ taskId: ownerId, kind: 'card', task: cardId, version: next.version });
  if (out.refused) throw out.refused;
  const card = next.cards[cardId] ?? out.card ?? {};
  return { card, lane_effective: laneEffective(next, card, task) };
}

export interface MoveInput {
  lane: string;
  /** The lane's cards top to bottom after the drop; ids not shown in that lane are ignored. */
  order?: string[];
  /** Reorder inside the lane only: lane, lane_at and lane_by stay as they are (G10). */
  rank_only?: boolean;
}

/**
 * One drag: put the card in `lane` explicitly (unless rank_only) and rank the
 * lane's cards by their index in `order`, filtered to the cards that show in
 * that lane after the move. A done-kind lane keeps no order (newest first).
 */
export async function moveBoardCard(
  ownerId: string,
  cardId: string,
  input: MoveInput,
  opts: KanbanWriteOpts,
): Promise<{ card: BoardCard; order: string[] }> {
  if (typeof input.lane !== 'string' || !input.lane.trim()) throw new BoardError('bad_request', 400, undefined, '`lane` must be a lane id');
  const rawOrder = input.order ?? [];
  if (!Array.isArray(rawOrder) || rawOrder.some((id) => typeof id !== 'string')) {
    throw new BoardError('bad_request', 400, undefined, '`order` must be an array of task ids');
  }
  if (rawOrder.length > MAX_CARDS) throw new BoardError('bad_request', 400, { max: MAX_CARDS }, `\`order\` holds at most ${MAX_CARDS} ids`);
  const lane = input.lane.trim();
  const snap = await teamSnapshot(ownerId);
  requireCardTask(ownerId, cardId, snap);
  const out: { refused?: BoardError; order: string[] } = { order: [] };
  const next = await updateBoard(ownerId, (raw) => {
    out.refused = undefined;
    const board = prepareKanbanBoard(raw, ownerId, snap, opts.by);
    const lanes = board.lanes ?? [];
    const now = new Date().toISOString();
    requireLane(lanes, lane);
    checkCardRoom(board.cards, cardId);
    const cards = { ...board.cards };
    const current = cards[cardId];
    if (!input.rank_only) {
      const refusal = laneRefusal(lanes, cardId, current, lane, opts);
      if (refusal) {
        out.refused = refusal;
        cards[cardId] = { ...current, lane_suggested: { lane, by: writerTaskId(opts.by), at: now } };
        return { ...board, cards };
      }
      cards[cardId] = placed({ ...current }, lane, opts.by, now);
    }
    const seen = new Set<string>();
    const shown = rawOrder.filter((id) => {
      if (seen.has(id) || id === ownerId || !snap.members.has(id)) return false;
      seen.add(id);
      return placeCard(cards[id], placeTask(snap.byId.get(id)!), lanes).lane === lane;
    });
    out.order = shown;
    if (laneById(lanes, lane)?.kind !== 'done') {
      shown.forEach((id, index) => {
        if (!cards[id] && Object.keys(cards).length >= MAX_CARDS) return;
        cards[id] = { ...cards[id], rank: index, rank_lane: lane };
      });
    }
    return { ...board, cards };
  });
  emitChanged({ taskId: ownerId, kind: 'card', task: cardId, version: next.version });
  if (out.refused) throw out.refused;
  return { card: next.cards[cardId] ?? {}, order: out.order };
}

/**
 * The user's answer to a session's refused lane (G10): accept = the user's own
 * move to that lane; dismiss = forget it. Humans only.
 */
export async function answerSuggestion(
  ownerId: string,
  cardId: string,
  action: 'accept' | 'dismiss',
  opts: { by: BoardWriter },
): Promise<{ card: BoardCard; lane_effective: string }> {
  if (opts.by !== 'human') throw new BoardError('human_only', 403, undefined, 'Only the user answers a suggestion');
  if (action !== 'accept' && action !== 'dismiss') throw new BoardError('bad_request', 400, undefined, '`action` is accept or dismiss');
  const snap = await teamSnapshot(ownerId);
  const task = requireCardTask(ownerId, cardId, snap);
  const next = await updateBoard(ownerId, (raw) => {
    const board = prepareKanbanBoard(raw, ownerId, snap, 'human');
    const current = board.cards[cardId];
    const suggestion = current?.lane_suggested;
    if (!suggestion) throw new BoardError('no_suggestion', 404, { task: cardId }, 'This card has no suggestion to answer');
    let c: BoardCard = { ...current };
    delete c.lane_suggested;
    if (action === 'accept') {
      requireLane(board.lanes ?? [], suggestion.lane);
      c = placed(c, suggestion.lane, 'human', new Date().toISOString());
    }
    return { ...board, cards: { ...board.cards, [cardId]: c } };
  });
  emitChanged({ taskId: ownerId, kind: 'card', task: cardId, version: next.version });
  const card = next.cards[cardId] ?? {};
  return { card, lane_effective: laneEffective(next, card, task) };
}

export interface NewCardInput {
  title: string;
  /** The lane it is added to; absent = the first todo lane. */
  lane?: string;
  tags?: string[];
}

/**
 * Add a task from a lane: a subtask of the owner in the owner's project and
 * folder, tagged, with no session, then placed in the lane. Two writes: when
 * the board write fails the task exists anyway (it shows in the first todo
 * lane by itself), so the answer is the task, card null, warning placement_failed.
 */
export async function createBoardCardTask(
  ownerId: string,
  input: NewCardInput,
  opts: KanbanWriteOpts,
): Promise<{ task: Task; card: BoardCard | null; warning?: 'placement_failed'; error?: string }> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new BoardError('bad_request', 400, undefined, '`title` must be a non-empty string');
  if (title.length > 500) throw new BoardError('bad_request', 400, { max: 500 }, 'A title has at most 500 characters');
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 50 || tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 200)) {
    throw new BoardError('bad_request', 400, { max: 50 }, '`tags` must be an array of at most 50 non-empty strings');
  }
  if (input.lane !== undefined && typeof input.lane !== 'string') throw new BoardError('bad_request', 400, undefined, '`lane` must be a lane id');
  const { addTask, getTask } = await import('../task-manager.js');
  const owner = await getTask(ownerId);
  const { getBoard } = await import('./board-store.js');
  const before = prepareKanbanBoard(await getBoard(ownerId), ownerId, await teamSnapshot(ownerId), opts.by);
  const lanes = before.lanes ?? [];
  const lane = input.lane?.trim() || (lanes.find((l) => l.kind === 'todo') ?? lanes[0])?.id || '';
  requireLane(lanes, lane);
  const { task } = await addTask({
    title,
    project: owner.project ?? '',
    parent_task_id: owner.id,
    ...(owner.group_id ? { group_id: owner.group_id } : {}),
    ...(tags.length ? { tags: tags.map((t) => t.trim()) } : {}),
  });
  // As POST /tasks does: every open window's task store (and the kanban watch) hears of it.
  const { bus, EventNames } = await import('../event-bus.js');
  bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'board-kanban' });
  try {
    // The lanes the user added it from: a `ticket:` tag on the new task must not switch a board still on its template.
    const { card } = await setBoardCard(ownerId, task.id, { lane }, { by: opts.by, overrideUser: true, template: before.lanes_template });
    return { task, card };
  } catch (err) {
    return { task, card: null, warning: 'placement_failed', error: err instanceof Error ? err.message : String(err) };
  }
}
