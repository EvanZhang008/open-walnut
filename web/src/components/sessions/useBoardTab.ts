/**
 * The Board tab's presence for a session's task (board-tab-model.ts has the
 * rule). One small read per task (GET /tasks/:id/board/owner?tab=1), kept for
 * the page's life so going back to a session never flashes its tab.
 *
 * The cache is watched by ONE module-level subscription, mounted panel or not:
 * a `board:changed` for a cached task, a task event naming one as its parent,
 * or a reconnect marks the answer stale. A stale answer counts as not known
 * (the panel keeps what it showed) and is read again as soon as a panel needs
 * it, so a Board written while a lead still had open subtasks is known by the
 * time its last subtask finishes (review, 2026-10-26).
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { wsClient } from '@/api/ws';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { openSubtasksOf } from '@/components/tasks/subtask-index';
import { log } from '@/utils/log';
import { boardTabState, type BoardOwnerFacts, type BoardTabState } from './board-tab-model';

const known = new Map<string, BoardOwnerFacts>();
/** Answers an event may have changed, by a counter bumped on every such event. */
const staleGen = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

function isStale(taskId: string): boolean {
  return (staleGen.get(taskId) ?? 0) > 0;
}

function markStale(taskId: string): void {
  if (!known.has(taskId)) return;
  staleGen.set(taskId, (staleGen.get(taskId) ?? 0) + 1);
  notify();
}

let subscribed = false;
function subscribeOnce(): void {
  if (subscribed) return;
  subscribed = true;
  wsClient.onEvent('board:changed', (data) => {
    const id = (data as { taskId?: string } | null)?.taskId;
    if (id) markStale(id);
  });
  const onTask = (data: unknown) => {
    const parent = (data as { task?: { parent_task_id?: string | null } } | null)?.task?.parent_task_id;
    if (!parent) return;
    for (const id of known.keys()) if (id === parent || id.startsWith(parent)) markStale(id);
  };
  wsClient.onEvent('task:created', onTask);
  wsClient.onEvent('task:updated', onTask);
  wsClient.onEvent('task:deleted', onTask);
  wsClient.onEvent('_ws:reconnected', () => { for (const id of known.keys()) markStale(id); });
}

function readOwner(taskId: string): Promise<void> {
  const running = inFlight.get(taskId);
  if (running) return running;
  const p = (async () => {
    // An event that lands while the read is out makes it read again (at most twice more).
    for (let round = 0; round < 3; round++) {
      const gen = staleGen.get(taskId) ?? 0;
      try {
        const res = await apiGet<BoardOwnerFacts>(
          `/api/v1/tasks/${encodeURIComponent(taskId)}/board/owner?tab=1`, undefined, { quietStatuses: [404] },
        );
        known.set(taskId, { own_board: !!res.own_board, open_subtasks: res.open_subtasks ?? 0 });
      } catch (err) {
        log.warn('session-panel', 'board tab owner read failed', { taskId, error: err instanceof Error ? err.message : String(err) });
        // Keep an earlier answer; with none, hide the tab (the safe side for a plain task)
        // and leave it stale, so the next panel that needs it asks again.
        if (!known.has(taskId)) { known.set(taskId, { own_board: false, open_subtasks: 0 }); staleGen.set(taskId, 1); }
        return;
      }
      if ((staleGen.get(taskId) ?? 0) === gen) { staleGen.delete(taskId); return; }
    }
  })().finally(() => {
    inFlight.delete(taskId);
    notify();
  });
  inFlight.set(taskId, p);
  return p;
}

/** For tests: forget every answer. */
export function _resetBoardTabCache(): void {
  known.clear();
  staleGen.clear();
  inFlight.clear();
}

export function useBoardTab(taskId: string | null | undefined): BoardTabState {
  const [, bump] = useState(0);
  const store = useTasksContextSafe();
  // A store still on its first fetch, or one whose first fetch failed, knows
  // nothing: the server's count stands in.
  const storeKnows = !!store && !(store.tasks.length === 0 && (store.loading || !!store.error));
  const storeOpen = storeKnows ? (taskId ? openSubtasksOf(store!.tasks, taskId).length : 0) : null;
  useEffect(() => {
    subscribeOnce();
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  // Leading now needs no read; ask only when the store cannot already say "shown".
  const needRead = !!taskId && !(storeOpen != null && storeOpen > 0);
  const stale = !!taskId && isStale(taskId);
  useEffect(() => {
    if (needRead && taskId && (!known.has(taskId) || isStale(taskId))) void readOwner(taskId);
  }, [needRead, taskId, stale]);
  const owner = taskId && !isStale(taskId) ? known.get(taskId) : undefined;
  const state = boardTabState({ taskId, storeOpenSubtasks: storeOpen, owner });
  // While an answer is on its way (a lead whose last open subtask just finished,
  // a Board just written) the tab stays as it was rather than blinking.
  const last = useRef<{ taskId: string | null | undefined; state: BoardTabState }>({ taskId, state });
  if (state !== 'unknown' || last.current.taskId !== taskId) last.current = { taskId, state };
  return last.current.state;
}
