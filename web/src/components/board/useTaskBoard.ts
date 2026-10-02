/**
 * The Board pane's data: `GET /api/v1/tasks/:id/board`, kept current by the
 * `board:changed` WS event (debounced, coalesced) and re-read on reconnect.
 *
 * Every load carries a sequence number; a response older than the newest
 * request is dropped, so a slow read can never put back state a newer one (or
 * a local merge) already moved past. A local merge (the user's own post or
 * mark, answered by its route) invalidates reads in flight and schedules a
 * fresh one, so the merged row is never flickered away by a read that started
 * before it existed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { mergeBoardMessage, type BoardMark, type BoardMessage, type BoardPayload } from './board-model';

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

function normalize(data: BoardPayload): BoardPayload {
  return {
    board: data?.board ?? null,
    threads: data?.threads ?? {},
    marks: data?.marks ?? {},
    refs: Array.isArray(data?.refs) ? data.refs : [],
  };
}

export interface TaskBoardData {
  payload: BoardPayload | null;
  /** True until the first answer (or failure) for this task. */
  loading: boolean;
  error: string | null;
  reload: () => void;
  mergeMessage: (thread: string, message: BoardMessage) => void;
  mergeMark: (markId: string, mark: BoardMark | null) => void;
}

export function useTaskBoard(taskId: string): TaskBoardData {
  const [payload, setPayload] = useState<BoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (why: string) => {
    const mine = ++seq.current;
    try {
      const data = await apiGet<BoardPayload>(boardPath(taskId), undefined, { quietStatuses: [404] });
      if (mine !== seq.current) return;
      setPayload(normalize(data));
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
  }, [taskId]);

  const scheduleLoad = useCallback((why: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void load(why);
    }, RELOAD_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    setPayload(null);
    setError(null);
    setLoading(true);
    void load('open');
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      seq.current++; // a read still in flight belongs to the task we left
    };
  }, [load]);

  useEvent('board:changed', (data) => {
    const d = data as { taskId?: string; kind?: string } | null;
    if (d?.taskId === taskId) scheduleLoad(`ws:${d.kind ?? 'change'}`);
  });
  useEvent('_ws:reconnected', () => scheduleLoad('reconnect'));

  const mergeMessage = useCallback((thread: string, message: BoardMessage) => {
    seq.current++;
    setPayload((p) => (p ? { ...p, threads: mergeBoardMessage(p.threads, thread, message) } : p));
    scheduleLoad('after-post');
  }, [scheduleLoad]);

  const mergeMark = useCallback((markId: string, mark: BoardMark | null) => {
    seq.current++;
    setPayload((p) => {
      if (!p) return p;
      const marks = { ...p.marks };
      if (mark) marks[markId] = mark; else delete marks[markId];
      return { ...p, marks };
    });
    scheduleLoad('after-mark');
  }, [scheduleLoad]);

  const reload = useCallback(() => { void load('manual'); }, [load]);

  return { payload, loading, error, reload, mergeMessage, mergeMark };
}
