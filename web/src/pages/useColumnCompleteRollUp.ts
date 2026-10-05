// Completing a task from its session column's header closes that column: it rolls up into
// its header, then leaves through the sessions area's ordinary removal. A person who shut it
// and wanted to look again (or who clicked by mistake) has an Undo for as long as the toast
// lives: it puts the task's phase and the column back where they were.
//
// Only a completion made IN the column counts. Completing from the board, or an agent
// finishing its own task, closes nothing: the person may be reading that column.

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Task } from '@open-walnut/core';
import type { SessionSlot } from './sessionColumns';
import { realColumnCount, restoreSessionColumn } from './sessionColumns';
import { prefersReducedMotion, rollUpColumn, ROLL_UP_TICK_MS, type RollUp } from '@/utils/column-roll-up';

/** How long a close is still answerable by the server's refusal: the Undo toast's life. A
 *  write that fails is retried with backoff and then the list is re-read, which lands well
 *  after the roll-up is over. */
const REFUSAL_WATCH_MS = 8000;

interface Entry {
  taskId: string;
  from: string;
  slot: SessionSlot;
  index: number;
  toastId: string;
  timer?: ReturnType<typeof setTimeout>;
  roll?: RollUp;
  announced: boolean;
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

const columnEl = (sessionId: string) =>
  document.querySelector<HTMLElement>(`.main-page-session-column[data-column-id="${CSS.escape(sessionId)}"]`);

export interface ColumnCompleteRollUp {
  /** A task was completed from the header of the column showing `sessionId`. */
  onTaskCompleted: (sessionId: string, info: { taskId: string; from: string }) => void;
  /** The person closed the column themselves (×): drop any roll-up in flight; the Undo stays. */
  release: (sessionId: string) => void;
}

export function useColumnCompleteRollUp(deps: Deps): ColumnCompleteRollUp {
  const { sessionColumns, tasks } = deps;
  const latest = useRef(deps);
  latest.current = deps;
  const entries = useRef(new Map<string, Entry>());
  /** Columns this hook closed within the refusal window, keyed by session id. */
  const closed = useRef(new Map<string, { entry: Entry; timer: ReturnType<typeof setTimeout> }>());

  /** The task is in the list AND no longer COMPLETE: refused by the server, or reopened.
   *  A task the list does not carry (completed rows can be left out of a refetch) is
   *  unknown, never "reopened". */
  const reopened = (taskId: string) => {
    const phase = latest.current.tasks.find((t) => t.id === taskId)?.phase;
    return phase !== undefined && phase !== 'COMPLETE';
  };

  /** Stop the roll-up and hand the column back as it was. */
  const abort = useCallback((sessionId: string, entry: Entry, dismiss: boolean) => {
    if (entries.current.get(sessionId) === entry) entries.current.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.roll?.cancel();
    if (dismiss && entry.announced) latest.current.dismissToast(entry.toastId);
  }, []);

  /** The column is going away for another reason (×, eviction): stop the roll where it is and
   *  leave the clip on the node, so the removal fades the strip instead of the whole column. */
  const release = useCallback((sessionId: string) => {
    const entry = entries.current.get(sessionId);
    if (!entry) return;
    entries.current.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.roll?.freeze();
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
    if (index < 0 || entries.current.has(sessionId)) return;
    const slot = d.sessionColumns[index];
    if (slot.locked) return; // a pin means "keep this panel"
    const entry: Entry = {
      taskId: info.taskId,
      from: info.from,
      slot,
      index,
      toastId: `column-done:${info.taskId}`,
      announced: false,
    };
    entries.current.set(sessionId, entry);
    const reduced = prefersReducedMotion();

    const undo = () => {
      const live = entries.current.get(sessionId);
      if (live === entry) abort(sessionId, entry, false);
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

    const leave = () => {
      if (entries.current.get(sessionId) !== entry) return;
      // Refused or reopened while the column rolled: it stays. So does a column pinned in the
      // meantime (the header strip is still there to click).
      const pinned = latest.current.sessionColumns.find((c) => c.id === sessionId)?.locked;
      if (pinned || reopened(entry.taskId)) { abort(sessionId, entry, true); return; }
      entries.current.delete(sessionId);
      watchAfterClose();
      latest.current.closeColumn(sessionId);
    };

    const begin = () => {
      entry.timer = undefined;
      if (entries.current.get(sessionId) !== entry) return;
      // The tick had its moment; a server that refused in that time has rolled the phase back.
      if (reopened(entry.taskId)) { entries.current.delete(sessionId); return; }
      const title = latest.current.tasks.find((t) => t.id === entry.taskId)?.title;
      entry.announced = true;
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
      const col = reduced ? null : columnEl(sessionId);
      const roll = col ? rollUpColumn(col) : null;
      if (!roll) { leave(); return; }
      entry.roll = roll;
      void roll.finished.then((reached) => { if (reached) leave(); });
    };

    // Reduced motion skips the roll, not the tick: the tick is also the window in which a
    // server that refused has already rolled the phase back.
    entry.timer = setTimeout(begin, ROLL_UP_TICK_MS);
  }, [abort, restoreColumn]);

  // A roll-up outlives neither a reopened/refused task, a pin, nor a column that something
  // else closed; and a refusal that lands after the column went gives the column back.
  useEffect(() => {
    if (entries.current.size === 0 && closed.current.size === 0) return;
    for (const [sessionId, entry] of [...entries.current]) {
      const slot = sessionColumns.find((c) => c.id === sessionId);
      if (!slot) { release(sessionId); continue; }
      if (slot.locked || (entry.roll && reopened(entry.taskId))) abort(sessionId, entry, true);
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
    for (const entry of entries.current.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.roll?.cancel();
    }
    entries.current.clear();
    for (const watch of closed.current.values()) clearTimeout(watch.timer);
    closed.current.clear();
  }, []);

  return { onTaskCompleted, release };
}
