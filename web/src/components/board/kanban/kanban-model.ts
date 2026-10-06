/**
 * The kanban board's view model (spec 2, 6, 7): one card per DIRECT subtask of
 * the owner (the server's `team` list, so done ones older than the store's
 * window count too; a task the store has not delivered is a loading card in
 * its lane), each lane's ordered cards, the rollup and workers line, the chip
 * counts and the one attention number (G12) the chips and the view toggle
 * share. Pure: no React, no DOM. Unit-pinned in tests/web/kanban-model.test.ts.
 */
import type { Task } from '@open-walnut/core';
import type { BoardKanbanSeen, BoardLane, BoardPayload, BoardTeamEntry } from '../board-model';
import { TEAM_DEPTH_CAP, isDoneTask, teamChildren, walkTeam, type BoardSignal } from '../board-overview-model';
import { deriveDisplayStatus, resolveTaskSessionId } from '@/utils/session-status';
import type { ProcessStatus } from '@/types/session';
import type { KanbanChipId } from './kanban-contract';
import {
  buildCardVM, redReasonOf, type KanbanCardVM, type KanbanLive, type KanbanNestedNeed, type KanbanStatus,
} from './kanban-card-model';
import { changeLog, type KanbanChange } from './kanban-changes-model';
import { chipCounts, sevChipShown } from './kanban-filter-model';

export interface KanbanLaneVM {
  lane: BoardLane;
  /** Every card of the lane, in display order (filters hide, never reorder). */
  cardIds: string[];
  total: number;
  /** Cards whose status line is red. */
  needs: number;
  /** Done kind: cards whose task is still open (`24 (1 open)`). */
  openInDone: number;
  /** Under the active chip or search: the cards it shows (filteredLane, R3-07). */
  matched?: number;
  /** Cards headed here that a held lane still draws (kanban-drawn.ts). */
  incoming?: number;
}

export interface KanbanLeaderVM {
  taskId: string;
  title: string;
  status: KanbanStatus;
  needsYou: boolean;
  hasSession: boolean;
  sessionId?: string;
}

export type KanbanWorkerKey = 'running' | 'waiting' | 'idle' | 'error' | 'no-session';

export interface KanbanRollup {
  open: number;
  done: number;
  /** Cards in a done lane whose task is still open. */
  stillOpen: number;
  /** Done share by lane, 0 to 100. */
  percent: number;
  /** `14 open · 23 done`, `All 37 done`, `No tasks yet`. */
  text: string;
  /** `1 task still open` ('' when none). */
  stillOpenText: string;
  /** G33: the open cards' sessions; empty when none has a session. */
  workers: Array<{ key: KanbanWorkerKey; n: number; text: string }>;
}

export interface KanbanBoardVM {
  ownerId: string;
  lanes: KanbanLaneVM[];
  cards: Record<string, KanbanCardVM>;
  leader: KanbanLeaderVM | null;
  rollup: KanbanRollup;
  chips: Record<KanbanChipId, number>;
  sevChipShown: boolean;
  /** Red cards (nested rolled in, once) + the leader: the chip's number and the toggle's red count. */
  attention: number;
  changes: KanbanChange[];
  loading: boolean;
  empty: boolean;
}

export interface KanbanBoardInput {
  ownerId: string;
  owner: Task | null;
  taskOf: (id: string) => Task | undefined;
  /** The store's tasks (nested workers are found here). */
  team: readonly Task[];
  payload: Pick<BoardPayload, 'lanes_effective' | 'cards' | 'team' | 'kanban_seen'> | null;
  liveOf: (task: Task) => KanbanLive | null;
  /** The "Changed" baseline; defaults to payload.kanban_seen. */
  baseline?: BoardKanbanSeen | null;
  now: number;
  formatWaitUntil?: (iso: string) => string;
  titleOf: (id: string) => string;
  /** boardSignals of the page, filed by task. */
  signals?: readonly BoardSignal[];
  isChoice?: (id: string) => boolean;
  /** The task store has not answered yet. */
  storeLoading?: boolean;
  /** R3-02: tasks whose phase this user just changed from the board (a pending write): the move is theirs. */
  humanPhase?: (id: string) => boolean;
}

/**
 * N13 (spec 7.1): the workers line counts SESSIONS by state, a different number
 * from the Needs you chip (which also counts errors, hand backs and board
 * signals), so each bucket says what it is: `waiting on your answer` (an open
 * permission prompt or question), `idle` (alive between turns or stopped).
 */
const WORKER_WORDS: Record<KanbanWorkerKey, string> = {
  running: 'running', waiting: 'waiting on your answer', idle: 'idle', error: 'error', 'no-session': 'no session',
};
const WORKER_ORDER: readonly KanbanWorkerKey[] = ['running', 'waiting', 'idle', 'error', 'no-session'];

const msOf = (s: string | undefined) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : 0; };
const sevRank = (sev: string | undefined) => { const n = Number.parseInt(sev ?? '', 10); return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY; };

/**
 * A lane's display order. Done kind: newest max(completed_at, lane_at) first
 * (no rank, G26). Others: cards nobody ordered first (needs you, then sev
 * ascending with no sev last, then created_at old to new), then the ranked
 * ones by rank (a rank counts only in the lane it was given in).
 */
export function orderLane(
  cards: readonly Pick<KanbanCardVM, 'taskId' | 'rank' | 'needsYou' | 'sev' | 'createdAt' | 'doneAt'>[],
  lane: Pick<BoardLane, 'kind'>,
): string[] {
  const list = [...cards];
  if (lane.kind === 'done') {
    list.sort((a, b) => msOf(b.doneAt) - msOf(a.doneAt) || msOf(b.createdAt) - msOf(a.createdAt) || a.taskId.localeCompare(b.taskId));
    return list.map((c) => c.taskId);
  }
  const unranked = list.filter((c) => c.rank === undefined).sort((a, b) =>
    Number(b.needsYou) - Number(a.needsYou) || sevRank(a.sev) - sevRank(b.sev)
    || msOf(a.createdAt) - msOf(b.createdAt) || a.taskId.localeCompare(b.taskId));
  const ranked = list.filter((c) => c.rank !== undefined).sort((a, b) =>
    (a.rank as number) - (b.rank as number) || msOf(a.createdAt) - msOf(b.createdAt) || a.taskId.localeCompare(b.taskId));
  return [...unranked, ...ranked].map((c) => c.taskId);
}

/** G12: red cards (a nested worker already rolled into its parent, so counted once) plus the leader. Unread never counts. */
export function teamAttention(cards: readonly Pick<KanbanCardVM, 'needsYou' | 'loading'>[], leader: Pick<KanbanLeaderVM, 'needsYou'> | null): number {
  let n = leader?.needsYou ? 1 : 0;
  for (const c of cards) if (!c.loading && c.needsYou) n++;
  return n;
}

function workerKey(c: KanbanCardVM, live: KanbanLive | null): KanbanWorkerKey {
  if (!c.hasSession) return 'no-session';
  if (c.running) return 'running';
  const ps = live?.process_status as ProcessStatus | undefined;
  const tool = live?.pendingPermissionTool || '';
  const d = ps ? deriveDisplayStatus(ps, tool ? { requestId: tool } : null) : null;
  if (d === 'waiting') return 'waiting';
  if (d === 'error') return 'error';
  return 'idle';
}

/** The rollup by lane kind (G7) and the workers line (G33). */
export function buildRollup(cards: readonly KanbanCardVM[], liveOf: (id: string) => KanbanLive | null): KanbanRollup {
  let open = 0, done = 0, stillOpen = 0;
  const counts: Record<KanbanWorkerKey, number> = { running: 0, waiting: 0, idle: 0, error: 0, 'no-session': 0 };
  for (const c of cards) {
    if (c.laneKind === 'done') {
      done++;
      if (!c.isComplete) stillOpen++;
      continue;
    }
    open++;
    if (!c.loading) counts[workerKey(c, liveOf(c.taskId))]++;
  }
  const total = open + done;
  const withSession = counts.running + counts.waiting + counts.idle + counts.error;
  const workers = withSession === 0 ? [] : WORKER_ORDER.filter((k) => counts[k] > 0)
    .map((key) => ({ key, n: counts[key], text: `${counts[key]} ${WORKER_WORDS[key]}` }));
  return {
    open, done, stillOpen,
    percent: total ? Math.round((done / total) * 100) : 0,
    text: total === 0 ? 'No tasks yet' : open === 0 ? `All ${total} done` : `${open} open · ${done} done`,
    stillOpenText: stillOpen ? `${stillOpen} ${stillOpen === 1 ? 'task' : 'tasks'} still open` : '',
    workers,
  };
}

/** The first red reason under a card (depth first), as its rolled up need. */
function nestedNeedOf(
  taskId: string, childrenOf: (id: string) => readonly Task[], input: KanbanBoardInput, signalsOf: (id: string) => BoardSignal[],
): KanbanNestedNeed | null {
  for (const m of walkTeam(taskId, childrenOf, TEAM_DEPTH_CAP - 1)) {
    const red = redReasonOf(m.task, input.liveOf(m.task), null, signalsOf(m.task.id), input.isChoice);
    if (red) return { taskId: m.task.id, title: m.task.title, text: red.text, ...(red.prompt ? { prompt: red.prompt } : {}) };
  }
  return null;
}

/** The whole kanban view model. */
export function buildBoardVM(input: KanbanBoardInput): KanbanBoardVM {
  const { ownerId, payload, now } = input;
  const lanes = payload?.lanes_effective ?? [];
  const baseline = input.baseline !== undefined ? input.baseline : payload?.kanban_seen ?? null;
  const childrenOf = teamChildren(input.team, ownerId);
  const bySignalTask = new Map<string, BoardSignal[]>();
  for (const s of input.signals ?? []) {
    const list = bySignalTask.get(s.taskId);
    if (list) list.push(s); else bySignalTask.set(s.taskId, [s]);
  }
  const signalsOf = (id: string) => bySignalTask.get(id) ?? [];

  // Direct subtasks: the server's list, plus any the store knows that the payload has not caught up with.
  const entries = new Map<string, BoardTeamEntry>();
  for (const e of payload?.team ?? []) entries.set(e.id, e);
  for (const t of childrenOf(ownerId)) {
    if (!entries.has(t.id)) entries.set(t.id, { id: t.id, phase: t.phase, ...(t.completed_at ? { completed_at: t.completed_at } : {}) });
  }

  const cards: Record<string, KanbanCardVM> = {};
  const liveById = new Map<string, KanbanLive | null>();
  for (const entry of entries.values()) {
    const task = input.taskOf(entry.id) ?? null;
    const live = task ? input.liveOf(task) : null;
    liveById.set(entry.id, live);
    const kids = task ? childrenOf(task.id) : [];
    cards[entry.id] = buildCardVM({
      taskId: entry.id, task, entry, card: payload?.cards[entry.id] ?? null, lanes, live,
      signals: signalsOf(entry.id), nested: task && kids.length ? nestedNeedOf(task.id, childrenOf, input, signalsOf) : null,
      openSubtasks: kids.filter((k) => !isDoneTask(k)).length,
      ownerId, titleOf: input.titleOf, baseline: baseline?.cards[entry.id], hasBaseline: !!baseline,
      baselineAt: baseline?.at ?? null, now, formatWaitUntil: input.formatWaitUntil, isChoice: input.isChoice,
      humanPhase: !!input.humanPhase?.(entry.id),
    });
  }
  const list = Object.values(cards);

  const laneVMs: KanbanLaneVM[] = lanes.map((lane) => {
    const inLane = list.filter((c) => c.lane === lane.id);
    return {
      lane, cardIds: orderLane(inLane, lane), total: inLane.length,
      needs: inLane.filter((c) => c.needsYou).length,
      openInDone: lane.kind === 'done' ? inLane.filter((c) => !c.isComplete && !c.loading).length : 0,
    };
  });

  let leader: KanbanLeaderVM | null = null;
  if (input.owner) {
    const o = input.owner;
    const sessionId = resolveTaskSessionId(o) ?? undefined;
    const red = redReasonOf(o, input.liveOf(o), null, signalsOf(o.id), input.isChoice);
    leader = {
      taskId: o.id, title: o.title, needsYou: !!red, hasSession: !!sessionId, ...(sessionId ? { sessionId } : {}),
      status: red ?? { text: '', tone: 'grey', kind: sessionId ? 'stopped' : 'no-session', tooltip: '' },
    };
  }
  const chips = chipCounts(list, !!leader?.needsYou);
  return {
    ownerId, lanes: laneVMs, cards, leader,
    rollup: buildRollup(list, (id) => liveById.get(id) ?? null),
    chips, sevChipShown: sevChipShown(list), attention: teamAttention(list, leader),
    changes: changeLog(list, now),
    loading: !!input.storeLoading, empty: list.length === 0 && !input.storeLoading,
  };
}
