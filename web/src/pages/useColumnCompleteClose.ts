// Completing a task from its session column's header closes that column, the ordinary way
// (the sessions area's own removal fades it and the neighbours take the width). A person who
// shut it and wanted to look again (or who clicked by mistake) has an Undo for as long as the
// toast lives: it puts the task's phase and the column back where they were.
//
// Only a completion made IN the column counts. Completing from the board, or an agent
// finishing its own task, closes nothing: the person may be reading that column.

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Task } from '@open-walnut/core';
import type { SessionSlot } from './sessionColumns';
import { realColumnCount, restoreSessionColumn } from './sessionColumns';

/** The ring's tick is read before the column goes (also the window in which a refused
 *  completion rolls back, so a quick refusal never costs the person a column). */
const CLOSE_TICK_MS = 400;
/** How long a close is still answerable by the server's refusal: the Undo toast's life. A
 *  write that fails is retried with backoff and then the list is re-read, which lands well
 *  after the column is gone. */
const REFUSAL_WATCH_MS = 8000;

interface Entry {
  taskId: string;
  from: string;
  slot: SessionSlot;
  index: number;
  toastId: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface Deps {
  sessionColumns: SessionSlot[];
  setSessionColumns: Dispatch<SetStateAction<SessionSlot[]>>;
  tasks: Task[];
  setPhase: (id: string, phase: string) => void;
  /** The ordinary close (focus hand-back included). */
  closeColumn: (sessionId: string) => void;
  /** The ordinary open: used when the strip has no room left for the Undo, so the budget
   *  rules (and the lock grant that makes the panel count follow) decide. */
  openSession: (sessionId: string) => void;
  notify: (n: {
    kind: 'hint'; severity: 'success'; title: string; body?: string; id: string; dedupKey: string;
    persistent: false; action: { label: string; kind: 'callback' }; onAction: () => void;
  }) => void;
  dismissToast: (id: string) => void;
  triageOpenRef: { current: boolean };
  maxPanelsRef: { current: number };
}

export interface ColumnCompleteClose {
  /** A task was completed from the header of the column showing `sessionId`. */
  onTaskCompleted: (sessionId: string, info: { taskId: string; from: string }) => void;
  /** The person closed the column themselves (×) before the tick ended: nothing left to do. */
  release: (sessionId: string) => void;
}

export function useColumnCompleteClose(deps: Deps): ColumnCompleteClose {
  const { sessionColumns, tasks } = deps;
  const latest = useRef(deps);
  latest.current = deps;
  const pending = useRef(new Map<string, Entry>());
  /** Columns this hook closed within the refusal window, keyed by session id. */
  const closed = useRef(new Map<string, { entry: Entry; timer: ReturnType<typeof setTimeout> }>());

  /** The task is in the list AND no longer COMPLETE: refused by the server, or reopened.
   *  A task the list does not carry (completed rows can be left out of a refetch) is
   *  unknown, never "reopened". */
  const reopened = (taskId: string) => {
    const phase = latest.current.tasks.find((t) => t.id === taskId)?.phase;
    return phase !== undefined && phase !== 'COMPLETE';
  };

  const release = useCallback((sessionId: string) => {
    const entry = pending.current.get(sessionId);
    if (!entry) return;
    pending.current.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
  }, []);

  /** Put the column back: where it sat when there is room, otherwise as a normal open. */
  const restoreColumn = useCallback((entry: Entry) => {
    const u = latest.current;
    if (u.sessionColumns.some((c) => c.id === entry.slot.id)) return;
    const count = u.triageOpenRef.current ? u.maxPanelsRef.current - 1 : u.maxPanelsRef.current;
    if (realColumnCount(u.sessionColumns) >= count) { u.openSession(entry.slot.id); return; }
    u.setSessionColumns((prev) => restoreSessionColumn(prev, entry.slot, entry.index, u.triageOpenRef.current, u.maxPanelsRef.current));
  }, []);

  const onTaskCompleted = useCallback((sessionId: string, info: { taskId: string; from: string }) => {
    const d = latest.current;
    const index = d.sessionColumns.findIndex((c) => c.id === sessionId);
    if (index < 0 || pending.current.has(sessionId)) return;
    const slot = d.sessionColumns[index];
    if (slot.locked) return; // a pin means "keep this panel"
    const entry: Entry = {
      taskId: info.taskId,
      from: info.from,
      slot,
      index,
      toastId: `column-done:${info.taskId}`,
    };
    pending.current.set(sessionId, entry);

    const undo = () => {
      const watch = closed.current.get(sessionId);
      if (watch?.entry === entry) { clearTimeout(watch.timer); closed.current.delete(sessionId); }
      if (!reopened(entry.taskId)) latest.current.setPhase(entry.taskId, entry.from);
      restoreColumn(entry);
    };

    const watchAfterClose = () => {
      const prior = closed.current.get(sessionId);
      if (prior) clearTimeout(prior.timer);
      const watch = {
        entry,
        timer: setTimeout(() => { if (closed.current.get(sessionId) === watch) closed.current.delete(sessionId); }, REFUSAL_WATCH_MS),
      };
      closed.current.set(sessionId, watch);
    };

    const begin = () => {
      entry.timer = undefined;
      if (pending.current.get(sessionId) !== entry) return;
      pending.current.delete(sessionId);
      // Refused or reopened during the tick, or pinned in the meantime: the column stays.
      const pinned = latest.current.sessionColumns.find((c) => c.id === sessionId)?.locked;
      if (pinned || reopened(entry.taskId)) return;
      const title = latest.current.tasks.find((t) => t.id === entry.taskId)?.title;
      watchAfterClose();
      latest.current.notify({
        kind: 'hint',
        severity: 'success',
        title: 'Task completed',
        ...(title ? { body: title } : {}),
        id: entry.toastId,
        dedupKey: entry.toastId,
        persistent: false,
        action: { label: 'Undo', kind: 'callback' },
        onAction: undo,
      });
      latest.current.closeColumn(sessionId);
    };

    entry.timer = setTimeout(begin, CLOSE_TICK_MS);
  }, [restoreColumn]);

  // A pending close outlives neither a reopened task, a pin, nor a column that something else
  // closed; and a refusal that lands after the column went gives the column back.
  useEffect(() => {
    if (pending.current.size === 0 && closed.current.size === 0) return;
    for (const [sessionId, entry] of [...pending.current]) {
      const slot = sessionColumns.find((c) => c.id === sessionId);
      if (!slot || slot.locked || reopened(entry.taskId)) release(sessionId);
    }
    for (const [sessionId, watch] of [...closed.current]) {
      if (!reopened(watch.entry.taskId)) continue;
      clearTimeout(watch.timer);
      closed.current.delete(sessionId);
      latest.current.dismissToast(watch.entry.toastId);
      restoreColumn(watch.entry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, sessionColumns]);

  useEffect(() => () => {
    for (const entry of pending.current.values()) if (entry.timer) clearTimeout(entry.timer);
    pending.current.clear();
    for (const watch of closed.current.values()) clearTimeout(watch.timer);
    closed.current.clear();
  }, []);

  return { onTaskCompleted, release };
}
