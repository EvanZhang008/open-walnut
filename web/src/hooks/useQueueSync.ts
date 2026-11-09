/**
 * Keeps a panel's queued bubbles on the server's word: re-reads `session:get-queue`
 * whenever something may have moved a row, and merges it (queue-reconcile.ts).
 *
 * 2026-11-09: every open session showed its last message as Queued for many
 * minutes while the server had delivered it, the CLI had taken it, or the row was
 * gone; the events that move a bubble never came while the queue file lock was
 * jammed. Reads happen on:
 *   - every queue event of this session (delivered, batch completed or failed,
 *     held, cancelled): one of them moving one bubble is news for the others too
 *     ("the newer message is delivered but the older one is still queued");
 *   - a reconnect, the window gaining focus, the tab becoming visible;
 *   - a clock, every POLL_MS while any bubble still reads Queued and the tab is
 *     visible: the guarantee when no event comes at all.
 * One read at a time, coalesced; an answer for a session the panel left is dropped.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { wsClient } from '@/api/ws';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import { isClientId, reconcileWithQueue } from './queue-reconcile';
import type { QueueRowWire } from './useSessionSend';

/** How often a panel with a waiting bubble re-reads the queue. */
export const QUEUE_POLL_MS = 10_000;
/** A read that has not answered by then counts as failed (the queue did not answer). */
export const QUEUE_READ_TIMEOUT_MS = 15_000;
/** Events arriving together make one read. */
const COALESCE_MS = 250;

const QUEUE_EVENTS = ['session:messages-delivered', 'session:batch-completed', 'session:batch-failed', 'session:delivery-held', 'session:queued-cancelled'] as const;

/** Is any bubble waiting on the server (Queued, with an id the server gave)? */
export function hasWaitingBubble(msgs: readonly OptimisticMessage[]): boolean {
  return msgs.some((m) => !m.launch && !isClientId(m.queueId) && (m.status === 'pending' || m.status === 'received'));
}

export interface QueueSyncState {
  /** Why the last read failed, until one answers. Changes only when that does (no re-render per read). */
  error?: string;
}

export interface QueueSync {
  state: QueueSyncState;
  /** Ask for a read soon (coalesced). */
  request: (why: string) => void;
  /** An event moved these bubbles now: a read that began earlier must not undo it. */
  touch: (ids: readonly string[]) => void;
  /** The panel removed these on purpose: a read still listing one does not bring it back. */
  retire: (ids: readonly string[]) => void;
  /** A request of the panel's own about these rows is in flight (retry, delete, edit): no read judges them until `release`. */
  hold: (ids: readonly string[]) => void;
  release: (ids: readonly string[]) => void;
  /** The ids retired so far in this session (for its first read). */
  retiredIds: () => ReadonlySet<string>;
}

type Rows = { messages?: QueueRowWire[] };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function useQueueSync(
  sessionId: string | null,
  msgs: readonly OptimisticMessage[],
  msgsRef: MutableRefObject<OptimisticMessage[]>,
  setMsgs: Dispatch<SetStateAction<OptimisticMessage[]>>,
  toBubble: (row: QueueRowWire) => OptimisticMessage | null,
): QueueSync {
  const [state, setState] = useState<QueueSyncState>({});
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;
  const retired = useRef(new Set<string>());
  const touched = useRef(new Map<string, number>());
  const inFlight = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    retired.current = new Set();
    touched.current = new Map();
    setState({});
  }, [sessionId]);

  const read = useCallback(async () => {
    const sid = sidRef.current;
    if (!sid) return;
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    const startedAt = Date.now();
    const known = new Set(msgsRef.current.filter((m) => !m.launch && !isClientId(m.queueId)).map((m) => m.queueId));
    try {
      const res = await withTimeout(wsClient.sendRpc<Rows>('session:get-queue', { sessionId: sid }), QUEUE_READ_TIMEOUT_MS);
      if (sidRef.current !== sid) return;
      const touchedNow = new Set<string>();
      for (const [id, at] of touched.current) if (at >= startedAt) touchedNow.add(id);
      setMsgs((prev) => reconcileWithQueue(prev, res?.messages ?? [], {
        known, touched: touchedNow, retired: retired.current, now: Date.now(), toBubble,
      }));
      setState((s) => (s.error === undefined ? s : {}));
    } catch (e) {
      if (sidRef.current !== sid) return;
      const error = (e as Error).message;
      log.warn('send', 'queue read failed', { sessionId: sid, error });
      setState((s) => (s.error === error ? s : { error }));
    } finally {
      inFlight.current = false;
      if (again.current) { again.current = false; void read(); }
    }
  }, [msgsRef, setMsgs, toBubble]);

  const request = useCallback((why: string) => {
    if (!sidRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void read(); }, COALESCE_MS);
    void why; // the caller's reason, for reading the code: every read is the same read
  }, [read]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const touch = useCallback((ids: readonly string[]) => {
    const now = Date.now();
    for (const id of ids) if (touched.current.get(id) !== Number.POSITIVE_INFINITY) touched.current.set(id, now);
    if (touched.current.size > 256) {
      const old = [...touched.current].filter(([, at]) => at !== Number.POSITIVE_INFINITY).map(([id]) => id);
      for (const id of old.slice(0, touched.current.size - 256)) touched.current.delete(id);
    }
  }, []);
  // A held id counts as moved after every read until it is released (then as moved now).
  const hold = useCallback((ids: readonly string[]) => {
    for (const id of ids) touched.current.set(id, Number.POSITIVE_INFINITY);
  }, []);
  const release = useCallback((ids: readonly string[]) => {
    const now = Date.now();
    for (const id of ids) if (touched.current.get(id) === Number.POSITIVE_INFINITY) touched.current.set(id, now);
  }, []);
  const retire = useCallback((ids: readonly string[]) => {
    for (const id of ids) retired.current.add(id);
  }, []);

  const onQueueEvent = (data: unknown) => {
    if ((data as { sessionId?: string } | null)?.sessionId === sidRef.current) request('queue event');
  };
  useEvent(QUEUE_EVENTS[0], onQueueEvent);
  useEvent(QUEUE_EVENTS[1], onQueueEvent);
  useEvent(QUEUE_EVENTS[2], onQueueEvent);
  useEvent(QUEUE_EVENTS[3], onQueueEvent);
  useEvent(QUEUE_EVENTS[4], onQueueEvent);
  useEvent('_ws:reconnected', () => request('reconnected'));

  useEffect(() => {
    const onFocus = () => request('focus');
    const onVisible = () => { if (document.visibilityState === 'visible') request('visible'); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [request]);

  const waiting = !!sessionId && hasWaitingBubble(msgs);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') request('poll');
    }, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [waiting, request]);

  const retiredIds = useCallback(() => retired.current, []);
  return { state, request, touch, retire, hold, release, retiredIds };
}
