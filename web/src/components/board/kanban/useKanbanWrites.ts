/**
 * Every kanban write (spec 8.3), the KanbanWriteApi the cards, lanes and menus
 * call: PUT lanes, PUT cards/:task, POST move (the lane's full order), POST
 * cards (a new subtask), POST suggestion, POST /tasks/:id/complete, PATCH
 * phase (reopen, undo). Each write lays an overlay (kanban-overlay.ts) that
 * stays until a read that started after its response lands (G32); a failure or
 * 15s of silence removes it and says so in a toast. Successful moves, completes
 * and lane drops toast with Undo and Show (G14, G7, G16).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiPatch, apiPost, apiPut } from '@/api/client';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { log } from '@/utils/log';
import { autoLaneKind, firstLaneOfKind, type BoardCard, type BoardLane } from '../../../../../src/core/boards/board-lanes';
import { boardErrorMessage, boardPath } from '../useTaskBoard';
import type {
  KanbanCardPatch, KanbanMoveOptions, KanbanToastAction, KanbanToastApi, KanbanWriteApi, SetCardResult,
} from './kanban-contract';
import type { KanbanBoardVM } from './kanban-model';
import {
  KANBAN_WRITE_TIMEOUT_MS, LANES_KEY, dropOverlay, markResponded, moveCardPatches, putOverlay, releaseOverlays,
  releaseTaskOverlays, setCardPatch, type KanbanOverlay, type OverlayMap,
} from './kanban-overlay';

/** A card the user is adding: shown at the bottom of its lane until the real one arrives. */
export interface PendingAdd {
  key: string;
  laneId: string;
  title: string;
  /** Set once the route answered: the pending card leaves when the real card is on the board. */
  taskId?: string;
}

export interface KanbanWritesDeps {
  ownerId: string;
  /** The board as shown right now (read at call time). */
  getVM: () => KanbanBoardVM | null;
  getCards: () => Record<string, BoardCard>;
  /** A lane's full order as drawn (the freeze's), so a drop lands where its line was. */
  getLaneOrder: (laneId: string) => readonly string[] | undefined;
  fetchStartedAt: number;
  reloadKanban: () => void;
  toasts: KanbanToastApi;
  storePhase: (taskId: string) => string | undefined;
  /** The user's own write: cards go where they were put now (kanban-freeze). */
  onApplied: () => void;
  /** Toast `Show`: scroll the card into view, unfold its lane, flash and focus it. */
  onReveal: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  /** R3-02: the user changed this task's phase from the board (Complete, Reopen, Undo): the move it causes is not news. */
  onHumanPhase?: (taskId: string) => void;
}

export interface KanbanWrites {
  api: KanbanWriteApi;
  overlays: OverlayMap;
  pending: readonly PendingAdd[];
  /** The server answered 501 (a replica): every write control is off. */
  readOnly: boolean;
}

/** A failed write's code and body (v1 errors are `{ error: { code, message }, ...extra }`). */
function errorOf(err: unknown): { status: number; code: string; body: Record<string, unknown> } {
  if (err instanceof ApiError) {
    const body = (err.body && typeof err.body === 'object' ? err.body : {}) as Record<string, unknown>;
    const e = body.error as { code?: unknown } | undefined;
    return { status: err.status, code: typeof e?.code === 'string' ? e.code : '', body };
  }
  return { status: 0, code: '', body: {} };
}

/** The request, or a timeout error after 15s (counted as a failure). */
function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Walnut did not answer in time')), KANBAN_WRITE_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const quote = (title: string) => `"${title.length > 60 ? `${title.slice(0, 59)}…` : title}"`;

export function useKanbanWrites(deps: KanbanWritesDeps): KanbanWrites {
  const { ownerId } = deps;
  const replica = useIsCloudReplica();
  const [notImplemented, setNotImplemented] = useState(false);
  const readOnly = replica || notImplemented;
  const [overlays, setOverlays] = useState<OverlayMap>(() => new Map());
  const [pending, setPending] = useState<PendingAdd[]>([]);
  const seq = useRef(0);
  const d = useRef(deps);
  d.current = deps;
  const base = boardPath(ownerId);
  useEffect(() => { setOverlays(new Map()); setPending([]); setNotImplemented(false); }, [ownerId]);

  // G32: a read that started after a write's response releases that write's overlay.
  useEffect(() => {
    setOverlays((cur) => {
      const a = releaseOverlays(cur, deps.fetchStartedAt) ?? cur;
      return releaseTaskOverlays(a, deps.storePhase, deps.fetchStartedAt, Date.now()) ?? a;
    });
  }, [deps.fetchStartedAt, deps.storePhase]);

  // A pending card leaves once its real card is on the board.
  const vmNow = deps.getVM();
  useEffect(() => {
    if (!pending.some((p) => p.taskId && vmNow?.cards[p.taskId] && !vmNow.cards[p.taskId].loading)) return;
    setPending((cur) => cur.filter((p) => !(p.taskId && vmNow?.cards[p.taskId] && !vmNow.cards[p.taskId].loading)));
  }, [vmNow, pending]);

  /** Lay `ov`, send `req`; true when it answered OK. The overlay waits for a newer read, or leaves on failure. */
  const run = useCallback(async <T,>(key: string, ov: Omit<KanbanOverlay, 'key' | 'seq' | 'startedAt'>, req: () => Promise<T>): Promise<
    { ok: true; data: T } | { ok: false; err: unknown }
  > => {
    const mine = ++seq.current;
    setOverlays((cur) => putOverlay(cur, { ...ov, key, seq: mine, startedAt: Date.now() }));
    d.current.onApplied();
    try {
      const data = await withTimeout(req());
      setOverlays((cur) => markResponded(cur, key, mine, Date.now()) ?? cur);
      // A read that starts after this answer releases the overlay (the board:changed read may have started before it).
      d.current.reloadKanban();
      return { ok: true, data };
    } catch (err) {
      setOverlays((cur) => dropOverlay(cur, key, mine) ?? cur);
      d.current.onApplied();
      if (errorOf(err).status === 501) setNotImplemented(true);
      return { ok: false, err };
    }
  }, []);

  const titleOf = (taskId: string) => d.current.getVM()?.cards[taskId]?.title || taskId;
  const laneNameOf = (laneId: string) => d.current.getVM()?.lanes.find((l) => l.lane.id === laneId)?.lane.name ?? laneId;

  const toastError = (text: string, actions?: KanbanToastAction[]) => {
    d.current.toasts.push({ text, tone: 'error', ...(actions ? { actions } : {}) });
  };

  const moveCard = useCallback(async (taskId: string, laneId: string, opts: KanbanMoveOptions = {}): Promise<boolean> => {
    const vm = d.current.getVM();
    const card = vm?.cards[taskId];
    const target = vm?.lanes.find((l) => l.lane.id === laneId);
    const reason = opts.reason ?? 'menu';
    if (!vm || !card) return false;
    if (!target) {
      toastError('That lane was just deleted. The board is up to date again.');
      d.current.reloadKanban();
      return false;
    }
    const from = vm.lanes.find((l) => l.lane.id === card.lane);
    const fromIndex = from ? (d.current.getLaneOrder(from.lane.id) ?? from.cardIds).indexOf(taskId) : -1;
    const sameLane = card.lane === laneId;
    const doneLane = target.lane.kind === 'done';
    const rest = (d.current.getLaneOrder(laneId) ?? target.cardIds).filter((id) => id !== taskId);
    const index = doneLane ? 0 : Math.max(0, Math.min(opts.index ?? 0, rest.length));
    const order = [...rest.slice(0, index), taskId, ...rest.slice(index)];
    const rankOnly = opts.rankOnly ?? sameLane;
    const started = Date.now();
    const waitingOn = d.current.getCards()[taskId]?.waiting_on;
    const r = await run(taskId, { cards: moveCardPatches(taskId, laneId, order, { rankOnly, doneLane, nowIso: new Date().toISOString() }) },
      () => apiPost(`${base}/cards/${encodeURIComponent(taskId)}/move`, { lane: laneId, order, ...(rankOnly ? { rank_only: true } : {}) }));
    const ms = Date.now() - started;
    if (!r.ok) {
      const e = errorOf(r.err);
      log.warn('board', 'kanban card move failed', { taskId: ownerId, cardTaskId: taskId, lane: laneId, ms, reason, error: boardErrorMessage(r.err) });
      if (e.code === 'lane_not_found') {
        toastError('That lane was just deleted. The board is up to date again.');
        d.current.reloadKanban();
      } else {
        toastError(`Couldn't move ${quote(card.title)}: ${boardErrorMessage(r.err)}`);
      }
      return false;
    }
    log.info('board', 'kanban card moved', { taskId: ownerId, cardTaskId: taskId, lane: laneId, ms, reason, index });
    if (reason === 'undo' || sameLane) return true;
    afterMove({ taskId, title: card.title, laneId, laneName: target.lane.name, doneLane, completeOnDrop: !!target.lane.complete_on_drop,
      isComplete: card.isComplete, fromDone: from?.lane.kind === 'done', fromWait: from?.lane.kind === 'wait' && !!waitingOn,
      reason, undo: { lane: card.lane, index: fromIndex, source: card.source } });
    return true;
  }, [run, base, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCard = useCallback(async (taskId: string, patch: KanbanCardPatch, ifUnchangedSince?: string): Promise<SetCardResult> => {
    const body = { ...patch, ...(ifUnchangedSince !== undefined ? { if_unchanged_since: ifUnchangedSince } : {}) };
    const r = await run(taskId, { cards: { [taskId]: setCardPatch(patch, new Date().toISOString()) } },
      () => apiPut(`${base}/cards/${encodeURIComponent(taskId)}`, body));
    if (r.ok) {
      log.info('board', 'kanban card saved', { taskId: ownerId, cardTaskId: taskId, fields: Object.keys(patch).join(',') });
      return { ok: true };
    }
    const e = errorOf(r.err);
    if (e.code === 'changed_since') {
      const s = (k: string) => (typeof e.body[k] === 'string' ? e.body[k] as string : '');
      return { ok: false, conflict: { current: s('current'), at: s('at'), by: s('by') } };
    }
    log.warn('board', 'kanban card save failed', { taskId: ownerId, cardTaskId: taskId, error: boardErrorMessage(r.err) });
    if (e.code === 'lane_not_found') d.current.reloadKanban();
    return { ok: false, error: boardErrorMessage(r.err) };
  }, [run, base, ownerId]);

  const setPhase = useCallback(async (taskId: string, phase: string, why: string): Promise<boolean> => {
    const r = await run(`phase:${taskId}`, { tasks: { [taskId]: { phase, completed_at: phase === 'COMPLETE' ? new Date().toISOString() : null } } },
      () => apiPatch(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { phase }));
    if (!r.ok) {
      log.warn('board', 'kanban task phase failed', { taskId: ownerId, cardTaskId: taskId, phase, why, error: boardErrorMessage(r.err) });
      toastError(`Couldn't change ${quote(titleOf(taskId))}: ${boardErrorMessage(r.err)}`);
      return false;
    }
    log.info('board', 'kanban task phase set', { taskId: ownerId, cardTaskId: taskId, phase, why });
    d.current.onHumanPhase?.(taskId);
    return true;
  }, [run, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const completeTask = useCallback(async (taskId: string): Promise<boolean> => {
    const vm = d.current.getVM();
    const card = vm?.cards[taskId];
    const before = d.current.storePhase(taskId) ?? 'IN_PROGRESS';
    const undoLane = card ? { lane: card.lane, index: vm?.lanes.find((l) => l.lane.id === card.lane)?.cardIds.indexOf(taskId) ?? 0, source: card.source } : null;
    const title = card?.title ?? taskId;
    const r = await run(`phase:${taskId}`, { tasks: { [taskId]: { phase: 'COMPLETE', completed_at: new Date().toISOString() } } },
      () => apiPost(`/api/v1/tasks/${encodeURIComponent(taskId)}/complete`, {}, { quietStatuses: [409] }));
    if (!r.ok) {
      const e = errorOf(r.err);
      log.warn('board', 'kanban task complete failed', { taskId: ownerId, cardTaskId: taskId, error: boardErrorMessage(r.err) });
      if (e.status === 409 && typeof e.body.active_count === 'number') {
        const n = e.body.active_count as number;
        toastError(`Can't complete ${quote(title)}: ${n} open ${n === 1 ? 'subtask' : 'subtasks'}`,
          [{ label: 'Open', testId: 'kanban-toast-open', run: () => d.current.onOpenTask(taskId) }]);
      } else {
        toastError(`Couldn't complete ${quote(title)}: ${boardErrorMessage(r.err)}`);
      }
      return false;
    }
    log.info('board', 'kanban task completed', { taskId: ownerId, cardTaskId: taskId });
    d.current.onHumanPhase?.(taskId);
    d.current.toasts.push({
      text: `Completed ${quote(title)}`,
      actions: [
        { label: 'Undo', testId: 'kanban-toast-undo', run: async () => {
          if (!(await setPhase(taskId, before, 'undo'))) return;
          if (!undoLane) return;
          const now = d.current.getVM()?.cards[taskId];
          if (undoLane.source === 'explicit') {
            if (now && now.lane !== undoLane.lane) await moveCard(taskId, undoLane.lane, { index: undoLane.index, reason: 'undo' });
            return;
          }
          // The complete recorded the done lane as the card's sticky auto lane (4.2). Only a phase
          // back to IN_PROGRESS or WAITING moves it again, and only to the first lane of that kind;
          // anything else would leave the card in done, so it goes back to its lane and place.
          const lanes = d.current.getVM()?.lanes.map((l) => l.lane) ?? [];
          const kind = autoLaneKind({ type: 'phase', from: 'COMPLETE', to: before });
          if (kind && firstLaneOfKind(lanes, kind)?.id === undoLane.lane) return;
          // Never rank-only: the view may not hold the done lane yet, and the lane must be written.
          await moveCard(taskId, undoLane.lane, { index: undoLane.index, reason: 'undo', rankOnly: false });
        } },
        { label: 'Show', testId: 'kanban-toast-show', run: () => d.current.onReveal(taskId) },
      ],
    });
    return true;
  }, [run, ownerId, setPhase, moveCard]);

  const reopenTask = useCallback((taskId: string) => setPhase(taskId, 'IN_PROGRESS', 'reopen'), [setPhase]);

  const saveLanes = useCallback(async (next: BoardLane[]): Promise<boolean> => {
    const lanes = next.map((l) => ({ ...(l.id ? { id: l.id } : {}), name: l.name, kind: l.kind, ...(l.complete_on_drop ? { complete_on_drop: true } : {}) }));
    const r = await run(LANES_KEY, { lanes: next }, () => apiPut(`${base}/lanes`, { lanes }));
    if (!r.ok) {
      log.warn('board', 'kanban lanes save failed', { taskId: ownerId, error: boardErrorMessage(r.err) });
      toastError(`Couldn't save the lanes: ${boardErrorMessage(r.err)}`);
      return false;
    }
    log.info('board', 'kanban lanes saved', { taskId: ownerId, lanes: next.length });
    return true;
  }, [run, base, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const answerSuggestion = useCallback(async (taskId: string, action: 'accept' | 'dismiss'): Promise<boolean> => {
    const card = d.current.getVM()?.cards[taskId];
    const sug = card?.suggestion;
    const patch = action === 'accept' && sug
      ? { lane: sug.lane, lane_by: 'human', lane_at: new Date().toISOString(), lane_suggested: undefined }
      : { lane_suggested: undefined };
    const r = await run(taskId, { cards: { [taskId]: patch } },
      () => apiPost(`${base}/cards/${encodeURIComponent(taskId)}/suggestion`, { action }));
    if (!r.ok) {
      toastError(`Couldn't ${action} the suggestion for ${quote(card?.title ?? taskId)}: ${boardErrorMessage(r.err)}`);
      return false;
    }
    log.info('board', 'kanban suggestion answered', { taskId: ownerId, cardTaskId: taskId, action, lane: sug?.lane ?? '' });
    return true;
  }, [run, base, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTask = useCallback(async (laneId: string, title: string, tags: string[]) => {
    const key = `add-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setPending((cur) => [...cur, { key, laneId, title }]);
    const started = Date.now();
    try {
      const res = await withTimeout(apiPost<{ task: { id: string; title?: string }; warning?: string }>(
        `${base}/cards`, { title, lane: laneId, ...(tags.length ? { tags } : {}) }));
      const id = res.task.id;
      setPending((cur) => cur.map((p) => (p.key === key ? { ...p, taskId: id } : p)));
      log.info('board', 'kanban task added', { taskId: ownerId, cardTaskId: id, lane: laneId, ms: Date.now() - started, tags: tags.length });
      if (res.warning === 'placement_failed') {
        const lanes = d.current.getVM()?.lanes ?? [];
        const todo = lanes.find((l) => l.lane.kind === 'todo')?.lane.name ?? lanes[0]?.lane.name ?? '';
        toastError(`Added ${quote(res.task.title || title)} to ${todo}. Couldn't place it in ${laneNameOf(laneId)}.`);
      }
      d.current.reloadKanban();
      return { ok: true as const, taskId: id };
    } catch (err) {
      setPending((cur) => cur.filter((p) => p.key !== key));
      if (errorOf(err).status === 501) setNotImplemented(true);
      log.warn('board', 'kanban task add failed', { taskId: ownerId, lane: laneId, error: boardErrorMessage(err) });
      return { ok: false as const, error: boardErrorMessage(err) };
    }
  }, [base, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The toasts a successful move earns (G7, G14, G16). */
  function afterMove(m: {
    taskId: string; title: string; laneId: string; laneName: string; doneLane: boolean; completeOnDrop: boolean; isComplete: boolean;
    fromDone: boolean; fromWait: boolean; reason: string; undo: { lane: string; index: number; source: 'explicit' | 'auto' };
  }): void {
    const t = d.current.toasts;
    const clearWaiting: KanbanToastAction[] = m.fromWait
      ? [{ label: 'Clear waiting on', testId: 'kanban-toast-clear-waiting', run: () => { void setCard(m.taskId, { waiting_on: '' }); } }]
      : [];
    if (m.doneLane && !m.isComplete) {
      if (m.completeOnDrop) { void completeTask(m.taskId); return; }
      t.push({
        text: `Moved to ${m.laneName}. The task is still open.`,
        actions: [
          { label: 'Complete task', testId: 'kanban-toast-complete', run: () => { void completeTask(m.taskId); } },
          { label: 'Always do this', testId: 'kanban-toast-always', run: async () => {
            const lanes = (d.current.getVM()?.lanes ?? []).map((l) => (l.lane.id === m.laneId ? { ...l.lane, complete_on_drop: true } : l.lane));
            if (await saveLanes(lanes)) await completeTask(m.taskId);
          } },
          ...clearWaiting,
        ],
      });
      return;
    }
    if (m.fromDone && m.isComplete) {
      t.push({
        text: `Moved to ${m.laneName}. The task stays complete.`,
        actions: [{ label: 'Reopen task', testId: 'kanban-toast-reopen', run: () => { void reopenTask(m.taskId); } }, ...clearWaiting],
      });
      return;
    }
    if (m.reason === 'drag' && clearWaiting.length === 0) return;
    const undo = m.undo;
    t.push({
      text: `Moved ${quote(m.title)} to ${m.laneName}`,
      actions: [
        { label: 'Undo', testId: 'kanban-toast-undo', run: async () => {
          if (undo.source === 'auto') await setCard(m.taskId, { lane: '' });
          else await moveCard(m.taskId, undo.lane, { index: Math.max(0, undo.index), reason: 'undo' });
        } },
        { label: 'Show', testId: 'kanban-toast-show', run: () => d.current.onReveal(m.taskId) },
        ...clearWaiting,
      ],
    });
  }

  const api = useMemo<KanbanWriteApi>(() => ({
    readOnly, saveLanes, moveCard, setCard, addTask, completeTask, reopenTask, answerSuggestion,
  }), [readOnly, saveLanes, moveCard, setCard, addTask, completeTask, reopenTask, answerSuggestion]);

  return { api, overlays, pending, readOnly };
}

