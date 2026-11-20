/**
 * An Org node's Threads (GET /api/v1/tasks/:id/threads), kept current by `org-threads:changed`
 * and re-read on reconnect. Writes made here show at once and are undone when the server refuses.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { fetchOrgThreads, patchOrgThread, splitOrgThread, type OrgThread, type OrgThreadPatch } from '@/api/org-threads';
import { useEvent } from '@/hooks/useWebSocket';
import { useTaskStoreActions } from '@/contexts/TasksContext';
import { statusWithThreads } from '@/hooks/status-prediction';
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

/**
 * One list per node for the whole page, not one per surface that shows it: the Org page's node
 * and the session column of the same task both read it, so a thread acted on in one is already
 * changed in the other (each used to keep its own copy and hear of the other's write from the
 * server). `drawn` is what every surface shows: the last read with the writes still on their
 * way laid over it. A node opened again draws it in its first frame while the read behind it
 * brings it current (2026-11-04: every node switch showed "Loading…").
 */
interface NodeThreads {
  read: OrgThread[] | null; pending: Map<string, OrgThreadPatch>; drawn: OrgThread[] | null; seq: number;
  /** performance.now() of the last write answered: the server's statuses for it may still be on the way. */
  settledAt: number;
  /** The server counts this node's threads into its status (seen once on a row). */
  counted: boolean;
  /** A read the surfaces hearing the same event (or mounting together) share, until this task ends. */
  joinable?: { why: string; p: Promise<boolean | 'stale'> };
}
/** How long after a write's answer the server's derived status for an EARLIER write may still land. */
const SETTLE_MS = 3_000;
const nodes = new Map<string, NodeThreads>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function nodeOf(taskId: string): NodeThreads {
  let n = nodes.get(taskId);
  if (!n) { n = { read: null, pending: new Map(), drawn: null, seq: 0, settledAt: 0, counted: false }; nodes.set(taskId, n); }
  return n;
}
/** Recompute what a node's surfaces draw, and tell them. */
function redraw(taskId: string): OrgThread[] | null {
  const n = nodeOf(taskId);
  n.drawn = n.read && n.pending.size
    ? n.read.map((t) => { const p = n.pending.get(t.id); return p ? optimistic(t, p) : t; })
    : n.read;
  for (const fn of [...listeners]) fn();
  return n.drawn;
}

/** The reasons every surface of one node hears at the same moment: one read answers them all. */
const SHARED_READS: ReadonlySet<string> = new Set(['open', 'changed', 'reconnect']);

/**
 * Read a node's threads. True when the list is drawn, false when the read failed, 'stale' when a
 * later read of the node won. Several surfaces show one node (the Org page, its chat's top thread,
 * a Threads pane): an event they all hear, or a mount they share, starts one read, not one each.
 * Only within the same task of the event loop: a change announced later always reads again.
 */
function readNode(taskId: string, why: string): Promise<boolean | 'stale'> {
  const node = nodeOf(taskId);
  if (SHARED_READS.has(why) && node.joinable?.why === why) return node.joinable.p;
  const mine = ++node.seq;
  const p: Promise<boolean | 'stale'> = fetchOrgThreads(taskId).then((next) => {
    // A later read of this node wins: an answer that comes back late is dropped.
    if (mine !== node.seq) return 'stale';
    node.read = next;
    redraw(taskId);
    return true;
  }, (err: unknown) => {
    if (mine !== node.seq) return 'stale';
    log.warn('org-threads', 'threads read failed', { taskId, why, error: err instanceof Error ? err.message : String(err) });
    return false;
  });
  if (SHARED_READS.has(why)) {
    const joinable = { why, p };
    node.joinable = joinable;
    queueMicrotask(() => { if (node.joinable === joinable) node.joinable = undefined; });
  }
  return p;
}

/** Test seam: forget every node (a module store outlives a test's page). */
export function resetOrgThreadsForTest(): void { nodes.clear(); listeners.clear(); }

export function useOrgThreads(taskId: string | undefined, enabled: boolean): OrgThreadsState {
  // The store's writes only, never its rows: an open chat keeps this hook mounted, and the full
  // context changes on every task write (TaskStoreActions).
  const tasks = useTaskStoreActions();
  const threads = useSyncExternalStore(subscribe, () => (taskId && enabled ? nodes.get(taskId)?.drawn ?? null : null));
  const [error, setError] = useState<string | null>(null);
  /** A write the server refused: kept until the next write saves (a re-read does not clear it). */
  const [writeError, setWriteError] = useState<string | null>(null);
  const ownerReadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (ownerReadTimer.current) clearTimeout(ownerReadTimer.current);
    ownerReadTimer.current = null;
  }, [taskId, enabled]);
  /** Read the threads; false when the read failed (a later read that wins counts as done). */
  const load = useCallback(async (why: string): Promise<boolean> => {
    if (!taskId) return true;
    const got = await readNode(taskId, why);
    // A later read that wins counts as done.
    if (got === 'stale') return true;
    setError(got ? null : 'Threads could not be read. They come back when the server answers.');
    return got;
  }, [taskId]);
  useEffect(() => {
    setError(null);
    setWriteError(null);
    if (enabled) void load('open');
  }, [taskId, enabled, load]);
  useEvent('org-threads:changed', (data) => {
    if (!enabled || (data as { taskId?: string } | null)?.taskId !== taskId) return;
    void load('changed');
  });
  const ownerChanged = (data: unknown) => {
    if (!enabled) return;
    const d = data as { task?: { id?: string }; taskId?: string } | null;
    const id = d?.task?.id ?? d?.taskId;
    if (id && !ownerReadTimer.current && threads?.some((t) => t.askOwner?.task === id || t.tasks?.includes(id))) {
      ownerReadTimer.current = setTimeout(() => { ownerReadTimer.current = null; void load('owner-changed'); }, 150);
    }
  };
  useEvent('task:updated', ownerChanged);
  useEvent('task:completed', ownerChanged);
  useEvent('task:deleted', ownerChanged);
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
    const node = nodeOf(taskId);
    node.pending.set(threadId, patch);
    const drawn = redraw(taskId);
    // The node's row reads its counts off the task's status: predicted from the same list, now.
    // Made from the list as drawn NOW each time the server speaks, while writes are out or just
    // answered: the status the server derived for the first of two acts is not the last word.
    const predict = () => (node.drawn ? tasks?.predictStatus(taskId, (row) => {
      // Once its status carried counts, the server counts this node: a prediction of none left
      // (no `threads` at all) must still be counted up again.
      node.counted ||= !!row.user_status?.threads;
      return statusWithThreads(row.user_status, node.drawn ?? [], node.counted);
    }, { live: () => node.pending.size > 0 || performance.now() - node.settledAt < SETTLE_MS }) : undefined);
    const unpredict = drawn ? predict() : undefined;
    const done = () => { node.settledAt = performance.now(); if (node.pending.get(threadId) === patch) node.pending.delete(threadId); };
    try {
      await patchOrgThread(taskId, threadId, patch);
      // Saved: the change is part of the list now, so nothing draws back while the read is out.
      if (node.pending.get(threadId) === patch && node.read) node.read = node.read.map((t) => (t.id === threadId ? optimistic(t, patch) : t));
      done();
      redraw(taskId);
      setWriteError(null);
      void load('write');
      return true;
    } catch (err) {
      log.warn('org-threads', 'thread write failed', { taskId, threadId, error: err instanceof Error ? err.message : String(err) });
      done();
      redraw(taskId);
      unpredict?.();
      // Another write of this node is still out (or its prediction replaced this one): counted
      // again from the list as it is drawn now, without the refused change.
      predict();
      void load('failed');
      setWriteError(`That did not save: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, [taskId, tasks, load]);

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
