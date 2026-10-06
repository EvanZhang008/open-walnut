/**
 * The kanban's optimistic layer (spec 8.3), as pure logic (useKanbanWrites.ts
 * wires it). Every write in flight is ONE overlay keyed by its card's task id
 * (or 'lanes'); the screen is the server payload with the overlays applied.
 *
 * A newer write on the same key replaces the older overlay (last write wins).
 * A failed write removes its overlay. A write that succeeded keeps its overlay
 * until the first payload whose fetch STARTED after the write's response
 * arrives (G32), whatever that payload says: another window or the leader may
 * have overwritten the write, and waiting for "the payload contains my result"
 * would pin the card in its optimistic place forever. A read that started after
 * the response reflects that write or a newer one, so nothing flashes back.
 * Unit-pinned in tests/web/kanban-overlay.test.ts.
 */
import type { BoardCard, BoardLane, BoardTeamEntry } from '../../../../../src/core/boards/board-lanes';

export const LANES_KEY = 'lanes';
/** A write that has not answered in this long counts as failed. */
export const KANBAN_WRITE_TIMEOUT_MS = 15_000;

/** A task phase the board changed (complete, reopen, undo). */
export interface TaskPhasePatch {
  phase: string;
  completed_at?: string | null;
}

export interface KanbanOverlay {
  key: string;
  /** Monotone per hook: the newer write on a key wins. */
  seq: number;
  startedAt: number;
  /** Set when the route answered OK; the overlay then waits for a newer read. */
  respondedAt?: number;
  /** Card fields to lay over the payload's card (undefined value = delete the field). */
  cards?: Record<string, Partial<Record<keyof BoardCard, unknown>>>;
  lanes?: BoardLane[];
  tasks?: Record<string, TaskPhasePatch>;
}

export type OverlayMap = ReadonlyMap<string, KanbanOverlay>;

export function putOverlay(map: OverlayMap, ov: KanbanOverlay): Map<string, KanbanOverlay> {
  const next = new Map(map);
  next.set(ov.key, ov);
  return next;
}

/** The route answered OK: keep it until a read started after `at` lands. A stale seq (a newer write) is ignored. */
export function markResponded(map: OverlayMap, key: string, seq: number, at: number): Map<string, KanbanOverlay> | null {
  const cur = map.get(key);
  if (!cur || cur.seq !== seq) return null;
  const next = new Map(map);
  next.set(key, { ...cur, respondedAt: at });
  return next;
}

/** The write failed: its overlay goes (only if no newer write on the key replaced it). */
export function dropOverlay(map: OverlayMap, key: string, seq: number): Map<string, KanbanOverlay> | null {
  const cur = map.get(key);
  if (!cur || cur.seq !== seq) return null;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** G32: overlays whose response came before this read STARTED leave, whatever the read says. */
export function releaseOverlays(map: OverlayMap, fetchStartedAt: number): Map<string, KanbanOverlay> | null {
  let next: Map<string, KanbanOverlay> | null = null;
  for (const [key, ov] of map) {
    if (ov.respondedAt === undefined || !(fetchStartedAt > ov.respondedAt)) continue;
    // A task phase also rides the task store's own event: keep only that part until the store has it.
    if (ov.tasks && Object.keys(ov.tasks).length) continue;
    next ??= new Map(map);
    next.delete(key);
  }
  return next;
}

/** Task phase overlays leave once the store shows that phase, or `graceMs` after the response. */
export function releaseTaskOverlays(
  map: OverlayMap, storePhase: (taskId: string) => string | undefined, fetchStartedAt: number, now: number, graceMs = 5_000,
): Map<string, KanbanOverlay> | null {
  let next: Map<string, KanbanOverlay> | null = null;
  for (const [key, ov] of map) {
    if (ov.respondedAt === undefined || !ov.tasks) continue;
    const settled = Object.entries(ov.tasks).every(([id, p]) => storePhase(id) === p.phase);
    const read = fetchStartedAt > ov.respondedAt;
    if (!(read && (settled || now - ov.respondedAt > graceMs))) continue;
    next ??= new Map(map);
    next.delete(key);
  }
  return next;
}

function layCard(base: BoardCard | undefined, patch: Partial<Record<keyof BoardCard, unknown>>): BoardCard {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as BoardCard;
}

export interface OverlaidKanban {
  cards: Record<string, BoardCard>;
  lanes: BoardLane[];
  team: BoardTeamEntry[];
  tasks: Record<string, TaskPhasePatch>;
}

/** The payload's kanban fields with every overlay applied, oldest write first. */
export function applyOverlays(
  base: { cards: Record<string, BoardCard>; lanes: readonly BoardLane[]; team: readonly BoardTeamEntry[] },
  map: OverlayMap,
): OverlaidKanban {
  if (map.size === 0) return { cards: base.cards, lanes: [...base.lanes], team: [...base.team], tasks: {} };
  const list = [...map.values()].sort((a, b) => a.seq - b.seq);
  const cards: Record<string, BoardCard> = { ...base.cards };
  let lanes: BoardLane[] = [...base.lanes];
  const tasks: Record<string, TaskPhasePatch> = {};
  for (const ov of list) {
    if (ov.lanes) lanes = ov.lanes.map((l) => ({ ...l }));
    for (const [id, patch] of Object.entries(ov.cards ?? {})) cards[id] = layCard(cards[id], patch);
    for (const [id, p] of Object.entries(ov.tasks ?? {})) tasks[id] = p;
  }
  const team = base.team.map((e) => {
    const p = tasks[e.id];
    if (!p) return e;
    const out: BoardTeamEntry = { id: e.id, phase: p.phase };
    const done = p.completed_at === undefined ? e.completed_at : p.completed_at ?? undefined;
    if (done) out.completed_at = done;
    return out;
  });
  return { cards, lanes, team, tasks };
}

/**
 * The card fields a move lays over the payload: the moved card is placed by
 * the human (unless rank only, G10) and its suggestion goes; every card of
 * `order` takes its index as rank in `lane` (a done lane keeps no rank, G26).
 */
export function moveCardPatches(
  taskId: string, lane: string, order: readonly string[], opts: { rankOnly?: boolean; doneLane?: boolean; nowIso: string },
): Record<string, Partial<Record<keyof BoardCard, unknown>>> {
  const out: Record<string, Partial<Record<keyof BoardCard, unknown>>> = {};
  if (!opts.doneLane) {
    order.forEach((id, i) => { out[id] = { rank: i, rank_lane: lane }; });
  }
  if (!opts.rankOnly) {
    out[taskId] = {
      ...(out[taskId] ?? {}), lane, lane_at: opts.nowIso, lane_by: 'human', lane_suggested: undefined,
      ...(opts.doneLane ? { rank: undefined, rank_lane: undefined } : {}),
    };
  }
  return out;
}

/** The fields a card write (`PUT cards/:task`) lays over: '' clears a field (lane '' = back to automatic). */
export function setCardPatch(
  patch: { lane?: string; summary?: string; waiting_on?: string }, nowIso: string,
): Partial<Record<keyof BoardCard, unknown>> {
  const out: Partial<Record<keyof BoardCard, unknown>> = {};
  if (patch.lane !== undefined) {
    if (patch.lane === '') Object.assign(out, { lane: undefined, lane_at: undefined, lane_by: undefined, rank: undefined, rank_lane: undefined });
    else Object.assign(out, { lane: patch.lane, lane_at: nowIso, lane_by: 'human', lane_suggested: undefined });
  }
  if (patch.summary !== undefined) {
    Object.assign(out, patch.summary === '' ? { summary: undefined, summary_at: undefined, summary_by: undefined }
      : { summary: patch.summary, summary_at: nowIso, summary_by: 'human' });
  }
  if (patch.waiting_on !== undefined) {
    Object.assign(out, patch.waiting_on === '' ? { waiting_on: undefined, waiting_on_at: undefined, waiting_on_by: undefined }
      : { waiting_on: patch.waiting_on, waiting_on_at: nowIso, waiting_on_by: 'human' });
  }
  return out;
}
