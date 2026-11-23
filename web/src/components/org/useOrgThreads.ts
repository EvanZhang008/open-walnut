/**
 * An Org node's Threads (GET /api/v1/tasks/:id/threads), kept current by `org-threads:changed`
 * and re-read on reconnect. Writes made here show at once and are undone when the server refuses.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { fetchOrgThreads, patchOrgThread, splitOrgThread, type OrgThread, type OrgThreadPatch } from '@/api/org-threads';
import { useEvent } from '@/hooks/useWebSocket';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useTaskStoreActions } from '@/contexts/TasksContext';
import { statusWithThreads } from '@/hooks/status-prediction';
import { log } from '@/utils/log';

export interface OrgThreadsState {
  threads: OrgThread[] | null;
  error: string | null;
  update: (threadId: string, patch: OrgThreadPatch) => Promise<boolean>;
  split: (threadId: string, messageId: string) => Promise<boolean>;
  /**
   * His reply on a thread went (a card's box, a choice, a Follow up): the thread is drawn as the
   * server files it at once (his message makes it working, out of Needs you), `saved` when the
   * server answered with the record, and a read already out is dropped (2026-11-20, the user: a
   * card he replied on stayed in Needs you; on his data a read takes seconds).
   */
  heard: (threadId: string, saved?: OrgThread, words?: string) => void;
  /** Reads that caught this node's surfaces up (useThreadsCatchUp): a Threads pane draws no move across one. */
  catchUp?: number;
}

/**
 * A thread he just wrote on, as the server files it: working (the node's move), its held ask
 * answered, his words on it until the next read brings the filed message. Pure.
 */
export function heardOn(t: OrgThread, saved?: OrgThread, words?: string, at: string = new Date().toISOString()): OrgThread {
  if (t.closed) return saved ? { ...t, ...saved } : t;
  const { heldAsk: _h, ...rest } = t;
  // The record the server answered with is the owner's own: what the list adds (its owner, can_answer_now) stays.
  const merged = saved ? { ...rest, ...saved }
    : words?.trim() ? { ...rest, messages: [...rest.messages, { id: `local-${at}`, at, text: words, via: 'follow-up' as const }] } : rest;
  return merged.state === 'needs' || merged.state === 'answered' || merged.state === 'pending' || merged.state === 'new' ? { ...merged, state: 'working' } : merged;
}

/** What a close, reopen, snooze, watch or a drag in Watching looks like before the server answers. */
function optimistic(t: OrgThread, patch: OrgThreadPatch): OrgThread {
  const at = new Date().toISOString();
  if (patch.close) return { ...t, closed: { how: patch.close, at, by: 'human' }, updatedAt: at };
  // A watch moves no clock: its own group keeps it where it was (threads-model.ts watchOnly).
  if (patch.watch === false) { const { watched: _w, ...rest } = t; return rest; }
  if (patch.watch || patch.watch_at !== undefined) {
    // A new watch lands at the bottom of Watching; one already watched keeps its place unless dragged.
    const was = t.watched ?? { at, by: 'human' };
    return { ...t, watched: { at: patch.watch_at ?? was.at, by: patch.watch ? 'human' : was.by } };
  }
  if (patch.reopen) { const { closed: _c, ...rest } = t; return { ...rest, updatedAt: at }; }
  if (patch.snooze !== undefined) {
    const { snoozed: _s, ...rest } = t;
    if (patch.snooze) return { ...rest, snoozed: { until: patch.snooze, at, by: 'human' }, updatedAt: at };
    return { ...rest, updatedAt: at };
  }
  return t;
}

/** The server's answer to an Acknowledge it kept open, over the listed row: no snooze of his holds it any more (his watch does, as the server keeps it). */
function keptOpen(t: OrgThread, saved: OrgThread): OrgThread {
  const { watched: _w, snoozed: _s, ...rest } = t;
  return { ...rest, ...saved };
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
  /** Reads that caught a surface up (a mount, a reconnect): a change across one was never on screen (thread-moves.ts). */
  catchUp: number;
  /** A read the surfaces hearing the same event (or mounting together) share, until this task ends. */
  joinable?: { why: string; p: Promise<boolean | 'stale'> };
  /** The one read of this node on its way: a node is never read twice at once. */
  inFlight?: Promise<boolean | 'stale'>;
  /** The read asked for while one was on its way: one more after it, for every ask since. */
  trailing?: { whys: Set<string>; p: Promise<boolean | 'stale'>; resolve: (v: boolean | 'stale') => void };
  /** The node-wide timer of a read for a listed task that changed, and when the last one started. */
  ownerTimer?: ReturnType<typeof setTimeout>;
  ownerReadAt: number;
  /** The last read that counted failed: every surface says so until one succeeds, whatever started it. */
  failed: boolean;
  /** Surfaces showing the node now: a node nobody shows is not read for a listed task's change. */
  surfaces: number;
}
/** How long after a write's answer the server's derived status for an EARLIER write may still land. */
const SETTLE_MS = 3_000;
const nodes = new Map<string, NodeThreads>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function nodeOf(taskId: string): NodeThreads {
  let n = nodes.get(taskId);
  if (!n) { n = { read: null, pending: new Map(), drawn: null, seq: 0, settledAt: 0, counted: false, catchUp: 0, ownerReadAt: 0, failed: false, surfaces: 0 }; nodes.set(taskId, n); }
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
const SHARED_READS: ReadonlySet<string> = new Set(['open', 'changed', 'reconnect', 'snooze-ended']);
/** The reads that bring a surface up to date after it was away: what they change was never drawn as a move. */
const CATCH_UP_READS: ReadonlySet<string> = new Set(['open', 'reconnect']);

/**
 * Reads whose answer must start after them: a write of this page (an answer already on its way
 * predates it) and a catch-up (a surface's first frame must be a catch-up read, so a change across
 * it is never drawn as a move). The answer on its way is dropped and one read follows it.
 */
const DROPS_IN_FLIGHT: ReadonlySet<string> = new Set(['write', 'failed', 'split', 'open', 'reconnect']);
/**
 * A task a thread lists changed (its status, its ask): the node is read again at most this often.
 * Those events come several a second from a busy team, and each used to start a read per surface
 * of the node, in parallel (2026-11-21: one Mac app window read a VP's Threads 2 to 4 at a time
 * about every 1.5 s, 1604 reads in an hour, and the page's connection pool filled up so every
 * other request waited 20 to 60 s and was rejected).
 */
export const OWNER_READ_GAP_MS = 5_000;
/** The first read after a listed task changed waits this long, so a burst of changes is one read. */
const OWNER_READ_DELAY_MS = 150;

/**
 * Read a node's threads. True when the list is drawn, false when the read failed, 'stale' when a
 * later read of the node won. Several surfaces show one node (the Org page, its chat's top thread,
 * a Threads pane): an event they all hear, or a mount they share, starts one read, not one each.
 * At most one read of a node is on its way at a time: asks made meanwhile, for any reason and
 * from any surface, become ONE read after it (it starts after their change, so it sees it).
 */
function readNode(taskId: string, why: string): Promise<boolean | 'stale'> {
  const node = nodeOf(taskId);
  if (SHARED_READS.has(why) && node.joinable?.why === why) return node.joinable.p;
  if (DROPS_IN_FLIGHT.has(why)) node.seq++;
  if (node.inFlight) {
    if (!node.trailing) {
      let resolve: (v: boolean | 'stale') => void = () => undefined;
      const p = new Promise<boolean | 'stale'>((r) => { resolve = r; });
      node.trailing = { whys: new Set(), p, resolve };
    }
    node.trailing.whys.add(why);
    return node.trailing.p;
  }
  return startRead(taskId, node, new Set([why]));
}

function startRead(taskId: string, node: NodeThreads, whys: ReadonlySet<string>): Promise<boolean | 'stale'> {
  const mine = ++node.seq;
  const catchUp = [...whys].some((w) => CATCH_UP_READS.has(w));
  const p: Promise<boolean | 'stale'> = fetchOrgThreads(taskId).then((next) => {
    // A later read of this node wins: an answer that comes back late is dropped.
    if (mine !== node.seq) return 'stale';
    node.read = next;
    node.failed = false;
    if (catchUp) node.catchUp++;
    redraw(taskId);
    return true;
  }, (err: unknown) => {
    if (mine !== node.seq) return 'stale';
    log.warn('org-threads', 'threads read failed', { taskId, why: [...whys].join(','), error: err instanceof Error ? err.message : String(err) });
    node.failed = true;
    redraw(taskId);
    return false;
  }).finally(() => {
    if (node.inFlight !== p) return;
    node.inFlight = undefined;
    const next = node.trailing;
    node.trailing = undefined;
    if (next && nodes.get(taskId) === node) void startRead(taskId, node, next.whys).then(next.resolve);
    else next?.resolve('stale');
  });
  node.inFlight = p;
  for (const why of whys) {
    if (!SHARED_READS.has(why)) continue;
    const joinable = { why, p };
    node.joinable = joinable;
    queueMicrotask(() => { if (node.joinable === joinable) node.joinable = undefined; });
  }
  return p;
}

/** A task the node's threads list changed: one read for the whole node (every surface), at most every OWNER_READ_GAP_MS. */
function ownerReadSoon(taskId: string): void {
  const node = nodeOf(taskId);
  if (node.ownerTimer) return;
  const wait = Math.max(OWNER_READ_DELAY_MS, node.ownerReadAt + OWNER_READ_GAP_MS - Date.now());
  node.ownerTimer = setTimeout(() => {
    node.ownerTimer = undefined;
    if (nodes.get(taskId) !== node || node.surfaces === 0) return;
    node.ownerReadAt = Date.now();
    void readNode(taskId, 'owner-changed');
  }, wait);
}

/** Test seam: forget every node (a module store outlives a test's page). */
export function resetOrgThreadsForTest(): void {
  for (const n of nodes.values()) if (n.ownerTimer) clearTimeout(n.ownerTimer);
  nodes.clear(); listeners.clear();
}

/**
 * How many reads caught this node's surfaces up (a mount, a reconnect). A Threads pane compares its
 * groups from one read to the next only within one of these, so a card that changed group while
 * the pane was away or the link was down leaves no "Moved to" line (thread-moves.ts).
 */
export function useThreadsCatchUp(taskId: string | undefined): number {
  return useSyncExternalStore(subscribe, () => (taskId ? nodes.get(taskId)?.catchUp ?? 0 : 0));
}

/** A node that keeps Threads before its task exists (a CEO not started): none, never "Loading…". */
const NO_THREADS: OrgThread[] = [];

export function useOrgThreads(taskId: string | undefined, enabled: boolean): OrgThreadsState {
  // The store's writes only, never its rows: an open chat keeps this hook mounted, and the full
  // context changes on every task write (TaskStoreActions).
  const tasks = useTaskStoreActions();
  const threads = useSyncExternalStore(subscribe, () => (!enabled ? null : taskId ? nodes.get(taskId)?.drawn ?? null : NO_THREADS));
  const failed = useSyncExternalStore(subscribe, () => !!(enabled && taskId && nodes.get(taskId)?.failed));
  const error = failed ? 'Threads could not be read. They come back when the server answers.' : null;
  /** A write the server refused: kept until the next write saves (a re-read does not clear it). */
  const [writeError, setWriteError] = useState<string | null>(null);
  /** Read the threads; false when the read failed (a later read that wins counts as done). */
  const load = useCallback(async (why: string): Promise<boolean> => {
    if (!taskId) return true;
    const got = await readNode(taskId, why);
    // A later read that wins counts as done.
    return got === 'stale' ? true : got;
  }, [taskId]);
  useEffect(() => {
    setWriteError(null);
    if (!enabled || !taskId) return;
    const node = nodeOf(taskId);
    node.surfaces++;
    void load('open');
    return () => { node.surfaces--; };
  }, [taskId, enabled, load]);
  useEvent('org-threads:changed', (data) => {
    if (!enabled || (data as { taskId?: string } | null)?.taskId !== taskId) return;
    void load('changed');
  });
  const ownerChanged = (data: unknown) => {
    if (!enabled) return;
    const d = data as { task?: { id?: string }; taskId?: string } | null;
    const id = d?.task?.id ?? d?.taskId;
    // The node's own status too, when a thread holds its ask (core/org/thread-report-ask.ts): it reads needs only while the task asks it.
    if (taskId && id && threads?.some((t) => t.askOwner?.task === id || t.tasks?.includes(id) || (id === taskId && !!(t.reportAsk || t.heldAsk)))) ownerReadSoon(taskId);
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
      const saved = await patchOrgThread(taskId, threadId, patch);
      // Saved: the change is part of the list now, so nothing draws back while the read is out. An
      // Acknowledge the server kept open (its work still runs: pending, experiment ack_means_known) is drawn as it answered.
      const kept = patch.close && saved && !saved.closed && saved.id === threadId ? saved : null;
      if (node.pending.get(threadId) === patch && node.read) node.read = node.read.map((t) => (t.id === threadId ? (kept ? keptOpen(t, kept) : optimistic(t, patch)) : t));
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

  const heard = useLeanCallback((threadId: string, saved?: OrgThread, words?: string): void => {
    if (!taskId) return;
    const node = nodeOf(taskId);
    // A read out now started before his reply was filed: its answer must not draw the card back.
    node.seq++;
    if (node.read) node.read = node.read.map((t) => (t.id === threadId ? heardOn(t, saved, words) : t));
    redraw(taskId);
    void load('write');
  }, [taskId, load]);

  const catchUp = useThreadsCatchUp(enabled ? taskId : undefined);
  return { threads, error: writeError ?? error, update, split, heard, catchUp };
}
