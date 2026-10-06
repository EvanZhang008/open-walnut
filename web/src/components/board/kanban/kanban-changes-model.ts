/**
 * "Changed since you last looked" (spec 8.4) as pure logic: what changed on
 * a card against the user's server-side baseline (a move, a new summary, a
 * leader's suggestion, new output, a new card), the foot text that says who
 * and when, the What changed log, and the snapshot a visit end stores. A
 * human's write never counts; no baseline yet = nothing changed. Unit-pinned
 * in tests/web/kanban-changes-model.test.ts.
 */
import {
  laneById, type BoardCard, type BoardCardWriter, type BoardKanbanSeenCard, type BoardLane,
} from '../../../../../src/core/boards/board-lanes';
import { clockText } from './kanban-time';
import type { KanbanCardVM } from './kanban-card-model';

export type KanbanChangeKind = 'moved' | 'summary' | 'suggestion' | 'output' | 'new';

export interface KanbanChangeItem {
  kind: KanbanChangeKind;
  /** The card foot's tooltip words: `Moved from New by the leader · 15:02`. */
  text: string;
  /** R3-04: the foot's own words, who without where: `Moved by the leader` (the time sits beside it, never cut). */
  short: string;
  /** `15:02`, '' when unknown. */
  clock: string;
  /** The What changed log's words, without the time: `the leader moved V1000000104 from New to Mitigating`. */
  sentence: string;
  at: string;
  actor: string;
}

export interface KanbanCardChange {
  items: KanbanChangeItem[];
  /** The foot's one change (+ how many more); `New output` only when nothing else changed. */
  foot?: KanbanFootChange;
}

/** The foot's one change: `short` may be cut, `clock` and `more` never are. */
export interface KanbanFootChange { text: string; short: string; clock: string; more: number }

/** One row of the What changed popover. */
export interface KanbanChange {
  at: string;
  taskId: string;
  kind: KanbanChangeKind;
  /** `15:02 the leader moved V1000000104 from New to Mitigating`. */
  text: string;
}

const CUT = 24;

export function cutTitle(title: string, max = CUT): string {
  const t = title.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

const EMPTY_HASH = '811c9dc5';

/**
 * Who wrote: 'the leader' for the owner's session, 'you' for a human, 'the worker' for the card's own
 * task (`selfId`: a foot never spends its width on the card's own title, R3-04), else the writer
 * task's title cut to 24; '' = unknown.
 */
export function writerText(by: BoardCardWriter | string | undefined, ownerId: string, titleOf: (id: string) => string, selfId?: string): string {
  if (by === 'human') return 'you';
  if (!by || !by.startsWith('task:')) return '';
  const id = by.slice(5);
  if (id === ownerId) return 'the leader';
  if (selfId && id === selfId) return 'the worker';
  return cutTitle(titleOf(id) || id);
}

/** The writer at the start of a line: `Leader suggests Resolved`, `Worker suggests ...`. */
export function writerLead(actor: string): string {
  return actor === 'the leader' ? 'Leader' : actor === 'the worker' ? 'Worker' : actor;
}

export interface CardChangeInput {
  taskId: string;
  /** How the log names the card: its ticket value, else its title cut to 24. */
  label: string;
  lanes: readonly BoardLane[];
  /** The lane shown now, and how it got there. */
  lane: string;
  source: 'explicit' | 'auto';
  laneAt?: string;
  /** The explicit writer; undefined for an automatic placement. */
  laneBy?: BoardCardWriter;
  card?: BoardCard | null;
  unread: boolean;
  summaryHash: string;
  /** False while the task's summary is not read yet: no summary change can be told (R3-03). */
  summaryKnown?: boolean;
  summaryAt?: string;
  summaryBy?: BoardCardWriter;
  createdAt: string;
  baseline?: BoardKanbanSeenCard;
  hasBaseline: boolean;
  baselineAt?: string | null;
  ownerId: string;
  titleOf: (id: string) => string;
  now: number;
}

function after(a: string | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x > y : a > b;
}

const stamp = (text: string, clock: string) => (clock ? `${text} · ${clock}` : text);

/** What changed on one card since the baseline; null = nothing (or no baseline yet). */
export function cardChange(i: CardChangeInput): KanbanCardChange | null {
  if (!i.hasBaseline) return null;
  const clock = (at: string | undefined) => clockText(at, i.now);
  const items: KanbanChangeItem[] = [];
  if (!i.baseline) {
    // N4: a card a human placed (Add task, any window) is not news to the human.
    if (i.laneBy === 'human') return null;
    const c = clock(i.createdAt);
    items.push({ kind: 'new', text: stamp('New card', c), short: 'New card', clock: c, sentence: `${i.label} new card`, at: i.createdAt, actor: '' });
    return { items, foot: footOf(items) };
  }
  const b = i.baseline;
  const laneName = (id: string) => laneById(i.lanes, id)?.name ?? (id ? 'a deleted lane' : 'no lane');
  if (b.lane !== i.lane && i.laneBy !== 'human') {
    const old = laneName(b.lane);
    const at = i.laneAt ?? '';
    if (i.source === 'explicit') {
      const actor = writerText(i.laneBy, i.ownerId, i.titleOf, i.taskId);
      items.push({ kind: 'moved', text: stamp(actor ? `Moved from ${old} by ${actor}` : `Moved from ${old}`, clock(at)),
        short: actor ? `Moved by ${actor}` : `Moved from ${old}`, clock: clock(at),
        sentence: actor ? `${actor} moved ${i.label} from ${old} to ${laneName(i.lane)}` : `${i.label} moved from ${old} to ${laneName(i.lane)}`, at, actor });
    } else {
      items.push({ kind: 'moved', text: stamp(`Moved from ${old} automatically`, clock(at)), short: 'Moved automatically', clock: clock(at),
        sentence: `${i.label} moved automatically from ${old} to ${laneName(i.lane)}`, at, actor: '' });
    }
  }
  if (i.summaryKnown !== false && b.summaryHash !== i.summaryHash && i.summaryBy !== 'human') {
    const at = i.summaryAt ?? '';
    // A writer is never guessed: a removed summary or an unknown writer names nobody.
    const removed = i.summaryHash === EMPTY_HASH;
    const actor = removed ? '' : writerText(i.summaryBy, i.ownerId, i.titleOf, i.taskId);
    const text = removed ? 'Summary removed' : actor ? `Summary updated by ${actor}` : 'Summary updated';
    const sentence = removed ? `the summary of ${i.label} was removed`
      : actor ? `${actor} updated the summary of ${i.label}` : `the summary of ${i.label} was updated`;
    // The foot's short form puts the writer right after one word, so a card's width keeps who and when (R3-04).
    const short = removed || !actor ? text : `Summary by ${actor}`;
    items.push({ kind: 'summary', text: stamp(text, clock(at)), short, clock: clock(at), sentence, at, actor });
  }
  const sug = i.card?.lane_suggested;
  const sugLane = sug ? laneById(i.lanes, sug.lane) : undefined;
  if (sug && sugLane && sug.lane !== i.lane && after(sug.at, i.baselineAt)) {
    const actor = writerText(`task:${sug.by}`, i.ownerId, i.titleOf, i.taskId);
    const who = writerLead(actor);
    items.push({ kind: 'suggestion', text: `${who} suggests ${sugLane.name}`, short: `${who} suggests ${sugLane.name}`, clock: '',
      sentence: `${actor} suggests moving ${i.label} to ${sugLane.name}`, at: sug.at, actor });
  }
  // C61 (wins over spec 8.4's unread clause): `New output` means a turn ended
  // AND the worker's summary changed (output_at moved). An unread flip alone,
  // e.g. the user's own Message resuming the session, shows only the unread
  // dot, so one event never gets two per-card marks.
  const outputAt = i.card?.output_at;
  if (outputAt && after(outputAt, b.outputAt ?? i.baselineAt)) {
    items.push({ kind: 'output', text: stamp('New output', clock(outputAt)), short: 'New output', clock: clock(outputAt), sentence: `${i.label} new output`, at: outputAt, actor: '' });
  }
  if (items.length === 0) return null;
  return { items, foot: footOf(items) };
}

/** The foot's one change (+ how many more): `New output` only when nothing else changed. */
export function footOf(items: readonly KanbanChangeItem[]): KanbanFootChange | undefined {
  if (items.length === 0) return undefined;
  const moved = items.some((x) => x.kind === 'moved' || x.kind === 'summary');
  const footItems = moved ? items.filter((x) => x.kind !== 'output') : items;
  const f = footItems[0];
  return { text: f.text, short: f.short, clock: f.clock, more: footItems.length - 1 };
}

/** The What changed log: every change of every card after the baseline, oldest first. */
export function changeLog(cards: readonly Pick<KanbanCardVM, 'taskId' | 'change'>[], now: number = Date.now()): KanbanChange[] {
  const out: KanbanChange[] = [];
  for (const c of cards) {
    for (const item of c.change?.items ?? []) {
      const clock = clockText(item.at, now);
      out.push({ at: item.at, taskId: c.taskId, kind: item.kind, text: clock ? `${clock} ${item.sentence}` : item.sentence });
    }
  }
  const ms = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };
  return out.sort((a, b) => ms(a.at) - ms(b.at));
}

/**
 * The baseline a visit end (or Mark all seen) stores: each card as shown. A
 * card still loading keeps its previous entry, so a half-known card is never
 * stored as seen.
 */
export function snapshotFor(
  cards: readonly Pick<KanbanCardVM, 'taskId' | 'loading' | 'snapshot'>[],
  previous?: Record<string, BoardKanbanSeenCard> | null,
): Record<string, BoardKanbanSeenCard> {
  const out: Record<string, BoardKanbanSeenCard> = {};
  for (const c of cards) {
    if (c.loading) {
      const prev = previous?.[c.taskId];
      if (prev) out[c.taskId] = prev;
      continue;
    }
    out[c.taskId] = { ...c.snapshot };
  }
  return out;
}
