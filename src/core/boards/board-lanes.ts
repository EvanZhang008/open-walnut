/**
 * Kanban lanes and cards of a Board: the shared pure rules (templates, card
 * placement, lane validation, the delete preview, summary choice). No node
 * imports (only its pure sibling board-summary-text.ts): the web imports this
 * file by relative path, so the server and the browser place every card with
 * the same code. Unit-pinned in tests/core/board-lanes.test.ts.
 */
import { stripMarkdown } from './board-summary-text.js';

/** Same shape as BoardWriter in board-store.ts (kept local so this file stays import free). */
export type BoardCardWriter = 'human' | `task:${string}`;

export type BoardLaneKind = 'todo' | 'active' | 'wait' | 'review' | 'done';
export const LANE_KINDS: readonly BoardLaneKind[] = ['todo', 'active', 'wait', 'review', 'done'];
/** The Kind menu's words for each lane kind. */
export const LANE_KIND_LABELS: Readonly<Record<BoardLaneKind, string>> = {
  todo: 'To do', active: 'In progress', wait: 'Waiting', review: 'Review', done: 'Done',
};

export interface BoardLane {
  id: string;
  name: string;
  kind: BoardLaneKind;
  /** Done kind only: a card dropped here also completes its task. */
  complete_on_drop?: boolean;
}

export interface BoardCard {
  /** Explicit placement (a human drag or a session write). */
  lane?: string;
  lane_at?: string;
  lane_by?: BoardCardWriter;
  /** Order inside a lane; valid only while rank_lane is the lane the card shows in. */
  rank?: number;
  rank_lane?: string;
  summary?: string;
  summary_at?: string;
  summary_by?: BoardCardWriter;
  waiting_on?: string;
  waiting_on_at?: string;
  waiting_on_by?: BoardCardWriter;
  /** Written by the server's bus watch only, never by a human or a session. Sticky, forward only. */
  lane_auto?: { lane: string; at: string };
  /** The worker itself moved its task to NEED_ACTION (not a turn end). */
  handed_back_at?: string;
  /** The last time task.summary changed. */
  worker_summary_at?: string;
  /** A turn ended and task.summary changed. */
  output_at?: string;
  /** A session's lane write refused because the user placed the card; `by` = the session's task id. */
  lane_suggested?: { lane: string; by: string; at: string };
}

/** One card as the user last saw it (the server-side "Changed" baseline). */
export interface BoardKanbanSeenCard {
  lane: string;
  summaryHash: string;
  outputAt?: string;
  unread?: boolean;
}

export interface BoardKanbanSeen {
  at: string;
  previous_at?: string;
  cards: Record<string, BoardKanbanSeenCard>;
}

/** One direct subtask of the board's owner, as GET reports the team. */
export interface BoardTeamEntry {
  id: string;
  phase: string;
  completed_at?: string;
}

export type LaneTemplateId = 'triage' | 'general';

export const MAX_LANES = 12;
export const MAX_LANE_NAME = 40;
export const MAX_CARDS = 500;
export const MAX_SUMMARY = 300;
export const MAX_WAITING_ON = 80;
/** Server-made lane ids: `ln-` + 8 hex. */
export const LANE_ID_PREFIX = 'ln-';
const LANE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const TRIAGE_LANES: readonly BoardLane[] = Object.freeze([
  { id: 'new', name: 'New', kind: 'todo' },
  { id: 'investigating', name: 'Investigating', kind: 'active' },
  { id: 'mitigating', name: 'Mitigating', kind: 'active' },
  { id: 'waiting-others', name: 'Waiting on others', kind: 'wait' },
  { id: 'waiting-cr', name: 'Waiting on CR', kind: 'wait' },
  { id: 'resolved', name: 'Resolved', kind: 'done' },
] as BoardLane[]);

export const GENERAL_LANES: readonly BoardLane[] = Object.freeze([
  { id: 'todo', name: 'To do', kind: 'todo' },
  { id: 'in-progress', name: 'In progress', kind: 'active' },
  { id: 'waiting', name: 'Waiting', kind: 'wait' },
  { id: 'review', name: 'Review', kind: 'review' },
  { id: 'done', name: 'Done', kind: 'done' },
] as BoardLane[]);

// ── Templates ──

/** triage when any team task carries a `ticket:` or `ticket-id:` tag, general otherwise. */
export function pickLaneTemplate(tags: Iterable<string>): LaneTemplateId {
  for (const raw of tags) {
    const t = String(raw ?? '').trim().toLowerCase();
    if (t.startsWith('ticket:') || t.startsWith('ticket-id:')) return 'triage';
  }
  return 'general';
}

/** Fresh copies of a template's lanes (fixed ids). */
export function templateLanes(id: LaneTemplateId): BoardLane[] {
  return (id === 'triage' ? TRIAGE_LANES : GENERAL_LANES).map((l) => ({ ...l }));
}

/**
 * The lanes a board shows: the stored ones, or the template the team's tags
 * pick while nobody has written lanes or cards yet (stored null).
 */
export function effectiveLanes(
  stored: readonly BoardLane[] | null | undefined,
  teamTags: Iterable<string>,
  storedTemplate?: LaneTemplateId,
): { lanes: BoardLane[]; template: LaneTemplateId } {
  if (stored && stored.length > 0) {
    return { lanes: stored.map((l) => ({ ...l })), template: storedTemplate ?? pickLaneTemplate(teamTags) };
  }
  const template = pickLaneTemplate(teamTags);
  return { lanes: templateLanes(template), template };
}

export function laneById(lanes: readonly BoardLane[], id: string | undefined): BoardLane | undefined {
  if (!id) return undefined;
  return lanes.find((l) => l.id === id);
}

/** The first lane of `kind`; else the first todo lane; else the first lane (4.2 rule 3). */
export function firstLaneOfKind(lanes: readonly BoardLane[], kind: BoardLaneKind): BoardLane | null {
  return lanes.find((l) => l.kind === kind) ?? lanes.find((l) => l.kind === 'todo') ?? lanes[0] ?? null;
}

// ── Placement (4.2) ──

/** The kind a card goes to when nothing recorded where it belongs. Monotone: having had a session never goes back. */
export function statelessLaneKind(t: { phase?: string; hasHadSession?: boolean }): BoardLaneKind {
  const phase = t.phase ?? '';
  if (phase === 'COMPLETE') return 'done';
  if (phase === 'WAITING') return 'wait';
  if (t.hasHadSession || phase === 'IN_PROGRESS' || phase === 'NEED_ACTION') return 'active';
  return 'todo';
}

/** What the server's bus watch saw happen to a card's task. */
export type BoardLaneEvent =
  | { type: 'card-appeared'; phase: string; hasHadSession: boolean }
  | { type: 'session-running' }
  | { type: 'phase'; from?: string; to: string }
  | { type: 'session-idle' | 'session-stopped' | 'session-error' | 'turn-end' };

/** The 4.2 table: the auto lane kind an event moves a card to, or null = unchanged (forward only). */
export function autoLaneKind(event: BoardLaneEvent): BoardLaneKind | null {
  switch (event.type) {
    case 'card-appeared':
      return statelessLaneKind(event);
    case 'session-running':
      return 'active';
    case 'phase':
      if (event.from === event.to) return null;
      if (event.to === 'IN_PROGRESS') return 'active';
      if (event.to === 'WAITING') return 'wait';
      if (event.to === 'COMPLETE') return 'done';
      return null; // NEED_ACTION, TODO and anything else: unchanged
    default:
      return null; // idle, stopped, error, turn end
  }
}

/** The task facts placement reads. */
export interface PlaceTask {
  phase?: string;
  completed_at?: string;
  hasHadSession?: boolean;
}

export interface CardPlacement {
  /** Lane id ('' only when there are no lanes at all). */
  lane: string;
  source: 'explicit' | 'auto';
  /** The task completed after it was placed here, so it shows in the done lane instead. */
  completedAfterMove: boolean;
}

function later(a: string | undefined, b: string | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a > b;
  return ta > tb;
}

/**
 * Where a card shows (4.2). An explicit lane wins unless the task completed
 * after that placement (latest event wins); otherwise the sticky auto lane;
 * otherwise the stateless rule. A wanted kind with no lane falls back to the
 * first todo lane, then the first lane.
 */
export function placeCard(
  card: BoardCard | null | undefined,
  task: PlaceTask,
  lanes: readonly BoardLane[],
): CardPlacement {
  const done = (): CardPlacement => ({ lane: firstLaneOfKind(lanes, 'done')?.id ?? '', source: 'auto', completedAfterMove: false });
  const explicit = laneById(lanes, card?.lane);
  if (explicit) {
    if (task.phase === 'COMPLETE' && later(task.completed_at, card?.lane_at)) {
      const d = done();
      return { ...d, completedAfterMove: d.lane !== explicit.id };
    }
    return { lane: explicit.id, source: 'explicit', completedAfterMove: false };
  }
  const auto = laneById(lanes, card?.lane_auto?.lane);
  if (auto) {
    // A completion the watch has not recorded yet still lands the card in done.
    if (task.phase === 'COMPLETE' && auto.kind !== 'done' && later(task.completed_at, card?.lane_auto?.at)) return done();
    return { lane: auto.id, source: 'auto', completedAfterMove: false };
  }
  const lane = firstLaneOfKind(lanes, statelessLaneKind(task));
  return { lane: lane?.id ?? '', source: 'auto', completedAfterMove: false };
}

// ── Lane validation (PUT lanes) ──

export interface LaneInput {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  complete_on_drop?: unknown;
}

export type ValidateLanesResult =
  | { ok: true; lanes: BoardLane[] }
  | { ok: false; reason: 'bad_request' | 'needs_done_lane'; max?: number; message: string };

/**
 * A whole lane list as the user or a session sent it: 1 to MAX_LANES lanes,
 * names 1 to MAX_LANE_NAME chars after trim and unique ignoring case, a known
 * kind, at least one done lane. No id = a new lane (`newId()`); a repeated id
 * is refused. complete_on_drop survives on done lanes only.
 */
export function validateLanes(input: unknown, opts: { newId: () => string }): ValidateLanesResult {
  const bad = (message: string, max?: number): ValidateLanesResult =>
    ({ ok: false, reason: 'bad_request', ...(max !== undefined ? { max } : {}), message });
  if (!Array.isArray(input)) return bad('lanes must be an array');
  if (input.length < 1) return bad('A board keeps at least one lane');
  if (input.length > MAX_LANES) return bad(`A board has at most ${MAX_LANES} lanes`, MAX_LANES);
  const out: BoardLane[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const raw of input as LaneInput[]) {
    if (!raw || typeof raw !== 'object') return bad('Each lane must be an object');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return bad('A lane needs a name');
    if (name.length > MAX_LANE_NAME) return bad(`A lane name has at most ${MAX_LANE_NAME} characters`, MAX_LANE_NAME);
    const key = name.toLowerCase();
    if (names.has(key)) return bad(`There is already a lane called "${name}"`);
    names.add(key);
    const kind = raw.kind as BoardLaneKind;
    if (!LANE_KINDS.includes(kind)) return bad(`Unknown lane kind "${String(raw.kind)}"`);
    let id: string;
    if (raw.id === undefined || raw.id === null || raw.id === '') {
      do { id = opts.newId(); } while (ids.has(id));
    } else if (typeof raw.id === 'string' && LANE_ID_RE.test(raw.id)) {
      id = raw.id;
    } else {
      return bad(`Bad lane id "${String(raw.id)}"`);
    }
    if (ids.has(id)) return bad(`Lane id "${id}" appears twice`);
    ids.add(id);
    const lane: BoardLane = { id, name, kind };
    if (kind === 'done' && raw.complete_on_drop === true) lane.complete_on_drop = true;
    out.push(lane);
  }
  if (!out.some((l) => l.kind === 'done')) {
    return { ok: false, reason: 'needs_done_lane', message: 'A board keeps one Done lane' };
  }
  return { ok: true, lanes: out };
}

/** A server-made lane id: `ln-` + 8 hex. `rand` returns a 32-bit unsigned integer. */
export function makeLaneId(rand: () => number = () => Math.floor(Math.random() * 0x100000000)): string {
  return LANE_ID_PREFIX + (rand() >>> 0).toString(16).padStart(8, '0');
}

// ── Delete preview (7.3) ──

export interface DeletePreviewEntry {
  card?: BoardCard | null;
  task: PlaceTask;
}

export interface DeletePreview {
  laneId: string;
  name: string;
  total: number;
  /** Where the lane's cards go, in lane order. */
  moves: Array<{ lane: string; name: string; count: number }>;
}

/**
 * Where a lane's cards go if it is deleted: each card shown in it is placed
 * again (its explicit lane cleared when it pointed here) on the lanes without
 * it, with the same placeCard the board uses afterwards.
 */
export function deletePreview(
  lanes: readonly BoardLane[],
  laneId: string,
  entries: readonly DeletePreviewEntry[],
): DeletePreview {
  const name = laneById(lanes, laneId)?.name ?? '';
  const after = lanes.filter((l) => l.id !== laneId);
  const counts = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    if (placeCard(e.card, e.task, lanes).lane !== laneId) continue;
    total++;
    const card = e.card && e.card.lane === laneId ? { ...e.card, lane: undefined, lane_at: undefined, lane_by: undefined } : e.card;
    const to = placeCard(card, e.task, after).lane;
    counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  const moves = after.filter((l) => counts.has(l.id)).map((l) => ({ lane: l.id, name: l.name, count: counts.get(l.id)! }));
  return { laneId, name, total, moves };
}

/** The delete dialog's body: `Its 4 cards move to New.` and friends. */
export function deletePreviewText(p: DeletePreview): string {
  if (p.total === 0 || p.moves.length === 0) return 'It has no cards.';
  if (p.moves.length === 1) {
    return p.total === 1 ? `Its 1 card moves to ${p.moves[0].name}.` : `Its ${p.total} cards move to ${p.moves[0].name}.`;
  }
  return `Its ${p.total} cards move by their status: ${p.moves.map((m) => `${m.count} to ${m.name}`).join(', ')}.`;
}

// ── Summary (G11, G34) ──

/** Markdown as plain text: no emphasis marks, backticks, link syntax, headings, list or quote markers, tags. */
// Markdown as plain text lives in board-summary-text.ts (the line-by-line rules, R3-11).
export { stripMarkdown };

export interface DisplayedSummary {
  text: string;
  /** 'card' = the board's card summary (leader or user); 'task' = the worker's task.summary. */
  source: 'card' | 'task';
  at?: string;
  by?: BoardCardWriter;
}

/** The newer of the card summary and the worker's task summary; only one = that one; neither = null. */
export function displayedSummary(card: BoardCard | null | undefined, taskSummary: string | null | undefined): DisplayedSummary | null {
  const cardText = card?.summary ? stripMarkdown(card.summary) : '';
  const taskText = taskSummary ? stripMarkdown(taskSummary) : '';
  const fromCard = (): DisplayedSummary => ({ text: cardText, source: 'card', at: card?.summary_at, by: card?.summary_by });
  const fromTask = (): DisplayedSummary => ({ text: taskText, source: 'task', ...(card?.worker_summary_at ? { at: card.worker_summary_at } : {}) });
  if (cardText && taskText) return later(card?.worker_summary_at, card?.summary_at) ? fromTask() : fromCard();
  if (cardText) return fromCard();
  if (taskText) return fromTask();
  return null;
}

/** FNV-1a 32-bit of the text, 8 hex chars: stable on both ends, sync. */
export function summaryHash(text: string | null | undefined): string {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Normalizers (a stored file or a payload from an older server) ──

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const writer = (v: unknown): BoardCardWriter | undefined =>
  v === 'human' || (typeof v === 'string' && v.startsWith('task:') && v.length > 5) ? (v as BoardCardWriter) : undefined;

/** Stored lanes, or null (still on the template) when absent or unreadable. */
export function normalizeLanes(raw: unknown): BoardLane[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BoardLane[] = [];
  for (const l of raw) {
    if (!isObj(l) || !str(l.id) || !str(l.name) || !LANE_KINDS.includes(l.kind as BoardLaneKind)) continue;
    const lane: BoardLane = { id: l.id as string, name: l.name as string, kind: l.kind as BoardLaneKind };
    if (lane.kind === 'done' && l.complete_on_drop === true) lane.complete_on_drop = true;
    out.push(lane);
  }
  return out.length ? out : null;
}

/** One card with only known, well-typed fields; null when nothing is left. */
export function normalizeBoardCard(raw: unknown): BoardCard | null {
  if (!isObj(raw)) return null;
  const c: BoardCard = {};
  for (const k of ['lane', 'lane_at', 'rank_lane', 'summary', 'summary_at', 'waiting_on', 'waiting_on_at',
    'handed_back_at', 'worker_summary_at', 'output_at'] as const) {
    const v = str(raw[k]);
    if (v) c[k] = v;
  }
  for (const k of ['lane_by', 'summary_by', 'waiting_on_by'] as const) {
    const v = writer(raw[k]);
    if (v) c[k] = v;
  }
  if (typeof raw.rank === 'number' && Number.isFinite(raw.rank)) c.rank = raw.rank;
  const auto = raw.lane_auto;
  if (isObj(auto) && str(auto.lane) && str(auto.at)) c.lane_auto = { lane: auto.lane as string, at: auto.at as string };
  const sug = raw.lane_suggested;
  if (isObj(sug) && str(sug.lane) && str(sug.by) && str(sug.at)) {
    c.lane_suggested = { lane: sug.lane as string, by: sug.by as string, at: sug.at as string };
  }
  return Object.keys(c).length ? c : null;
}

export function normalizeCards(raw: unknown): Record<string, BoardCard> {
  const out: Record<string, BoardCard> = {};
  if (!isObj(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    const c = normalizeBoardCard(v);
    if (id && c) out[id] = c;
  }
  return out;
}

export function normalizeKanbanSeen(raw: unknown): BoardKanbanSeen | null {
  if (!isObj(raw) || !str(raw.at)) return null;
  const cards: Record<string, BoardKanbanSeenCard> = {};
  if (isObj(raw.cards)) {
    for (const [id, v] of Object.entries(raw.cards)) {
      if (!isObj(v) || typeof v.lane !== 'string' || typeof v.summaryHash !== 'string') continue;
      const e: BoardKanbanSeenCard = { lane: v.lane, summaryHash: v.summaryHash };
      if (str(v.outputAt)) e.outputAt = v.outputAt as string;
      if (typeof v.unread === 'boolean') e.unread = v.unread;
      cards[id] = e;
    }
  }
  const seen: BoardKanbanSeen = { at: raw.at as string, cards };
  if (str(raw.previous_at)) seen.previous_at = raw.previous_at as string;
  return seen;
}

export function normalizeTeam(raw: unknown): BoardTeamEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardTeamEntry[] = [];
  for (const e of raw) {
    if (!isObj(e) || !str(e.id)) continue;
    const entry: BoardTeamEntry = { id: e.id as string, phase: typeof e.phase === 'string' ? e.phase : '' };
    if (str(e.completed_at)) entry.completed_at = e.completed_at as string;
    out.push(entry);
  }
  return out;
}

export function isLaneTemplateId(v: unknown): v is LaneTemplateId {
  return v === 'triage' || v === 'general';
}
