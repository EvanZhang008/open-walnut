/**
 * Session-changes background pre-warmer.
 *
 * The Changed tab is cache-served (session-changes.ts): warm opens are instant,
 * but the FIRST compute for a big session is a 40-80s background parse. Without
 * this module that first compute only starts when a user opens the tab — so the
 * first open after a server restart always shows a stale/light snapshot until
 * the on-demand recompute lands.
 *
 * This pre-warmer moves that work off the user's click entirely: it computes
 * every recent session's changes in the background, continuously —
 *   - on startup (delayed, after the server settles),
 *   - after every turn completion (SESSION_RESULT, debounced),
 *   - and on a periodic sweep (mtime fast-path makes unchanged sessions cost
 *     ONE fs.stat each).
 *
 * Design constraints (the whole point):
 *   - STRICTLY SERIAL: one compute at a time, globally. Never two whale parses
 *     in parallel, never a queue pile-up on one daemon WS.
 *   - Paced: a fixed idle gap between computes yields the event loop and the
 *     daemon connection to interactive traffic.
 *   - Deferential: if a compute for that session is already in flight
 *     (user-triggered), skip — computeSessionChanges dedups anyway, but we
 *     must not QUEUE behind it either.
 *   - Bounded: only listable sessions active in the last ACTIVE_WINDOW_MS,
 *     capped per sweep; per-session cooldown between warms.
 * All work runs through computeSessionChanges, so results land in the same
 * cache + disk snapshot the tab reads. Failures are logged and skipped.
 */

import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';

interface PrewarmCandidate {
  claudeSessionId: string;
  cwd?: string;
  host?: string;
  outputFile?: string;
  lastActiveAt: string;
}

export interface PrewarmOptions {
  /** Delay before the first sweep after start() (server settle time). */
  startupDelayMs?: number;
  /** Periodic sweep interval. */
  sweepIntervalMs?: number;
  /** Idle gap between two consecutive computes. */
  paceMs?: number;
  /** Per-session minimum time between warms. */
  cooldownMs?: number;
  /** Debounce after a SESSION_RESULT before warming that session. */
  turnDebounceMs?: number;
  /** Only warm sessions active within this window. */
  activeWindowMs?: number;
  /** Max sessions considered per sweep. */
  sweepCap?: number;
  /** Injectable for tests: list candidate sessions (recent first). */
  listCandidates?: () => Promise<PrewarmCandidate[]>;
  /** Injectable for tests: the compute itself. */
  compute?: (sessionId: string, cwd?: string, host?: string, outputFile?: string) => Promise<unknown>;
  /** Injectable for tests: is a compute for this key already in flight? */
  hasInflight?: (sessionId: string, host?: string) => boolean;
}

const DEFAULTS = {
  startupDelayMs: 45_000,
  sweepIntervalMs: 5 * 60_000,
  paceMs: 5_000,
  cooldownMs: 60_000,
  turnDebounceMs: 10_000,
  activeWindowMs: 48 * 3_600_000,
  sweepCap: 20,
} as const;

async function defaultListCandidates(): Promise<PrewarmCandidate[]> {
  const { listRecentSessionRecords, isListableSession } = await import('./session-tracker.js');
  const records = await listRecentSessionRecords(200);
  return records.filter(isListableSession).map((r) => ({
    claudeSessionId: r.claudeSessionId,
    cwd: r.cwd,
    host: r.host,
    outputFile: r.outputFile,
    lastActiveAt: r.lastActiveAt,
  }));
}

async function defaultCompute(sessionId: string, cwd?: string, host?: string, outputFile?: string): Promise<unknown> {
  const { computeSessionChanges } = await import('./session-changes.js');
  return computeSessionChanges(sessionId, cwd, host, outputFile);
}

function defaultHasInflight(sessionId: string, host?: string): boolean {
  // Sync require-less probe: session-changes exports its in-flight check.
  // Loaded lazily below in start() to avoid an import cycle at module load.
  return inflightProbe ? inflightProbe(sessionId, host) : false;
}

let inflightProbe: ((sessionId: string, host?: string) => boolean) | null = null;

export class SessionChangesPrewarmer {
  private opts: Required<Omit<PrewarmOptions, 'listCandidates' | 'compute' | 'hasInflight'>>;
  private listCandidates: () => Promise<PrewarmCandidate[]>;
  private compute: (sessionId: string, cwd?: string, host?: string, outputFile?: string) => Promise<unknown>;
  private hasInflight: (sessionId: string, host?: string) => boolean;

  private queue: PrewarmCandidate[] = [];
  private queued = new Set<string>();       // claudeSessionId currently in queue
  private lastWarm = new Map<string, number>(); // sessionId → last warm end ts
  private running = false;                  // drain loop active
  private stopped = true;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private busUnsub: (() => void) | null = null;

  constructor(options: PrewarmOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.listCandidates = options.listCandidates ?? defaultListCandidates;
    this.compute = options.compute ?? defaultCompute;
    this.hasInflight = options.hasInflight ?? defaultHasInflight;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    // Load the in-flight probe lazily (avoids import cycle at module load).
    void import('./session-changes.js').then((m) => {
      inflightProbe = (sid, host) => m.hasInflightSessionChanges(sid, host);
    }).catch(() => { /* probe stays null — dedup inside compute still applies */ });

    // Warm after a turn completes: the session's JSONL just grew, so the next
    // tab open would otherwise pay the recompute. Debounced per session.
    // Global subscriber with an interest set — never woken by streaming events.
    bus.subscribe('session-changes-prewarm', (event) => {
      const sid = (event.data as { sessionId?: string } | undefined)?.sessionId;
      if (!sid || this.stopped) return;
      const t = setTimeout(() => {
        this.timers.delete(t);
        void this.enqueueSession(sid);
      }, this.opts.turnDebounceMs);
      this.timers.add(t);
    }, { global: true, interest: [EventNames.SESSION_RESULT] });
    this.busUnsub = () => bus.unsubscribe('session-changes-prewarm');

    // Startup sweep (delayed) + periodic sweeps.
    const startT = setTimeout(() => {
      this.timers.delete(startT);
      void this.sweep();
      this.sweepTimer = setInterval(() => { void this.sweep(); }, this.opts.sweepIntervalMs);
    }, this.opts.startupDelayMs);
    this.timers.add(startT);

    log.session.info('session-changes prewarmer started', {
      startupDelayMs: this.opts.startupDelayMs, sweepIntervalMs: this.opts.sweepIntervalMs,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.busUnsub) { this.busUnsub(); this.busUnsub = null; }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    this.queue = [];
    this.queued.clear();
  }

  /** One sweep: enqueue recent, listable, in-window sessions (recent first). */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    let candidates: PrewarmCandidate[];
    try {
      candidates = await this.listCandidates();
    } catch (err) {
      log.session.debug('prewarm sweep: listing failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const cutoff = Date.now() - this.opts.activeWindowMs;
    let added = 0;
    for (const c of candidates) {
      if (added >= this.opts.sweepCap) break;
      const active = Date.parse(c.lastActiveAt);
      if (Number.isFinite(active) && active < cutoff) continue;
      if (this.pushCandidate(c)) added++;
    }
    if (added > 0) this.kick();
  }

  /** Enqueue one session by id (turn-completion path). */
  private async enqueueSession(sessionId: string): Promise<void> {
    if (this.stopped) return;
    try {
      const { getSessionByClaudeId } = await import('./session-tracker.js');
      const record = await getSessionByClaudeId(sessionId);
      if (!record) return;
      if (this.pushCandidate({
        claudeSessionId: record.claudeSessionId,
        cwd: record.cwd, host: record.host, outputFile: record.outputFile,
        lastActiveAt: record.lastActiveAt,
      })) this.kick();
    } catch { /* record lookup failed — next sweep catches it */ }
  }

  /** True if actually queued (dedup + cooldown filter). */
  private pushCandidate(c: PrewarmCandidate): boolean {
    const sid = c.claudeSessionId;
    if (this.queued.has(sid)) return false;
    const last = this.lastWarm.get(sid);
    if (last !== undefined && Date.now() - last < this.opts.cooldownMs) return false;
    this.queued.add(sid);
    this.queue.push(c);
    return true;
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.drain().finally(() => { this.running = false; });
  }

  /** Serial drain: one compute at a time, paced. */
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const c = this.queue.shift();
      if (!c) return;
      this.queued.delete(c.claudeSessionId);

      // A user-triggered compute is already running for this session — do not
      // queue behind it (it warms the same cache anyway).
      if (this.hasInflight(c.claudeSessionId, c.host)) {
        this.lastWarm.set(c.claudeSessionId, Date.now());
        continue;
      }

      const t0 = Date.now();
      try {
        await this.compute(c.claudeSessionId, c.cwd, c.host, c.outputFile);
        const ms = Date.now() - t0;
        // Only log real work — the mtime fast-path returns in ~1 stat.
        if (ms > 1_000) {
          log.session.info('prewarm: session changes computed', {
            sessionId: c.claudeSessionId, host: c.host ?? '__local__', durationMs: ms,
          });
        }
      } catch (err) {
        log.session.debug('prewarm: compute failed', {
          sessionId: c.claudeSessionId, host: c.host ?? '__local__',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.lastWarm.set(c.claudeSessionId, Date.now());

      // Pace: yield the loop + daemon socket to interactive traffic.
      if (this.queue.length > 0 && !this.stopped) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { this.timers.delete(t); resolve(); }, this.opts.paceMs);
          this.timers.add(t);
        });
      }
    }
  }
}
