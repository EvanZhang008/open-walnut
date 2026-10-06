/**
 * The Board pane's data: `GET /api/v1/tasks/:id/board?team=1`, kept current by
 * the `board:changed` WS event (debounced, coalesced) and re-read on reconnect.
 *
 * `?team=1` answers with the TEAM's board: a worker and its leader share one, so
 * the payload names its owner (`board_task_id`), and every write goes there.
 * The owner's events, the task's own and its ancestors' (`watchIds`) all reload.
 *
 * Every load carries a sequence number; a response older than the newest
 * request is dropped, so a slow read can never put back state a newer one (or
 * a local merge) already moved past. A local merge (the user's own post,
 * delete, note, status pick, tick, answer, reminder or seen section) invalidates reads in
 * flight and schedules a fresh one, so the merged row is never flickered away
 * by a read that started before it existed.
 *
 * Kanban writes (`board:changed` kind card or lanes, or a kanban seen write)
 * re-read only the kanban fields (`fields=kanban`, no html) and merge them in,
 * one such read in flight at a time (board-kanban-reload.ts). `fetchStartedAt`
 * is when the read whose kanban part is on screen started (G32 overlays).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import {
  mergeBoardMessage, type BoardCheck, type BoardChoice, type BoardMark, type BoardMessage, type BoardPayload,
  type BoardProject, type BoardReminder, type BoardSectionSeen,
} from './board-model';
import { dropDueReminder, recordOf, setEntry } from './board-items-model';
import {
  applyFullPayload, applyKanbanFields, createKanbanReloader, isKanbanReloadEvent, normalizeKanbanFields,
  type KanbanReloader,
} from './board-kanban-reload';

const RELOAD_DEBOUNCE_MS = 150;

export function boardPath(taskId: string): string {
  return `/api/v1/tasks/${encodeURIComponent(taskId)}/board`;
}

/** A failed board request in one short sentence (v1 errors are `{ error: { code, message } }`). */
export function boardErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: { message?: unknown } | string } | undefined;
    const inner = typeof body?.error === 'object' && typeof body.error?.message === 'string'
      ? body.error.message
      : typeof body?.error === 'string' ? body.error : '';
    if (err.status === 404) return inner || 'This task was not found';
    return inner || `Request failed (${err.status})`;
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'Walnut did not answer in time';
  if (err instanceof TypeError) return 'Could not reach Walnut';
  return err instanceof Error && err.message ? err.message : String(err);
}

export function normalizeBoardPayload(data: BoardPayload): BoardPayload {
  const out: BoardPayload = {
    ...normalizeKanbanFields(data),
    board: data?.board ?? null,
    threads: recordOf<BoardMessage[]>(data?.threads),
    marks: recordOf<BoardMark>(data?.marks),
    refs: Array.isArray(data?.refs) ? data.refs : [],
    projects: recordOf(data?.projects),
    checks: recordOf<BoardCheck>(data?.checks),
    choices: recordOf<BoardChoice>(data?.choices),
    reminders: recordOf<BoardReminder>(data?.reminders),
    section_seen: recordOf<BoardSectionSeen>(data?.section_seen),
  };
  if (typeof data?.board_task_id === 'string' && data.board_task_id) out.board_task_id = data.board_task_id;
  if (typeof data?.board_task_title === 'string') out.board_task_title = data.board_task_title;
  return out;
}

export interface TaskBoardData {
  payload: BoardPayload | null;
  /** True until the first answer (or failure) for this task. */
  loading: boolean;
  error: string | null;
  reload: () => void;
  mergeMessage: (thread: string, message: BoardMessage) => void;
  /** The user's delete, answered by its route: the message leaves (an emptied thread goes too). */
  dropMessage: (thread: string, messageId: string) => void;
  mergeMark: (markId: string, mark: BoardMark | null) => void;
  mergeProject: (projectId: string, project: BoardProject | null) => void;
  mergeCheck: (checkId: string, check: BoardCheck | null) => void;
  mergeChoice: (choiceId: string, choice: BoardChoice | null) => void;
  mergeReminder: (target: string, reminder: BoardReminder | null) => void;
  mergeSectionSeen: (sectionId: string, seen: BoardSectionSeen) => void;
  /** Epoch ms the read whose kanban part is on screen started (0 before the first answer). */
  fetchStartedAt: number;
  /** Re-read the kanban fields now (single flight, coalesced). */
  reloadKanban: () => void;
}

export function useTaskBoard(taskId: string, watchIds: readonly string[] = []): TaskBoardData {
  const [payload, setPayload] = useState<BoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const [fetchStartedAt, setFetchStartedAt] = useState(0);
  const payloadRef = useRef<BoardPayload | null>(null);
  const kanbanAt = useRef(0);
  const reloader = useRef<KanbanReloader | null>(null);
  const commit = useCallback((next: BoardPayload | null, startedAt: number) => {
    payloadRef.current = next;
    kanbanAt.current = startedAt;
    setPayload(next);
    setFetchStartedAt(startedAt);
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watch = useRef<ReadonlySet<string>>(new Set());
  watch.current = new Set([taskId, ...watchIds, ...(payload?.board_task_id ? [payload.board_task_id] : [])]);

  const load = useCallback(async (why: string) => {
    const mine = ++seq.current;
    const startedAt = Date.now();
    try {
      const data = await apiGet<BoardPayload>(boardPath(taskId), { team: '1' }, { quietStatuses: [404] });
      if (mine !== seq.current) return;
      const r = applyFullPayload(payloadRef.current, normalizeBoardPayload(data), startedAt, kanbanAt.current);
      commit(r.payload, r.kanbanStartedAt);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = boardErrorMessage(err);
      log.warn('board', 'board load failed', { taskId, why, error: message });
      setError(message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [taskId, commit]);

  const scheduleLoad = useCallback((why: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void load(why);
    }, RELOAD_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    commit(null, 0);
    setError(null);
    setLoading(true);
    void load('open');
    const r = createKanbanReloader({
      fetch: () => apiGet<unknown>(boardPath(taskId), { team: '1', fields: 'kanban' }, { quietStatuses: [404] }),
      apply: (data, startedAt) => {
        const next = applyKanbanFields(payloadRef.current, normalizeKanbanFields(data), startedAt, kanbanAt.current);
        if (next) commit(next.payload, next.kanbanStartedAt);
      },
      onError: (err, why) => log.warn('board', 'kanban reload failed', { taskId, why, error: boardErrorMessage(err) }),
    });
    reloader.current = r;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      seq.current++; // a read still in flight belongs to the task we left
      r.dispose();
      if (reloader.current === r) reloader.current = null;
    };
  }, [load, commit, taskId]);

  useEvent('board:changed', (data) => {
    const d = data as { taskId?: string; kind?: string; kanban?: boolean } | null;
    if (!d?.taskId || !watch.current.has(d.taskId)) return;
    // Before the first answer there is nothing to merge into: a full read is coming anyway.
    if (isKanbanReloadEvent(d) && payloadRef.current) reloader.current?.request(`ws:${d.kind}`);
    else scheduleLoad(`ws:${d.kind ?? 'change'}`);
  });
  useEvent('_ws:reconnected', () => scheduleLoad('reconnect'));

  /** A local write the route answered: newer than any read in flight, then a fresh read. */
  const merge = useCallback((why: string, next: (p: BoardPayload) => BoardPayload) => {
    seq.current++;
    const p = payloadRef.current;
    if (p) {
      payloadRef.current = next(p);
      setPayload(payloadRef.current);
    }
    scheduleLoad(why);
  }, [scheduleLoad]);

  const mergeMessage = useCallback((thread: string, message: BoardMessage) => {
    merge('after-post', (p) => ({
      ...p,
      threads: mergeBoardMessage(p.threads, thread, message),
      // The user's post clears a due reminder on the thread (the server, in the same write).
      reminders: message.author === 'user' ? dropDueReminder(p.reminders, thread) : p.reminders,
    }));
  }, [merge]);

  const dropMessage = useCallback((thread: string, messageId: string) => {
    merge('after-delete', (p) => {
      const list = p.threads[thread];
      if (!list?.some((m) => m.id === messageId)) return p;
      const rest = list.filter((m) => m.id !== messageId);
      return { ...p, threads: setEntry(p.threads, thread, rest.length ? rest : null) };
    });
  }, [merge]);

  const mergeMark = useCallback((markId: string, mark: BoardMark | null) => {
    merge('after-mark', (p) => ({ ...p, marks: setEntry(p.marks, markId, mark) }));
  }, [merge]);

  const mergeProject = useCallback((projectId: string, project: BoardProject | null) => {
    merge('after-project', (p) => ({ ...p, projects: setEntry(p.projects, projectId, project) }));
  }, [merge]);

  const mergeCheck = useCallback((checkId: string, check: BoardCheck | null) => {
    merge('after-check', (p) => ({ ...p, checks: setEntry(p.checks, checkId, check) }));
  }, [merge]);

  const mergeChoice = useCallback((choiceId: string, choice: BoardChoice | null) => {
    merge('after-choice', (p) => ({
      ...p,
      choices: setEntry(p.choices, choiceId, choice),
      reminders: choice ? dropDueReminder(p.reminders, choiceId) : p.reminders,
    }));
  }, [merge]);

  const mergeReminder = useCallback((target: string, reminder: BoardReminder | null) => {
    merge('after-reminder', (p) => ({ ...p, reminders: setEntry(p.reminders, target, reminder) }));
  }, [merge]);

  const mergeSectionSeen = useCallback((sectionId: string, seen: BoardSectionSeen) => {
    merge('after-section-seen', (p) => ({ ...p, section_seen: setEntry(p.section_seen, sectionId, seen) }));
  }, [merge]);

  const reload = useCallback(() => { void load('manual'); }, [load]);
  const reloadKanban = useCallback(() => {
    if (payloadRef.current) reloader.current?.request('manual');
    else void load('manual');
  }, [load]);

  return {
    payload, loading, error, reload, mergeMessage, dropMessage, mergeMark, mergeProject, mergeCheck, mergeChoice,
    mergeReminder, mergeSectionSeen, fetchStartedAt, reloadKanban,
  };
}
