/**
 * Every session's git glance in this browser (branch, changed files, +/- lines,
 * unpushed commits, the Changed tab's count), shared by the rows and the
 * session panel that show it.
 *
 * Reads are batched: the rows that mount in one frame ask in ONE request
 * (/api/sessions/git-status, up to 50 ids). After that the server pushes each
 * change as `session:git-status`; a re-ask every few minutes keeps the
 * server watching the sessions still on screen, and a reconnect asks again.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { fetchSessionGitGlances, type SessionGitGlance } from '@/api/session-git-status';
import { wsClient, type ConnectionState } from '@/api/ws';
import { isPlaceholderColumnId } from '@/utils/column-ids';
import { log } from '@/utils/log';

const BATCH_DELAY_MS = 60;
const BATCH_MAX = 50;
/** An id read this recently is not asked again by a row mounting. */
const REREAD_MS = 25_000;
/** Visible rows re-ask this often: keeps the server's watch alive (it lapses after 15 min).
 *  The server re-reads only answers older than KEEPALIVE_MAX_AGE_S (idle rows stay cheap;
 *  an active session's rows are pushed on every change anyway). */
const KEEPALIVE_MS = 4 * 60_000;
const KEEPALIVE_MAX_AGE_S = 10 * 60;
/** Entries kept for sessions no row shows any more. */
const UNSHOWN_MAX = 500;

interface Entry {
  glance: SessionGitGlance | null;
  /** Date.now() of the last answer, and of the last ask (0 = never). */
  at: number;
  askedAt: number;
  listeners: Set<() => void>;
}

export interface GitGlanceClient {
  fetch: (ids: string[], opts: { refresh?: boolean; maxAgeSec?: number }) => Promise<Record<string, SessionGitGlance | null>>;
}

export class SessionGitStore {
  private entries = new Map<string, Entry>();
  private queued = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private wired = false;

  constructor(private client: GitGlanceClient, private now: () => number = () => Date.now()) {}

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { glance: null, at: 0, askedAt: 0, listeners: new Set() };
      this.entries.set(id, e);
      if (this.entries.size > UNSHOWN_MAX * 2) this.prune();
    }
    return e;
  }

  /** Forget the oldest entries no row listens to. */
  private prune(): void {
    let unshown = [...this.entries].filter(([, e]) => e.listeners.size === 0);
    unshown = unshown.sort((a, b) => a[1].at - b[1].at).slice(0, Math.max(0, unshown.length - UNSHOWN_MAX));
    for (const [id] of unshown) this.entries.delete(id);
  }

  get = (id: string): SessionGitGlance | null => this.entries.get(id)?.glance ?? null;

  subscribe = (id: string, listener: () => void): (() => void) => {
    this.wire();
    const e = this.entry(id);
    e.listeners.add(listener);
    this.want(id);
    return () => {
      e.listeners.delete(listener);
    };
  };

  /** Accept one glance (a response or a pushed event). */
  apply = (glance: SessionGitGlance): void => {
    if (!glance || typeof glance.sessionId !== 'string' || !Array.isArray(glance.repos)) return;
    const e = this.entry(glance.sessionId);
    // A late response never puts back an older reading than the one shown (a new
    // Changed count goes out with the reading time it was added to, so it passes).
    if (e.glance && Date.parse(glance.checkedAt) < Date.parse(e.glance.checkedAt)) return;
    e.glance = glance;
    e.at = this.now();
    for (const l of e.listeners) l();
  };

  /** Ask for an id unless it was read lately; batched with the others asked now. */
  want(id: string, force = false): void {
    if (!id || isPlaceholderColumnId(id)) return;
    const e = this.entry(id);
    if (!force && this.now() - Math.max(e.at, e.askedAt) < REREAD_MS) return;
    this.queued.add(id);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, BATCH_DELAY_MS);
  }

  /** Read one session now, the server re-reading its repos (an open Changed tab). */
  refresh = async (id: string): Promise<void> => {
    if (!id || isPlaceholderColumnId(id)) return;
    try {
      const got = await this.client.fetch([id], { refresh: true });
      this.take([id], got);
    } catch (err) {
      log.warn('git-glance', 'refresh failed', { sessionId: id, error: String(err) });
    }
  };

  private take(ids: string[], got: Record<string, SessionGitGlance | null>): void {
    for (const id of ids) {
      const g = got[id];
      // null = not read yet: the server reads it behind and pushes it.
      if (g) this.apply(g);
    }
  }

  private async flush(ids: string[] = [...this.queued], opts: { maxAgeSec?: number } = {}): Promise<void> {
    if (ids === undefined || ids.length === 0) return;
    for (const id of ids) this.queued.delete(id);
    for (let i = 0; i < ids.length; i += BATCH_MAX) {
      const batch = ids.slice(i, i + BATCH_MAX);
      // Marked asked before the answer, so rows mounting meanwhile do not ask again.
      for (const id of batch) this.entry(id).askedAt = this.now();
      try {
        this.take(batch, await this.client.fetch(batch, opts));
      } catch (err) {
        for (const id of batch) this.entry(id).askedAt = 0;
        log.warn('git-glance', 'batch read failed', { sessions: batch.length, error: String(err) });
      }
    }
  }

  private shownIds(): string[] {
    return [...this.entries].filter(([, e]) => e.listeners.size > 0).map(([id]) => id);
  }

  private wire(): void {
    if (this.wired || typeof window === 'undefined') return;
    this.wired = true;
    wsClient.onEvent('session:git-status', (data) => this.apply(data as SessionGitGlance));
    wsClient.onConnectionChange((state: ConnectionState) => {
      // Pushes missed while away: ask again for every row on screen.
      if (state === 'connected') for (const id of this.shownIds()) this.want(id, true);
    });
    this.keepAlive = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void this.flush(this.shownIds(), { maxAgeSec: KEEPALIVE_MAX_AGE_S });
    }, KEEPALIVE_MS);
  }

  /** Tests: forget everything. */
  _reset(): void {
    this.entries.clear();
    this.queued.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

export const sessionGitStore = new SessionGitStore({ fetch: (ids, opts) => fetchSessionGitGlances(ids, opts) });

/** A session's git glance, live; null while unknown (or for no session). */
export function useSessionGitGlance(sessionId: string | null | undefined): SessionGitGlance | null {
  const id = sessionId ?? '';
  const subscribe = useCallback((listener: () => void) => (id ? sessionGitStore.subscribe(id, listener) : () => {}), [id]);
  const snapshot = useCallback(() => (id ? sessionGitStore.get(id) : null), [id]);
  return useSyncExternalStore(subscribe, snapshot);
}
