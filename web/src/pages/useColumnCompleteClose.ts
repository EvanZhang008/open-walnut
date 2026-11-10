// Completing a task from its session column's header (or with mod+shift+D) closes that
// column, the ordinary way (the sessions area's own removal fades it and the neighbours take
// the width), and moves on to the next task that needs the person (`advance`, MainPage). A
// person who shut it and wanted to look again (or who clicked by mistake) has an Undo, on the
// toast or mod+z, for the undo window (undo/undo-stack.ts): it puts the task's phase and the
// column back where they were, and closes again the column the advance opened.
//
// A person who moved on during the tick (a jump to another column, a press elsewhere) keeps
// the caret where they went: the next task still opens, it does not take the caret. A completion
// the server refuses after the column went takes the advance back too. The Undo outlives a
// reload inside its window (`column-done`, undo/undo-persist.ts).
//
// Only a completion made IN the column counts. Completing from the board, or an agent
// finishing its own task, closes nothing: the person may be reading that column.

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Task } from '@open-walnut/core';
import type { SessionSlot } from './sessionColumns';
import { realColumnCount, restoreSessionColumn, toggleLockSlot } from './sessionColumns';
import { phaseSnapshot, type PhaseSnapshot, type TaskUndo } from '@/undo/TaskUndoContext';
import { needsYouQueue } from '@/components/tasks/next-needs-you';
import { afterStrip } from './after-strip';
import { endCarry, lastTextBox } from './useHomeKeyboard';
import { CLOSE_TICK_MS } from './hold-strip-animation';
import { UNDO_WINDOW_MS } from '@/undo/undo-stack';

/** How long a close is still answerable by the server's refusal. A write that fails is
 *  retried with backoff and then the list is re-read, which lands well after the column is
 *  gone (longer than the undo window on purpose). */
const REFUSAL_WATCH_MS = 8000;

interface Entry {
  taskId: string;
  from: string;
  /** The title the column knew, for a toast the list cannot name yet. */
  title?: string;
  /** Where the column sat and whether it was pinned, read when it closed (a pin or an unpin
   *  during the tick moves it). */
  slot: SessionSlot;
  index: number;
  undoKey: string;
  /** The Needs you queue (ids) as it was when the task was completed. */
  queueBefore: string[];
  /** The task's phase before, for its Undo. */
  before: PhaseSnapshot;
  /** When it was completed and when its column went (performance.now()). */
  at: number;
  closedAt?: number;
  /** Take the advance back: the column it opened goes again (one it only focused stays) and
   *  this one comes back; `withCaret`: it takes the caret, and the list selects its task. */
  takeBack?: (withCaret: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** What a `column-done` Undo saves for a reload. */
interface SavedColumnDone {
  taskId: string;
  from: string;
  before: PhaseSnapshot;
  slot: SessionSlot;
  index: number;
  opened?: string;
}

/** What the advance did: the task it went to, and the column it opened for it (if any). */
/** The toast's word on where the keys went on to. */
export function nextLine(a: AdvanceResult): string {
  const passed = a.passedOver ? `, skipped ${a.passedOver} with no session` : '';
  return `Next: ${a.task.title}${a.noSession ? ' (no session yet)' : ''}${passed}`;
}

export interface AdvanceResult {
  task: Task;
  openedSessionId?: string;
  /** It has no session: its row in the list has the caret, and nothing opened. */
  noSession?: boolean;
  /** Tasks with no session passed over on the way to it (the keys go on through sessions). */
  passedOver?: number;
  /** Stop an open that has not happened yet (an Undo pressed at once). */
  cancel: () => void;
}

interface Deps {
  sessionColumns: SessionSlot[];
  setSessionColumns: Dispatch<SetStateAction<SessionSlot[]>>;
  tasks: Task[];
  setPhase: (id: string, phase: string) => void;
  /** The ordinary close (focus hand-back included). */
  closeColumn: (sessionId: string, opts?: { keepFocus?: boolean; fade?: boolean }) => void;
  /** The ordinary open: used when the strip has no room left for the Undo, so the budget
   *  rules (and the lock grant that makes the panel count follow) decide. */
  openSession: (sessionId: string) => void;
  undo: TaskUndo | null;
  /** Put the caret back in a column (an Undo returns the person to where they were). */
  focusColumn?: (sessionId: string) => void;
  /** Go to the next task that needs the person; null when there is none. `quiet`: the person
   *  moved on meanwhile, so the next task opens without taking the caret. */
  advance?: (info: { taskId: string; sessionId: string; queueBefore: string[]; quiet?: boolean }) => AdvanceResult | null;
  /** Whether the person moved the caret or pressed somewhere since `at` (performance.now()). */
  movedSince?: (at: number) => boolean;
  /** Select a task in the list (an Undo selects the task it brought back). */
  locateTask?: (taskId: string) => void;
  triageOpenRef: { current: boolean };
  maxPanelsRef: { current: number };
}

export interface ColumnCompleteClose {
  /** A task was completed from the header of the column showing `sessionId`. */
  onTaskCompleted: (sessionId: string, info: { taskId: string; from: string; title?: string }) => void;
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
  /** Columns a revived Undo says were closed, until its window ends (performance.now()). */
  const revivedClose = useRef(new Map<string, { taskId: string; until: number }>());

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
    if (realColumnCount(u.sessionColumns) >= count) {
      u.openSession(entry.slot.id);
      // A pin comes back with its column (the open lands unpinned; a refused open leaves nothing to pin).
      if (entry.slot.locked) {
        u.setSessionColumns((prev) => (prev.some((c) => c.id === entry.slot.id && !c.locked) ? toggleLockSlot(prev, entry.slot.id) : prev));
      }
      return;
    }
    u.setSessionColumns((prev) => restoreSessionColumn(prev, entry.slot, entry.index, u.triageOpenRef.current, u.maxPanelsRef.current));
  }, []);

  /** Put the phase back through the Undo's restore (a NEED_ACTION from the session is not
   *  written back as the person's ask). Only an Undo calls it, and there is none without it. */
  const restorePhase = useCallback((taskId: string, before: PhaseSnapshot) => {
    void latest.current.undo?.restorePhase(taskId, before);
  }, []);

  /** Close a column the advance opened (an unpinned one), then bring the completed column back
   *  and give it the caret once the strip has rendered without both. */
  const bringBack = useCallback((sessionId: string, slot: SessionSlot, index: number, opened: string | undefined, then?: () => void, withCaret = true) => {
    const u = latest.current;
    if (opened && u.sessionColumns.some((c) => c.id === opened && !c.locked)) u.closeColumn(opened, { keepFocus: true });
    const gone = (id: string) => !latest.current.sessionColumns.some((c) => c.id === id);
    afterStrip(() => gone(sessionId) && (!opened || gone(opened) || latest.current.sessionColumns.some((c) => c.id === opened && c.locked)), () => {
      restoreColumn({ slot, index } as Entry);
      if (withCaret) latest.current.focusColumn?.(sessionId);
      then?.();
    });
  }, [restoreColumn]);

  const onTaskCompleted = useCallback((sessionId: string, info: { taskId: string; from: string; title?: string }) => {
    const d = latest.current;
    // A pinned column closes too: completing the task from its own header is the person
    // saying they are done with it, and the Undo brings it back pinned.
    const index = d.sessionColumns.findIndex((c) => c.id === sessionId);
    if (index < 0 || pending.current.has(sessionId)) return;
    const slot = d.sessionColumns[index];
    const row = d.tasks.find((t) => t.id === info.taskId);
    const entry: Entry = {
      taskId: info.taskId,
      from: info.from,
      ...(info.title ? { title: info.title } : {}),
      slot,
      index,
      undoKey: `column-done:${info.taskId}`,
      // Read before the completion reaches the list: the task is still in its old place.
      queueBefore: needsYouQueue(d.tasks).map((t) => t.id),
      before: row ? phaseSnapshot(row) : { phase: info.from as Task['phase'] },
      at: performance.now(),
    };
    pending.current.set(sessionId, entry);
    // A second click on the ring during the tick takes this back to `before`, not to TODO.
    if (row) d.undo?.noteCompleted(row);

    let advanced: AdvanceResult | null = null;
    const undo = () => {
      const watch = closed.current.get(sessionId);
      if (watch?.entry === entry) { clearTimeout(watch.timer); closed.current.delete(sessionId); }
      if (!reopened(entry.taskId)) restorePhase(entry.taskId, entry.before);
      // The column the advance opened goes again, then the completed one comes back and takes
      // the caret (an Undo pressed at once can come before the close itself has rendered).
      advanced?.cancel();
      const went = !!advanced;
      bringBack(sessionId, entry.slot, entry.index, advanced?.openedSessionId, () => {
        // The advance selected the next task: the list follows the task that came back.
        if (went) latest.current.locateTask?.(entry.taskId);
      });
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
      // Refused or reopened during the tick: the column stays, and what was typed meanwhile
      // goes back into its box.
      if (reopened(entry.taskId)) { endCarry(true); return; }
      const cols = latest.current.sessionColumns;
      const at = cols.findIndex((c) => c.id === sessionId);
      if (at < 0) { endCarry(false); return; }
      entry.slot = cols[at];
      entry.index = at;
      // The list's title, else the column's (a click before the board's first list came).
      const title = latest.current.tasks.find((t) => t.id === entry.taskId)?.title ?? entry.title;
      watchAfterClose();
      // The caret goes on with the person, never back to the struck-through row that opened
      // the column: to the next task, else to the column that takes this one's place; and
      // nowhere, when the person already went somewhere else during the tick.
      const quiet = latest.current.movedSince?.(entry.at) ?? false;
      const neighbour = cols[at + 1]?.id ?? cols[at - 1]?.id;
      latest.current.closeColumn(sessionId, { keepFocus: true, fade: true });
      entry.closedAt = performance.now();
      advanced = latest.current.advance?.({ taskId: entry.taskId, sessionId, queueBefore: entry.queueBefore, quiet }) ?? null;
      // The person typing in another column (and clicking this one's checkbox, which may take
      // the caret) stays there: the caret goes back to that box, not to a neighbour.
      const colOf = (el: Element | null | undefined) => el?.closest?.('.main-page-session-column[data-column-id]')?.getAttribute('data-column-id') ?? null;
      const active = typeof document === 'undefined' ? null : document.activeElement;
      const typing = lastTextBox();
      const typingCol = colOf(typing);
      const caretCol = colOf(active);
      const typingElsewhere = !!typing && !!typingCol && typingCol !== sessionId
        && (active === typing || !caretCol || caretCol === sessionId);
      if (!advanced && typingElsewhere && !quiet) {
        if (document.activeElement !== typing) typing!.focus({ preventScroll: true });
      } else if (!advanced && neighbour && !quiet && !(caretCol && caretCol !== sessionId)) {
        afterStrip(() => !latest.current.sessionColumns.some((c) => c.id === sessionId), () => latest.current.focusColumn?.(neighbour));
      } else if (!advanced || advanced.noSession) {
        // No box takes the caret next: the keys are the person's again at once.
        endCarry(false);
      }
      const opened = advanced?.openedSessionId;
      entry.takeBack = (withCaret) => {
        advanced?.cancel();
        bringBack(sessionId, entry.slot, entry.index, opened, () => {
          if (withCaret && advanced) latest.current.locateTask?.(entry.taskId);
        }, withCaret);
      };
      const next = advanced ? nextLine(advanced) : '';
      const body = [title, next].filter(Boolean).join('  \u00b7  ');
      const saved: SavedColumnDone = { taskId: entry.taskId, from: entry.from, before: entry.before, slot: entry.slot, index: entry.index, ...(opened ? { opened } : {}) };
      latest.current.undo?.push({
        key: entry.undoKey,
        title: 'Task completed',
        ...(body ? { body } : {}),
        undo,
        revive: { kind: 'column-done', data: saved },
      });
    };

    entry.timer = setTimeout(begin, CLOSE_TICK_MS);
  }, [restorePhase, bringBack]);

  // A pending close outlives neither a reopened task nor a column that something else closed;
  // and a refusal that lands after the column went gives the column back.
  useEffect(() => {
    if (pending.current.size === 0 && closed.current.size === 0 && revivedClose.current.size === 0) return;
    for (const [sessionId, entry] of [...pending.current]) {
      const slot = sessionColumns.find((c) => c.id === sessionId);
      // Refused or reopened during the tick: what was typed meanwhile goes back into its box.
      if (slot && reopened(entry.taskId)) { release(sessionId); endCarry(true); }
      else if (!slot) release(sessionId);
    }
    for (const [sessionId, watch] of [...closed.current]) {
      if (!reopened(watch.entry.taskId)) continue;
      clearTimeout(watch.timer);
      closed.current.delete(sessionId);
      latest.current.undo?.drop(watch.entry.undoKey);
      // Refused: the column comes back, and the advance made for it is taken back with it, the
      // caret too. A person who moved on since the column went (a jump, a press, typing in the
      // next task's box) keeps what they are in: only the column comes back.
      const entry = watch.entry;
      const movedOn = latest.current.movedSince?.(entry.closedAt ?? entry.at) ?? false;
      if (entry.takeBack && !movedOn) entry.takeBack(true); else restoreColumn(entry);
      entry.takeBack = undefined;
    }
    // A column a revived Undo says was closed, back from the address bar (the reload came
    // before the close reached it): it goes, as it would have.
    // Decided once, on the first strip the page shows: a column the person opens again later
    // is theirs.
    for (const [sessionId, want] of [...revivedClose.current]) {
      if (performance.now() > want.until) { revivedClose.current.delete(sessionId); continue; }
      if (sessionColumns.length === 0) continue;
      revivedClose.current.delete(sessionId);
      const t = latest.current.tasks.find((x) => x.id === want.taskId);
      if (sessionColumns.some((c) => c.id === sessionId) && (!t || t.phase === 'COMPLETE')) latest.current.closeColumn(sessionId, { keepFocus: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, sessionColumns]);

  // After a reload inside the window: the Undo puts the task and its column back as before.
  const undoApi = deps.undo;
  useEffect(() => {
    if (!undoApi) return;
    return undoApi.registerReviver('column-done', (data) => {
      const d = data as Partial<SavedColumnDone> | null;
      if (!d?.taskId || !d.slot?.id || !d.before || typeof d.index !== 'number') return null;
      const saved = d as SavedColumnDone;
      const sessionId = saved.slot.id;
      revivedClose.current.set(sessionId, { taskId: saved.taskId, until: performance.now() + UNDO_WINDOW_MS });
      return {
        undo: () => {
          revivedClose.current.delete(sessionId);
          const t = latest.current.tasks.find((x) => x.id === saved.taskId);
          if (!t || t.phase === 'COMPLETE') restorePhase(saved.taskId, saved.before);
          if (latest.current.sessionColumns.some((c) => c.id === sessionId)) {
            latest.current.focusColumn?.(sessionId);
            latest.current.locateTask?.(saved.taskId);
            return;
          }
          bringBack(sessionId, saved.slot, saved.index, saved.opened, () => latest.current.locateTask?.(saved.taskId));
        },
      };
    });
  }, [undoApi, restorePhase, bringBack]);

  useEffect(() => () => {
    for (const entry of pending.current.values()) if (entry.timer) clearTimeout(entry.timer);
    pending.current.clear();
    for (const watch of closed.current.values()) clearTimeout(watch.timer);
    closed.current.clear();
  }, []);

  return { onTaskCompleted, release };
}
