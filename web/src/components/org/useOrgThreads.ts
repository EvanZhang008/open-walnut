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

/** What a close, reopen, snooze or pin looks like before the server answers. */
function optimistic(t: OrgThread, patch: OrgThreadPatch): OrgThread {
  const at = new Date().toISOString();
  if (patch.close) { const { pinned: _p, ...rest } = t; return { ...rest, closed: { how: patch.close, at, by: 'human' }, updatedAt: at }; }
  // A pin moves no clock: unpinned, the thread is back where it was.
  if (patch.pin !== undefined) {
    const { pinned: _p, snoozed: _s, ...rest } = t;
    // His pin keeps its time while the write is on its way (a re-read must not reorder the pins).
    if (patch.pin) return { ...rest, pinned: t.pinned?.by === 'human' ? t.pinned : { at, by: 'human' } };
    return t.snoozed ? { ...rest, snoozed: t.snoozed } : rest;
  }
  if (patch.reopen) { const { closed: _c, ...rest } = t; return { ...rest, updatedAt: at }; }
  if (patch.snooze !== undefined) {
    const { snoozed: _s, ...rest } = t;
    // Snoozed: put aside, so no longer pinned.
    if (patch.snooze) { const { pinned: _p, ...unpinned } = rest; return { ...unpinned, snoozed: { until: patch.snooze, at, by: 'human' }, updatedAt: at }; }
    return { ...rest, updatedAt: at };
  }
  return t;
}

/** The soonest snooze still to end (ms), so the view reads again when that thread comes back. */
function nextSnoozeEnd(list: readonly OrgThread[] | null, now: number): number | null {
  let soonest: number | null = null;
  for (const t of list ?? []) {
    const end = t.snoozed && !t.closed ? Date.parse(t.snoozed.until) : NaN;
    if (end > now && (soonest === null || end < soonest)) soonest = end;
  }
  return soonest;
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
  /** Read the threads; false when the read failed (a later read that wins counts as done). */
  const load = useCallback(async (why: string): Promise<boolean> => {
    if (!taskId) return true;
    const mine = ++seq.current;
    try {
      const next = await fetchOrgThreads(taskId);
      // A later read (or a node change) wins: an answer that comes back late is dropped.
      if (mine === seq.current) { setThreads(withPending(next)); setError(null); }
      return true;
    } catch (err) {
      if (mine !== seq.current) return true;
      log.warn('org-threads', 'threads read failed', { taskId, why, error: err instanceof Error ? err.message : String(err) });
      setError('Threads could not be read. They come back when the server answers.');
      return false;
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
  // A snoozed thread comes back on its date: read again then, so the list, the count and the
  // Threads tab's dot follow at once (not at the page's next minute tick).
  useEffect(() => {
    if (!enabled) return;
    const end = nextSnoozeEnd(threads, Date.now());
    if (end === null) return;
    let id = 0;
    let gone = false;
    // A read that fails is tried again, so the count and the dot never stay on the old answer.
    const readAt = (delay: number) => {
      id = window.setTimeout(() => { void load('snooze-ended').then((ok) => { if (!ok && !gone) readAt(30_000); }); }, delay);
    };
    readAt(Math.min(end - Date.now() + 250, 2 ** 31 - 1));
    return () => { gone = true; window.clearTimeout(id); };
  }, [threads, enabled, load]);

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
