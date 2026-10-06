/**
 * The live data behind the Board's kanban (spec 8.5): nothing polls. Tasks
 * come from the task store, each session's state from the session-status store
 * (its epoch), an open prompt's request id and detail from the notifications
 * feed, lanes and cards from the board payload useTaskBoard keeps current
 * (with this window's optimistic overlays laid over it, kanban-overlay.ts),
 * and the only clock is a minute tick. Team ids the store does not hold (done
 * long ago, G8) load through ensureAllTasks; until they arrive their cards are
 * loading cards in their lanes.
 *
 * Card view models keep their identity while their content is the same, so a
 * session-status update re-renders only the card it changed (G36).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useNotifications } from '@/contexts/notifications/NotificationProvider';
import { permissionDetail, requestIdOf } from '@/contexts/notifications/notification-model';
import type { Notification } from '@/contexts/notifications/types';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { sessionStatusStore } from '@/stores/session-status-store';
import { waitText } from './kanban-time';
import { log } from '@/utils/log';
import { resolveTaskSessionId } from '@/utils/session-status';
import type { BoardKanbanSeen, BoardPayload, BoardSeen } from '../board-model';
import { NO_BOARD_ELEMENTS, boardSignals, walkTeam, teamChildren, TEAM_DEPTH_CAP, type BoardElement, type BoardElements } from '../board-overview-model';
import type { BoardCard, BoardLane } from '../../../../../src/core/boards/board-lanes';
import type { KanbanCardVM, KanbanLive } from './kanban-card-model';
import { buildBoardVM, type KanbanBoardVM } from './kanban-model';
import { applyOverlays, type OverlayMap, type TaskPhasePatch } from './kanban-overlay';
import { useTeamSummaries } from './useTeamSummaries';
import { useTeamStatusReady } from './useTeamStatusReady';

const MINUTE_MS = 60_000;

/**
 * A clock that moves once a minute: the time of the last tick (the mount, then
 * each wall clock minute). Every relative time on the cards reads this one value,
 * so a status update re-renders the one card it touched, never the cards whose
 * `just now` happens to cross a minute in between (G36); they all move on the tick.
 */
export function useMinuteClock(): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => { setClock(Date.now()); arm(); }, MINUTE_MS - (Date.now() % MINUTE_MS) + 50);
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return clock;
}

function elementsOf(doc: Document, selector: string): BoardElement[] {
  return Array.from(doc.querySelectorAll(selector)).map((el) => ({
    id: el.getAttribute('id') ?? '',
    title: (el.getAttribute('title') ?? '').trim(),
    task: (el.getAttribute('task') ?? '').trim(),
  })).filter((el) => el.id);
}

/** The page's choices and threads, read with DOMParser: an inert document (no script runs), once per html version. */
export function parseBoardElements(html: string | null | undefined): BoardElements {
  if (!html || typeof DOMParser === 'undefined') return NO_BOARD_ELEMENTS;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { choices: elementsOf(doc, 'walnut-choice[id]'), threads: elementsOf(doc, 'walnut-thread[id]') };
  } catch (err) {
    log.warn('board', 'board html not parsed for the kanban', { error: err instanceof Error ? err.message : String(err) });
    return NO_BOARD_ELEMENTS;
  }
}

/** The notifications feed, or none where no provider is mounted (a pop-out window, a test). */
function useFeedSafe(): readonly Notification[] {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- useContext runs on every render either way
    return useNotifications().feed;
  } catch {
    return [];
  }
}

/** Open prompts by session: the request to answer and what it asks (a command, a plan, a file). */
function pendingPrompts(feed: readonly Notification[]): Map<string, { requestId: string | null; detail: string | null }> {
  const out = new Map<string, { requestId: string | null; detail: string | null }>();
  for (const n of feed) {
    if (n.kind !== 'permission' || n.resolved || !n.sessionId) continue;
    const d = permissionDetail(n);
    const detail = d.type === 'bash' ? d.command : d.type === 'plan' ? d.plan : d.type === 'file' ? d.filePath
      : d.type === 'generic' ? d.preview ?? null : null;
    out.set(n.sessionId, { requestId: requestIdOf(n), detail: detail || null });
  }
  return out;
}

export interface KanbanBoardState {
  /** Null when there is no task store (a pop-out window: the Page alone). */
  vm: KanbanBoardVM | null;
  /** Lanes and cards as shown (payload plus this window's overlays). */
  lanes: BoardLane[];
  cards: Record<string, BoardCard>;
  /** A task as shown (a phase this window just changed included). */
  taskOf(id: string): Task | undefined;
  /** Every team task (the owner's subtree) the store holds. */
  teamIds: ReadonlySet<string>;
  isChoice(id: string): boolean;
  now: number;
}

export interface KanbanBoardArgs {
  ownerId: string;
  payload: BoardPayload | null;
  /** The browser's thread seen record (thread id to last read ts). */
  threadSeen: BoardSeen;
  /** The "Changed" baseline (useKanbanSeen); undefined = the payload's. */
  baseline?: BoardKanbanSeen | null;
  overlays: OverlayMap;
}

/** The store's task with this window's phase write and, when the store has none, its read summary. */
function withPhase(t: Task, p: TaskPhasePatch | undefined, summary?: string): Task {
  const base = summary !== undefined && t.summary === undefined && (t as { has_summary?: boolean }).has_summary !== false
    ? { ...t, summary } as Task : t;
  if (!p) return base;
  const out = { ...base, phase: p.phase } as Task;
  if (p.completed_at === null) delete (out as { completed_at?: string }).completed_at;
  else if (p.completed_at) (out as { completed_at?: string }).completed_at = p.completed_at;
  return out;
}

/** Same content, same object: React.memo cards skip a render (G36). */
function stabilize(prev: Map<string, { key: string; vm: KanbanCardVM }>, cards: Record<string, KanbanCardVM>): Record<string, KanbanCardVM> {
  const out: Record<string, KanbanCardVM> = {};
  const seen = new Set<string>();
  for (const [id, vm] of Object.entries(cards)) {
    const key = JSON.stringify(vm);
    const old = prev.get(id);
    if (old && old.key === key) out[id] = old.vm;
    else { out[id] = vm; prev.set(id, { key, vm }); }
    seen.add(id);
  }
  for (const id of [...prev.keys()]) if (!seen.has(id)) prev.delete(id);
  return out;
}

/** The team under `ownerId` as kanban view models, live. */
export function useKanbanBoard({ ownerId, payload, threadSeen, baseline, overlays }: KanbanBoardArgs): KanbanBoardState {
  const store = useTasksContextSafe();
  const epoch = useSessionStatusEpoch();
  const clock = useMinuteClock();
  const feed = useFeedSafe();
  const html = payload?.board?.html ?? null;
  const elements = useMemo(() => parseBoardElements(html), [html]);
  const tasks = store?.tasks;
  const cache = useRef(new Map<string, { key: string; vm: KanbanCardVM }>());
  useEffect(() => { cache.current = new Map(); }, [ownerId]);

  const shown = useMemo(() => applyOverlays({
    cards: payload?.cards ?? {}, lanes: payload?.lanes_effective ?? [], team: payload?.team ?? [],
  }, overlays), [payload?.cards, payload?.lanes_effective, payload?.team, overlays]);

  const byId = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks ?? []) m.set(t.id, t);
    return m;
  }, [tasks]);
  const teamIds = useMemo(() => {
    const ids = new Set<string>();
    if (!tasks) return ids;
    for (const m of walkTeam(ownerId, teamChildren(tasks, ownerId), TEAM_DEPTH_CAP)) ids.add(m.task.id);
    return ids;
  }, [tasks, ownerId]);
  const prompts = useMemo(() => pendingPrompts(feed), [feed]);
  // N5: the team's session ids, known once the store is in (the board payload is not needed, so the
  // statuses are fetched alongside it, not after it); lanes wait for their statuses.
  const teamSessionIds = useMemo((): string[] | null => {
    if (!tasks || store?.loading) return null;
    const out: string[] = [];
    // Open tasks only, as the page's list hydration: a done card's status never reorders a lane.
    for (const id of teamIds) {
      const t = byId.get(id);
      const sid = t && t.phase !== 'COMPLETE' ? resolveTaskSessionId(t) : null;
      if (sid) out.push(sid);
    }
    return out;
  }, [tasks, teamIds, byId, store?.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const statusReady = useTeamStatusReady(ownerId, teamSessionIds);
  const teamList = useMemo(() => (payload?.team ?? []).map((e) => e.id), [payload?.team]);
  const teamSummaries = useTeamSummaries(ownerId, teamList, byId);
  const summaries = teamSummaries.map;

  // G8: the team's done tasks older than the store's window load once, on demand.
  const missing = (payload?.team ?? []).some((e) => !byId.has(e.id));
  const ensureAll = store?.ensureAllTasks;
  useEffect(() => {
    if (!missing || !ensureAll || store?.loading) return;
    log.info('board', 'kanban loading tasks missing from the store', { taskId: ownerId });
    ensureAll();
  }, [missing, ensureAll, ownerId, store?.loading]);

  const isChoice = useMemo(() => {
    const ids = new Set(elements.choices.map((c) => c.id));
    return (id: string) => ids.has(id);
  }, [elements]);

  const taskOf = useMemo(() => (id: string): Task | undefined => {
    const t = byId.get(id);
    return t ? withPhase(t, shown.tasks[id], summaries.get(id)) : undefined;
  }, [byId, shown.tasks, summaries]);

  const now = Date.now();
  const vm = useMemo((): KanbanBoardVM | null => {
    if (!tasks || !payload) return null;
    const team = tasks.filter((t) => teamIds.has(t.id)).map((t) => withPhase(t, shown.tasks[t.id], summaries.get(t.id)));
    const liveOf = (task: Task): KanbanLive | null => {
      const sid = resolveTaskSessionId(task);
      if (!sid) return null;
      const status = sessionStatusStore.getStatus(sid) ?? task.session_status ?? null;
      if (!status) return null;
      const p = prompts.get(sid);
      return {
        ...status, sessionId: sid,
        ...(p ? { pendingPermissionRequestId: p.requestId, pendingPermissionDetail: p.detail } : {}),
      };
    };
    const signals = boardSignals(elements, payload, threadSeen, ownerId, teamIds, clock);
    const built = buildBoardVM({
      ownerId, owner: byId.get(ownerId) ?? null, taskOf, team,
      payload: { lanes_effective: shown.lanes, cards: shown.cards, team: shown.team, kanban_seen: payload.kanban_seen },
      ...(baseline !== undefined ? { baseline } : {}),
      liveOf, now: clock, formatWaitUntil: (iso: string) => waitText(iso, clock), titleOf: (id) => byId.get(id)?.title ?? '',
      signals, isChoice, storeLoading: !!store?.loading || !statusReady || !teamSummaries.ready,
      humanPhase: (id) => !!shown.tasks[id],
    });
    return { ...built, cards: stabilize(cache.current, built.cards) };
    // `epoch` and `clock` are the triggers: the session store and the clock moved.
  }, [tasks, payload, shown, teamIds, prompts, elements, threadSeen, ownerId, baseline, taskOf, isChoice, store?.loading, statusReady, epoch, clock, summaries, teamSummaries.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return { vm, lanes: shown.lanes, cards: shown.cards, taskOf, teamIds, isChoice, now };
}
