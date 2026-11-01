/**
 * An Org node's Threads (GET /api/v1/tasks/:id/threads), kept current by `org-threads:changed`
 * and re-read on reconnect. Writes made here show at once and are undone when the server refuses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOrgThreads, patchOrgThread, splitOrgThread, type OrgThread, type OrgThreadPatch } from '@/api/org-threads';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

export interface OrgThreadsState {
  threads: OrgThread[] | null;
  error: string | null;
  update: (threadId: string, patch: OrgThreadPatch) => Promise<boolean>;
  split: (threadId: string, messageId: string) => Promise<boolean>;
}

/** What a close or reopen looks like before the server answers. */
function optimistic(t: OrgThread, patch: OrgThreadPatch): OrgThread {
  const at = new Date().toISOString();
  if (patch.close) return { ...t, closed: { how: patch.close, at, by: 'human' }, updatedAt: at };
  if (patch.reopen) { const { closed: _c, ...rest } = t; return { ...rest, updatedAt: at }; }
  return t;
}

export function useOrgThreads(taskId: string | undefined, enabled: boolean): OrgThreadsState {
  const [threads, setThreads] = useState<OrgThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A write the server refused: kept until the next write saves (a re-read does not clear it). */
  const [writeError, setWriteError] = useState<string | null>(null);
  const seq = useRef(0);
  /** Writes on their way, by thread: a read that lands meanwhile keeps showing them. */
  const pending = useRef(new Map<string, OrgThreadPatch>());
  const withPending = (list: OrgThread[]): OrgThread[] =>
    pending.current.size ? list.map((t) => { const p = pending.current.get(t.id); return p ? optimistic(t, p) : t; }) : list;
  const load = useCallback(async (why: string) => {
    if (!taskId) return;
    const mine = ++seq.current;
    try {
      const next = await fetchOrgThreads(taskId);
      // A later read (or a node change) wins: an answer that comes back late is dropped.
      if (mine === seq.current) { setThreads(withPending(next)); setError(null); }
    } catch (err) {
      if (mine !== seq.current) return;
      log.warn('org-threads', 'threads read failed', { taskId, why, error: err instanceof Error ? err.message : String(err) });
      setError('Threads could not be read. They come back when the server answers.');
    }
  }, [taskId]);
  useEffect(() => {
    setThreads(null);
    setError(null);
    setWriteError(null);
    pending.current.clear();
    if (enabled) void load('open');
  }, [taskId, enabled, load]);
  useEvent('org-threads:changed', (data) => {
    if (!enabled || (data as { taskId?: string } | null)?.taskId !== taskId) return;
    void load('changed');
  });
  useEvent('_ws:reconnected', () => { if (enabled) void load('reconnect'); });

  const update = useCallback(async (threadId: string, patch: OrgThreadPatch): Promise<boolean> => {
    if (!taskId) return false;
    // Only this thread changes, so a refused write undoes only itself (never another card's).
    const before = threads?.find((t) => t.id === threadId);
    pending.current.set(threadId, patch);
    setThreads((cur) => cur?.map((t) => (t.id === threadId ? optimistic(t, patch) : t)) ?? cur);
    try {
      await patchOrgThread(taskId, threadId, patch);
      if (pending.current.get(threadId) === patch) pending.current.delete(threadId);
      setWriteError(null);
      void load('write');
      return true;
    } catch (err) {
      log.warn('org-threads', 'thread write failed', { taskId, threadId, error: err instanceof Error ? err.message : String(err) });
      if (pending.current.get(threadId) === patch) pending.current.delete(threadId);
      if (before) setThreads((cur) => cur?.map((t) => (t.id === threadId ? before : t)) ?? cur);
      void load('failed');
      setWriteError(`That did not save: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, [taskId, threads, load]);

  const split = useCallback(async (threadId: string, messageId: string): Promise<boolean> => {
    if (!taskId) return false;
    try {
      await splitOrgThread(taskId, threadId, messageId);
      setWriteError(null);
      void load('split');
      return true;
    } catch (err) {
      log.warn('org-threads', 'thread split failed', { taskId, threadId, messageId, error: err instanceof Error ? err.message : String(err) });
      setWriteError(`That did not split: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, [taskId, load]);

  return { threads, error: writeError ?? error, update, split };
}
