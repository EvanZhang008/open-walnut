/**
 * Keeps each session's first-paint view current in the background (history-ready-view.ts).
 *
 * A view kept by the history route only changes when someone opens the session; a session whose
 * turns run with nobody watching (a worker, a routine, a lead) would open on an old picture. So:
 *   - after every turn (SESSION_RESULT, debounced per session) the session's daemon is asked for
 *     its ready view, with the kept view's key: unchanged costs a stat on the host and a few bytes;
 *   - when a host's daemon (re)connects, every session on it active in the last RECENT_WINDOW_MS
 *     is compared in batches of KEYS_BATCH (`history.readyKeys`, one stat per session on the host,
 *     no parse), and only the ones whose view changed are fetched. No cap on how many: a host
 *     that ran forty sessions overnight gets forty views, one at a time.
 *
 * Strictly serial and paced, like the Changed-tab prewarmer (session-changes-prewarm.ts): one
 * fetch at a time, a gap between them, nothing at boot, nothing under memory pressure. A turn
 * whose view is kept already is skipped: one read after the turn ended (an open window's delta,
 * the meta's `contentAt`), never one only WRITTEN after it (a slow answer to an older ask). Never-opened
 * old sessions are not swept: their first open asks the host then (the route's first paint).
 */

import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';
import { memoryPressureShedding } from './memory-pressure.js';
import type { SessionRecord } from './types.js';
import { fetchReadyView, HISTORY_READY_CAPABILITY, READY_VIEW_ROWS, READY_VIEW_TURNS, readyViewEligible, wireCut, type ReadyViewConnection } from './history-ready-view.js';
import { readHistoryViewMeta, type HistoryViewMeta } from './history-view-snapshot.js';
import { legacyHintCutoff } from './sessions/legacy-hint-lines.js';

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const KEYS_BATCH = 50;

interface RefreshItem {
  sessionId: string;
  /** Skip when the kept view's read began at or after this (ms). 0 = always compare. */
  after: number;
}

export interface HistoryReadyRefreshOptions {
  turnDebounceMs?: number;
  /** A reconnect pass asked for sooner than this after start waits until then (boot connects every host). */
  startupDelayMs?: number;
  paceMs?: number;
  recentWindowMs?: number;
  keysBatch?: number;
  /** Seams for tests. */
  getRecord?: (sessionId: string) => Promise<SessionRecord | null | undefined>;
  listRecentOnHost?: (hostKey: string, sinceIso: string) => Promise<SessionRecord[]>;
  readMeta?: (sessionId: string) => Promise<HistoryViewMeta | null>;
  fetch?: (record: SessionRecord, have: string | undefined) => Promise<unknown>;
  connectionFor?: (hostKey: string) => ReadyViewConnection | null;
  isAcpJournal?: (record: SessionRecord) => boolean;
  subscribeTurns?: (onTurn: (sessionId: string) => void) => () => void;
  subscribeHosts?: (onHost: (hostKey: string) => void) => () => void;
  now?: () => number;
  shedding?: () => boolean;
}

export class HistoryReadyRefresher {
  private readonly o: Required<Omit<HistoryReadyRefreshOptions, 'subscribeTurns' | 'subscribeHosts'>> & Pick<HistoryReadyRefreshOptions, 'subscribeTurns' | 'subscribeHosts'>;
  private queue: RefreshItem[] = [];
  private queued = new Map<string, RefreshItem>();
  private running = false;
  private stopped = true;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubs: Array<() => void> = [];
  /** Hosts whose reconnect pass is running: a second connect while it runs adds nothing. */
  private hostPasses = new Set<string>();
  private startedAt = 0;

  constructor(options: HistoryReadyRefreshOptions = {}) {
    this.o = {
      turnDebounceMs: options.turnDebounceMs ?? 3_000,
      startupDelayMs: options.startupDelayMs ?? 60_000,
      paceMs: options.paceMs ?? 500,
      recentWindowMs: options.recentWindowMs ?? RECENT_WINDOW_MS,
      keysBatch: options.keysBatch ?? KEYS_BATCH,
      getRecord: options.getRecord ?? (async (sid) => (await import('./session-tracker.js')).getSessionByClaudeId(sid)),
      listRecentOnHost: options.listRecentOnHost ?? (async (host, since) => (await import('./session-tracker.js')).listRecentSessionsOnHost(host, since)),
      readMeta: options.readMeta ?? readHistoryViewMeta,
      fetch: options.fetch ?? ((record, have) => fetchReadyView(record, { interactive: false, have })),
      connectionFor: options.connectionFor ?? defaultConnectionFor,
      isAcpJournal: options.isAcpJournal ?? defaultIsAcpJournal,
      now: options.now ?? Date.now,
      shedding: options.shedding ?? memoryPressureShedding,
      subscribeTurns: options.subscribeTurns,
      subscribeHosts: options.subscribeHosts,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = this.o.now();
    const onTurn = (sid: string): void => {
      if (this.stopped) return;
      const at = this.o.now();
      const prev = this.timers.get(sid);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => { this.timers.delete(sid); this.enqueue({ sessionId: sid, after: at }); }, this.o.turnDebounceMs);
      t.unref?.();
      this.timers.set(sid, t);
    };
    const onHost = (hostKey: string): void => {
      if (this.stopped) return;
      const wait = this.startedAt + this.o.startupDelayMs - this.o.now();
      if (wait <= 0) { void this.reconnectPass(hostKey); return; }
      const key = `host\u0000${hostKey}`;
      if (this.timers.has(key)) return;
      const t = setTimeout(() => { this.timers.delete(key); void this.reconnectPass(hostKey); }, wait);
      t.unref?.();
      this.timers.set(key, t);
    };
    this.unsubs.push((this.o.subscribeTurns ?? defaultSubscribeTurns)(onTurn));
    this.unsubs.push((this.o.subscribeHosts ?? defaultSubscribeHosts)(onHost));
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs) { try { u(); } catch { /* already gone */ } }
    this.unsubs = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.queue = [];
    this.queued.clear();
  }

  /** Queue one session; a session already queued keeps one place with the later `after`. */
  enqueue(item: RefreshItem): void {
    if (this.stopped || this.o.shedding()) return;
    const held = this.queued.get(item.sessionId);
    if (held) { held.after = Math.max(held.after, item.after); return; }
    const entry = { ...item };
    this.queued.set(item.sessionId, entry);
    this.queue.push(entry);
    this.kick();
  }

  /** A host came back: compare every recent session's view key on it, batch by batch. */
  async reconnectPass(hostKey: string): Promise<number> {
    if (this.stopped || this.o.shedding() || this.hostPasses.has(hostKey)) return 0;
    const conn = this.o.connectionFor(hostKey);
    if (!conn || !conn.hasCapability(HISTORY_READY_CAPABILITY)) return 0;
    this.hostPasses.add(hostKey);
    let changed = 0;
    try {
      const since = new Date(this.o.now() - this.o.recentWindowMs).toISOString();
      const records = (await this.o.listRecentOnHost(hostKey, since))
        .filter((r) => readyViewEligible(r, this.o.isAcpJournal(r)));
      const cutoff = legacyHintCutoff();
      for (let i = 0; i < records.length && !this.stopped; i += this.o.keysBatch) {
        const batch = records.slice(i, i + this.o.keysBatch);
        let keys: Record<string, string | null>;
        try {
          const res = await conn.send('history.readyKeys', {
            items: batch.map((r) => ({
              sid: r.claudeSessionId,
              ...(r.cwd ? { cwd: r.cwd } : {}),
              // The same cut fields fetchReadyView sends, so both ask about one view.
              ...(r.inPlaceRewinds?.length ? { cuts: r.inPlaceRewinds.map(wireCut) } : {}),
              turns: READY_VIEW_TURNS, rows: READY_VIEW_ROWS, legacyHintCutoffMs: cutoff,
            })),
          }, 30_000);
          if (!res.ok || !res.keys || typeof res.keys !== 'object') break;
          keys = res.keys as Record<string, string | null>;
        } catch {
          break; // the host went away again: the next connect starts over
        }
        for (const r of batch) {
          const key = keys[r.claudeSessionId];
          if (!key) continue; // no transcript here (moved, offloaded)
          const meta = await this.o.readMeta(r.claudeSessionId);
          if (meta?.readyKey === key) continue;
          changed++;
          this.enqueue({ sessionId: r.claudeSessionId, after: 0 });
        }
      }
      if (changed > 0) log.session.info('history ready views to refresh after a reconnect', { host: hostKey, sessions: records.length, changed });
    } catch (err) {
      log.session.debug('history ready reconnect pass failed', { host: hostKey, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.hostPasses.delete(hostKey);
    }
    return changed;
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.drain().finally(() => { this.running = false; });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      if (this.o.shedding()) { this.queue = []; this.queued.clear(); return; }
      const item = this.queue.shift();
      if (!item) return;
      this.queued.delete(item.sessionId);
      try {
        const record = await this.o.getRecord(item.sessionId);
        if (!record || !readyViewEligible(record, this.o.isAcpJournal(record))) continue;
        const meta = await this.o.readMeta(item.sessionId);
        // A view read after this turn ended is kept (an open window's delta): nothing to do.
        if (item.after > 0 && meta?.contentAt !== undefined && meta.contentAt >= item.after) continue;
        await this.o.fetch(record, meta?.readyKey);
      } catch (err) {
        log.session.debug('history ready refresh failed', { sessionId: item.sessionId, error: err instanceof Error ? err.message : String(err) });
      }
      if (this.queue.length > 0 && !this.stopped) {
        await new Promise<void>((resolve) => { const t = setTimeout(resolve, this.o.paceMs); t.unref?.(); });
      }
    }
  }

  /** Tests. */
  _queueLength(): number { return this.queue.length; }
}

let connectionLookup: ((hostKey: string) => ReadyViewConnection | null) | null = null;
function defaultConnectionFor(hostKey: string): ReadyViewConnection | null {
  return connectionLookup ? connectionLookup(hostKey) : null;
}
let acpCheck: ((record: SessionRecord) => boolean) | null = null;
function defaultIsAcpJournal(record: SessionRecord): boolean {
  return acpCheck ? acpCheck(record) : false;
}

function defaultSubscribeTurns(onTurn: (sessionId: string) => void): () => void {
  const id = 'history-ready-refresh';
  bus.subscribe(id, (event) => {
    const sid = (event.data as { sessionId?: string } | undefined)?.sessionId;
    if (sid) onTurn(sid);
  }, { global: true, interest: [EventNames.SESSION_RESULT] });
  return () => bus.unsubscribe(id);
}

function defaultSubscribeHosts(onHost: (hostKey: string) => void): () => void {
  let unsub: (() => void) | null = null;
  let cancelled = false;
  void import('../providers/daemon-connection.js').then(({ addOnDaemonHostConnected }) => {
    if (!cancelled) unsub = addOnDaemonHostConnected(onHost);
  }).catch(() => {});
  return () => { cancelled = true; unsub?.(); };
}

/** The production refresher, wired to the daemon pool and the engine registry. */
export async function startHistoryReadyRefresher(): Promise<HistoryReadyRefresher> {
  const [{ getConnectedDaemonConnection }, { engineCaps }] = await Promise.all([
    import('../providers/daemon-connection.js'),
    import('./agents/engine-registry.js'),
  ]);
  connectionLookup = (hostKey) => getConnectedDaemonConnection(hostKey);
  acpCheck = (record) => engineCaps(record.engine).historySource === 'acp-journal';
  const refresher = new HistoryReadyRefresher();
  refresher.start();
  return refresher;
}
