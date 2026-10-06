/**
 * The server's facts on kanban cards (spec 4.2): a bus subscriber that writes
 * the card fields nobody else may write, for the DIRECT subtasks of an owner
 * that has a board file. It creates a file for one fact only, a hand back
 * (C57): no later write can recover it, and the leader's first board write
 * usually comes after its workers already handed work back. Even then only for
 * an owner that is its team's board owner (resolveTeamBoardTask), so a nested
 * leader never splits its team off an ancestor's board.
 *
 *   lane_auto          sticky, forward only, by autoLaneKind (board-lanes.ts):
 *                      card appeared, first running turn, phase IN_PROGRESS /
 *                      WAITING / COMPLETE; NEED_ACTION, idle, stopped, error and
 *                      a turn end never move it. No write when it would not change.
 *   handed_back_at     the worker's OWN session set NEED_ACTION (actorSid on the
 *                      phase event is one of the task's sessions), not a turn end.
 *   worker_summary_at  task.summary changed.
 *   output_at          a turn ended and task.summary changed during it.
 *
 * Writes per owner run in order (one promise chain each), so a fast phase
 * sequence lands in the order it happened. Primary only; async IO only.
 */

import { CLOUD_MODE } from '../../constants.js';
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import type { Task } from '../types.js';
import { emitChanged, hasBoard, updateBoard } from './board-store.js';
import { resolveTeamBoardTask, teamSnapshot } from './board-team.js';
import { prepareKanbanBoard, placeTask } from './board-kanban.js';
import {
  autoLaneKind, firstLaneOfKind, laneById, MAX_CARDS, summaryHash,
  type BoardCard, type BoardLane, type BoardLaneEvent,
} from './board-lanes.js';

export const BOARD_KANBAN_WATCH_SUBSCRIBER = 'board-kanban-watch';
const TRACK_CAP = 5_000;

/** A card change, or null = nothing to write. */
type CardPatch = (card: BoardCard, lanes: BoardLane[], now: string) => BoardCard | null;

const lastStatus = new Map<string, string>();
const lastSummary = new Map<string, string>();
const turnStart = new Map<string, { hash: string; at: string }>();
const chains = new Map<string, Promise<void>>();

function remember<V>(m: Map<string, V>, key: string, value: V): void {
  if (m.size >= TRACK_CAP && !m.has(key)) m.delete(m.keys().next().value as string);
  m.set(key, value);
}

const UNCHANGED = new Error('kanban-watch: unchanged');
const NO_FILE = new Error('kanban-watch: no board file');

/** Apply `patch` to the task's card on its parent's board, in order per owner. */
function patchCard(task: Task, why: string, patch: CardPatch, create = false): Promise<void> {
  const ownerId = task.parent_task_id;
  if (!ownerId) return Promise.resolve();
  const prev = chains.get(ownerId) ?? Promise.resolve();
  const run = prev.then(() => writeCard(ownerId, task, why, patch, create));
  const tail = run.catch(() => {}).finally(() => { if (chains.get(ownerId) === tail) chains.delete(ownerId); });
  chains.set(ownerId, tail);
  return run;
}

/** May a fact create this owner's board file? Only when it would be its team's board anyway. */
async function mayCreate(ownerId: string): Promise<boolean> {
  const team = await resolveTeamBoardTask(ownerId).catch(() => null);
  return !!team && team.taskId === ownerId;
}

async function writeCard(ownerId: string, task: Task, why: string, patch: CardPatch, create: boolean): Promise<void> {
  const exists = await hasBoard(ownerId);
  if (!exists && !(create && await mayCreate(ownerId))) return;
  const snap = await teamSnapshot(ownerId);
  if (!snap.members.has(task.id)) return;
  try {
    const next = await updateBoard(ownerId, (raw) => {
      if (!raw && !create) throw NO_FILE;
      const board = prepareKanbanBoard(raw, ownerId, snap, 'human');
      const current = board.cards[task.id];
      if (!current && Object.keys(board.cards).length >= MAX_CARDS) throw UNCHANGED;
      const changed = patch(current ?? {}, board.lanes ?? [], new Date().toISOString());
      if (!changed) throw UNCHANGED;
      return { ...board, cards: { ...board.cards, [task.id]: changed } };
    });
    emitChanged({ taskId: ownerId, kind: 'card', task: task.id, version: next.version });
    log.task.debug('kanban card fact written', { ownerId, taskId: task.id, why });
  } catch (err) {
    if (err === UNCHANGED || err === NO_FILE) return;
    log.task.warn('kanban card fact not written', {
      ownerId, taskId: task.id, why, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** lane_auto from one event; `onlyFromTodo` = the first running turn moves a card out of todo only. */
function laneAutoPatch(event: BoardLaneEvent, onlyFromTodo = false): CardPatch {
  return (card, lanes, now) => {
    const kind = autoLaneKind(event);
    if (!kind) return null;
    if (onlyFromTodo && card.lane_auto) {
      const was = laneById(lanes, card.lane_auto.lane);
      if (was && was.kind !== 'todo') return null;
    }
    const lane = firstLaneOfKind(lanes, kind)?.id;
    if (!lane || card.lane_auto?.lane === lane) return null;
    return { ...card, lane_auto: { lane, at: now } };
  };
}

function both(a: CardPatch, b: CardPatch): CardPatch {
  return (card, lanes, now) => {
    const first = a(card, lanes, now);
    const second = b(first ?? card, lanes, now);
    return second ?? first;
  };
}

/** The session made the call itself: actorSid is one of the task's own sessions. */
export function isOwnSession(task: Task, actorSid: string | undefined): boolean {
  if (!actorSid) return false;
  return (task.session_ids ?? []).includes(actorSid)
    || task.session_id === actorSid || task.exec_session_id === actorSid || task.plan_session_id === actorSid;
}

const hash = (t: Task) => summaryHash(t.summary ?? '');

async function taskById(id: string | null | undefined): Promise<Task | null> {
  if (!id) return null;
  const { getTask } = await import('../task-manager.js');
  return getTask(id).catch(() => null);
}

function onTaskCreated(task: Task): Promise<void> | void {
  remember(lastSummary, task.id, hash(task));
  if (!task.parent_task_id) return;
  const p = placeTask(task);
  return patchCard(task, 'card-appeared', (card, lanes, now) => (card.lane_auto ? null
    : laneAutoPatch({ type: 'card-appeared', phase: task.phase, hasHadSession: !!p.hasHadSession })(card, lanes, now)));
}

function onTaskUpdated(task: Task, fields: string[] | undefined): Promise<void> | void {
  if (!task.parent_task_id) { remember(lastSummary, task.id, hash(task)); return; }
  const h = hash(task);
  const known = lastSummary.get(task.id);
  remember(lastSummary, task.id, h);
  const summaryChanged = known !== undefined ? known !== h : !!fields?.includes('summary');
  const adopted = !!fields?.includes('parent_task_id');
  if (!summaryChanged && !adopted) return;
  return patchCard(task, summaryChanged ? 'worker-summary' : 'adopted', (card, lanes, now) => {
    let c: BoardCard | null = null;
    if (adopted && !card.lane_auto) {
      c = laneAutoPatch({ type: 'card-appeared', phase: task.phase, hasHadSession: !!placeTask(task).hasHadSession })(card, lanes, now);
    }
    if (summaryChanged) c = { ...(c ?? card), worker_summary_at: now };
    return c;
  });
}

function onPhaseChanged(task: Task, oldPhase: string, newPhase: string, actorSid: string | undefined): Promise<void> | void {
  if (!task.parent_task_id) return;
  let patch: CardPatch = laneAutoPatch({ type: 'phase', from: oldPhase, to: newPhase });
  const handBack = newPhase === 'NEED_ACTION' && isOwnSession(task, actorSid);
  if (handBack) patch = both(patch, (card, _lanes, now) => ({ ...card, handed_back_at: now }));
  return patchCard(task, `phase ${oldPhase}->${newPhase}`, patch, handBack);
}

async function onSessionStatus(sessionId: string, taskId: string | null, status: string): Promise<void> {
  const was = lastStatus.get(sessionId);
  remember(lastStatus, sessionId, status);
  if (status !== 'running' || was === 'running') return;
  const task = await taskById(taskId);
  if (!task?.parent_task_id) return;
  remember(turnStart, task.id, { hash: hash(task), at: new Date().toISOString() });
  await patchCard(task, 'session-running', laneAutoPatch({ type: 'session-running' }, true));
}

async function onSessionResult(taskId: string | undefined, replayed: boolean): Promise<void> {
  if (replayed || !taskId) return;
  const start = turnStart.get(taskId);
  turnStart.delete(taskId);
  if (!start) return;
  const task = await taskById(taskId);
  if (!task?.parent_task_id || hash(task) === start.hash) return;
  await patchCard(task, 'output', (card, _lanes, now) => ({
    ...card,
    output_at: now,
    worker_summary_at: card.worker_summary_at && card.worker_summary_at >= start.at ? card.worker_summary_at : now,
  }));
}

const pending = new Set<Promise<void>>();

function track(p: Promise<void> | void): void {
  if (!p) return;
  const t = p.catch((err) => {
    log.task.warn('kanban watch failed', { error: err instanceof Error ? err.message : String(err) });
  }).finally(() => { pending.delete(t); });
  pending.add(t);
}

function onEvent(event: BusEvent): void {
  const d = (event.data ?? {}) as Record<string, unknown>;
  switch (event.name) {
    case EventNames.TASK_CREATED:
      if (d.task) track(onTaskCreated(d.task as Task));
      return;
    case EventNames.TASK_UPDATED:
      if (d.task) track(onTaskUpdated(d.task as Task, Array.isArray(d.fields) ? d.fields as string[] : undefined));
      return;
    case EventNames.TASK_PHASE_CHANGED:
      if (d.task) {
        track(onPhaseChanged(d.task as Task, String(d.oldPhase ?? ''), String(d.newPhase ?? ''),
          typeof d.actorSid === 'string' ? d.actorSid : undefined));
      }
      return;
    case EventNames.SESSION_STATUS_CHANGED: {
      const s = (d.status && typeof d.status === 'object' ? d.status : d) as Record<string, unknown>;
      const sid = typeof s.sessionId === 'string' ? s.sessionId : '';
      if (sid && typeof s.process_status === 'string') {
        track(onSessionStatus(sid, typeof s.taskId === 'string' ? s.taskId : null, s.process_status));
      }
      return;
    }
    case EventNames.SESSION_RESULT:
      track(onSessionResult(typeof d.taskId === 'string' ? d.taskId : undefined, d.replayed === true));
      return;
    default:
  }
}

/** Start the watch (server boot, next to the reminders clock; primary only). Idempotent. */
export function startBoardKanbanWatch(): void {
  if (CLOUD_MODE) return;
  bus.subscribe(BOARD_KANBAN_WATCH_SUBSCRIBER, onEvent, {
    global: true,
    interest: [EventNames.TASK_CREATED, EventNames.TASK_UPDATED, EventNames.TASK_PHASE_CHANGED,
      EventNames.SESSION_STATUS_CHANGED, EventNames.SESSION_RESULT],
  });
}

export function stopBoardKanbanWatch(): void {
  bus.unsubscribe(BOARD_KANBAN_WATCH_SUBSCRIBER);
  lastStatus.clear();
  lastSummary.clear();
  turnStart.clear();
}

/** Test seam: wait until every write the watch started has landed. */
export async function _kanbanWatchIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
