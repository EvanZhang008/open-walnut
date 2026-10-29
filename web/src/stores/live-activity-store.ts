/**
 * One browser, one copy of every running task's live action (core/live-activity.ts): what its
 * session does now, read by the server from the stream. Loaded once from
 * GET /api/sessions/live-activity, kept current by `session:live-activity` (throttled per
 * session at the server, null when the turn ends), refetched on every WS reconnect.
 *
 * A subscriber reads ONE task's entry, so another task's change does not re-render it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { parseLiveActivity, type LiveActivity } from '@open-walnut/live-activity';
import { wsClient } from '@/api/ws';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';

class LiveActivityStore {
  private byTask = new Map<string, LiveActivity>();
  /** Which session each task's entry came from, so a null for one session clears only its own. */
  private sessionOf = new Map<string, string>();
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  get = (taskId: string): LiveActivity | undefined => this.byTask.get(taskId);

  private bump(): void {
    for (const fn of this.listeners) fn();
  }

  /** Bumped by every event, so a first load that was in flight while one came keeps the event's word. */
  private seq = 0;
  private seqOf = new Map<string, number>();

  get eventSeq(): number { return this.seq; }

  ingestEvent(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as { sessionId?: unknown; taskId?: unknown; activity?: unknown; taskActivity?: unknown };
    if (typeof d.taskId !== 'string' || !d.taskId) return;
    this.seqOf.set(d.taskId, ++this.seq);
    // A server that sends the task's own line (its newest running session's) is read as is: one
    // session's end never clears another's. An older one sends the session's line alone.
    if ('taskActivity' in d) {
      const act = parseLiveActivity(d.taskActivity);
      if (act) this.byTask.set(d.taskId, act);
      else if (!this.byTask.delete(d.taskId)) return;
      this.sessionOf.delete(d.taskId);
      this.bump();
      return;
    }
    const sid = typeof d.sessionId === 'string' ? d.sessionId : '';
    const act = parseLiveActivity(d.activity);
    if (!act) {
      // Another session of the same task may still run: only its own entry goes.
      if (!this.byTask.has(d.taskId) || (sid && this.sessionOf.get(d.taskId) && this.sessionOf.get(d.taskId) !== sid)) return;
      this.byTask.delete(d.taskId);
      this.sessionOf.delete(d.taskId);
    } else {
      this.byTask.set(d.taskId, act);
      if (sid) this.sessionOf.set(d.taskId, sid);
    }
    this.bump();
  }

  /** The first load's answer; `sinceSeq` is the event count when it was asked. */
  replaceAll(byTask: Record<string, unknown>, sinceSeq = Infinity): void {
    const fresh = new Map<string, LiveActivity>();
    for (const [taskId, raw] of Object.entries(byTask)) {
      const act = parseLiveActivity(raw);
      if (act) fresh.set(taskId, act);
    }
    // A task an event spoke of after the load was asked keeps what the event said.
    const keep = (taskId: string) => (this.seqOf.get(taskId) ?? 0) > sinceSeq;
    for (const taskId of [...this.byTask.keys()]) {
      if (!keep(taskId)) { this.byTask.delete(taskId); this.sessionOf.delete(taskId); }
    }
    for (const [taskId, act] of fresh) {
      if (keep(taskId)) continue;
      this.byTask.set(taskId, act);
      if (act.sessionId) this.sessionOf.set(taskId, act.sessionId);
    }
    this.bump();
  }

  /** Test seam. */
  reset(): void {
    this.byTask.clear();
    this.sessionOf.clear();
    this.seqOf.clear();
    this.bump();
  }
}

export const liveActivityStore = new LiveActivityStore();

let initialized = false;
let loading: Promise<void> | null = null;

function load(): Promise<void> {
  const since = liveActivityStore.eventSeq;
  loading ??= apiGet<{ byTask?: Record<string, unknown> }>('/api/sessions/live-activity', undefined, { timeoutMs: 8_000, priority: 'low' })
    .then((r) => liveActivityStore.replaceAll(r?.byTask ?? {}, since))
    .catch((err) => log.warn('live-activity', 'load failed', { error: err instanceof Error ? err.message : String(err) }))
    .finally(() => { loading = null; });
  return loading;
}

/** Wire the ONE WS subscription; the first load waits for a reader (useLiveActivity). */
function init(): void {
  if (initialized) return;
  initialized = true;
  wsClient.onEvent('session:live-activity', (data) => liveActivityStore.ingestEvent(data));
  wsClient.onEvent('_ws:reconnected', () => { void load(); });
  void load();
}

/** A task's live action, or undefined when no turn of it runs (or the server predates it). */
export function useLiveActivity(taskId: string | undefined): LiveActivity | undefined {
  useEffect(init, []);
  return useSyncExternalStore(
    liveActivityStore.subscribe,
    () => (taskId ? liveActivityStore.get(taskId) : undefined),
    () => (taskId ? liveActivityStore.get(taskId) : undefined),
  );
}

/** The first of `taskIds` with a live action (a team's row: itself, then its workers). */
export function useFirstLiveTask(taskIds: readonly string[]): string | undefined {
  useEffect(init, []);
  const pick = () => taskIds.find((id) => liveActivityStore.get(id));
  return useSyncExternalStore(liveActivityStore.subscribe, pick, pick);
}

/** A clock for durations ("3 min"): re-renders every `ms` while `on`. */
export function useNow(on: boolean, ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
