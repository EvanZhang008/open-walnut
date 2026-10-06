/**
 * Kanban reloads of the Board pane, as pure logic (useTaskBoard.ts wires it):
 * which `board:changed` events reload only the kanban fields, how such an
 * answer merges into the shown payload (html and threads untouched, so the
 * Page iframe never rebuilds), which answer wins when a full read and a
 * kanban read cross, and a single-flight reloader (one request in flight;
 * events meanwhile coalesce into one more after it). Unit-pinned in
 * tests/web/board-kanban-reload.test.ts.
 */
import {
  effectiveLanes, isLaneTemplateId, normalizeCards, normalizeKanbanSeen, normalizeLanes, normalizeTeam,
} from '../../../../src/core/boards/board-lanes';
import type { BoardKanbanFields, BoardPayload } from './board-model';

/** A `board:changed` that only touches lanes, cards or the kanban baseline. */
export function isKanbanReloadEvent(d: { kind?: string; kanban?: boolean } | null | undefined): boolean {
  if (!d) return false;
  return d.kind === 'card' || d.kind === 'lanes' || (d.kind === 'seen' && d.kanban === true);
}

/** The kanban fields of any answer, with defaults for a field an older server left out. */
export function normalizeKanbanFields(raw: unknown): BoardKanbanFields {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lanes = normalizeLanes(d.lanes);
  const template = isLaneTemplateId(d.lanes_template) ? d.lanes_template : undefined;
  const given = normalizeLanes(d.lanes_effective);
  const eff = given ?? effectiveLanes(lanes, [], template).lanes;
  const out: BoardKanbanFields = {
    lanes,
    lanes_effective: eff,
    lanes_template: template ?? (given ? 'general' : effectiveLanes(lanes, [], template).template),
    cards: normalizeCards(d.cards),
    team: normalizeTeam(d.team),
    kanban_seen: normalizeKanbanSeen(d.kanban_seen),
  };
  if (typeof d.board_task_id === 'string' && d.board_task_id) out.board_task_id = d.board_task_id;
  if (typeof d.board_task_title === 'string') out.board_task_title = d.board_task_title;
  if (typeof d.board_version === 'number') out.board_version = d.board_version;
  return out;
}

/** A `fields=kanban` answer into the shown payload: only the kanban keys change. */
export function mergeKanbanFields(current: BoardPayload, fields: BoardKanbanFields): BoardPayload {
  const next: BoardPayload = {
    ...current,
    lanes: fields.lanes,
    lanes_effective: fields.lanes_effective,
    lanes_template: fields.lanes_template,
    cards: fields.cards,
    team: fields.team,
    kanban_seen: fields.kanban_seen,
  };
  if (fields.board_task_title !== undefined) next.board_task_title = fields.board_task_title;
  if (fields.board_version !== undefined) next.board_version = fields.board_version;
  return next;
}

/**
 * A full read landed. Its kanban part is taken only when that read STARTED no
 * earlier than the read whose kanban part is on screen; otherwise the newer
 * kanban part stays (a slow full read must not put back older cards).
 */
export function applyFullPayload(
  current: BoardPayload | null,
  next: BoardPayload,
  nextStartedAt: number,
  shownKanbanStartedAt: number,
): { payload: BoardPayload; kanbanStartedAt: number } {
  if (!current || nextStartedAt >= shownKanbanStartedAt) return { payload: next, kanbanStartedAt: nextStartedAt };
  return { payload: mergeKanbanFields(next, current), kanbanStartedAt: shownKanbanStartedAt };
}

/** A kanban read landed: merged when it started no earlier than the shown kanban part, else dropped (null). */
export function applyKanbanFields(
  current: BoardPayload | null,
  fields: BoardKanbanFields,
  startedAt: number,
  shownKanbanStartedAt: number,
): { payload: BoardPayload; kanbanStartedAt: number } | null {
  if (!current || startedAt < shownKanbanStartedAt) return null;
  return { payload: mergeKanbanFields(current, fields), kanbanStartedAt: startedAt };
}

export interface KanbanReloader {
  /** Ask for a kanban read: starts now when idle, else one more read runs after the one in flight. */
  request(why: string): void;
  inFlight(): boolean;
  /** Drop a queued follow-up and ignore the answer in flight (the pane moved to another task). */
  dispose(): void;
}

/**
 * Single flight: at most one kanban read in flight; any number of requests
 * meanwhile become exactly one read after it ends (success or failure).
 */
export function createKanbanReloader<T>(opts: {
  fetch: () => Promise<T>;
  apply: (data: T, startedAt: number, why: string) => void;
  onError?: (err: unknown, why: string) => void;
  now?: () => number;
}): KanbanReloader {
  const now = opts.now ?? (() => Date.now());
  let running = false;
  let queued: string | null = null;
  let disposed = false;
  const run = (why: string): void => {
    running = true;
    const startedAt = now();
    let p: Promise<T>;
    try {
      p = opts.fetch();
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (data) => { if (!disposed) opts.apply(data, startedAt, why); },
      (err) => { if (!disposed) opts.onError?.(err, why); },
    ).finally(() => {
      running = false;
      if (disposed || queued === null) return;
      const next = queued;
      queued = null;
      run(next);
    });
  };
  return {
    request(why) {
      if (disposed) return;
      if (running) { queued = queued ? queued : why; return; }
      run(why);
    },
    inFlight: () => running,
    dispose() { disposed = true; queued = null; },
  };
}
