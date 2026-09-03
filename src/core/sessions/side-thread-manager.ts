/**
 * Side-thread lifecycle owner.
 *
 * Side threads are hidden fork sessions (side-thread-fork.ts) with no task row,
 * so no existing reaper will ever act on them: the idle reapers treat them as
 * lane sessions, and a fork inherits its parent's background-task state, which
 * makes the health monitor skip it. This manager is therefore the ONLY thing
 * that retires them, and it owns four jobs:
 *
 *   1. STANDBY prewarm — one init-only fork per parent, parked on its FIFO so
 *      the user's first ask pays zero spawn latency. TTL 120s unconsumed.
 *   2. CONSUME — re-point the standby's lane at the real thread id and deliver
 *      the question through the ordinary send path.
 *   3. CAP — at most 3 threads per parent may hold a live CLI process.
 *   4. IDLE — a thread process idle >30min is terminated.
 *
 * (3) and (4) TERMINATE, they do not archive: the record survives, and the next
 * send cold-`--resume`s the CLI automatically (processNext → resolveResumeArgs).
 * Only an explicit retire (or an orphaned standby) archives the record.
 */

import { log } from '../../logging/index.js';
import type { SessionRecord } from '../types.js';
import {
  STANDBY_THREAD_ID, forkSideThreadSession, mintSideThreadId,
  parseSideLaneKey, sideThreadLaneKey,
} from './side-thread-fork.js';
import { SessionControlError } from './session-controls.js';
import { CACHE_WARMUP_MESSAGE, markWarmupTurnPending } from './side-thread-warmup.js';
import type { SideQuestion } from '../side-questions.js';

const STANDBY_TTL_MS = 120_000;
/** A warmed standby holds a paid prompt-cache write (1h server TTL); dropping it
 *  after the plain 2-minute idle window would throw that money away. */
const WARMED_STANDBY_TTL_MS = 15 * 60_000;
const MAX_LIVE_THREADS = 3;
const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
const THREAD_IDLE_MS = 30 * 60_000;

/** Record-level liveness: a process the daemon may still own. */
function isLive(r: SessionRecord): boolean {
  return r.process_status === 'running' || r.process_status === 'idle';
}

/** A thread whose CLI never ran a turn cannot be cold-resumed, so terminating it
 *  would strand it. Only sessions that reached a CLI are candidates. */
function isRevivable(r: SessionRecord): boolean {
  return !!r.outputFile || r.consumedOffset !== undefined;
}

export interface SideThread {
  id: string;
  threadSessionId: string;
  title?: string;
  createdAt: string;
}

class SideThreadManager {
  /** parentSid → TTL timer for its unconsumed standby. */
  private standbyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** parentSid → the parent's consumedOffset when its standby was forked.
   *  In-memory only: a server restart loses it, but the boot sweep archives
   *  every standby anyway, so a record can never outlive its map entry. */
  private standbyParentOffsets = new Map<string, number | undefined>();
  /** parentSid → standby sid that already ran its cache warm-up turn. */
  private warmedStandbys = new Map<string, string>();
  /** One in-flight standby/create op per parent — two concurrent asks must not
   *  both consume the same standby (they would collide on its lane rename). */
  private inFlight = new Map<string, Promise<unknown>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    // Boot sweep: a standby is in-memory bookkeeping (its TTL timer died with
    // the previous process), so any standby record found at boot is an orphan.
    void this.sweepOrphanStandbys().catch((err) => log.session.warn('side thread: boot sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    }));
    this.sweepTimer = setInterval(() => {
      // Reentrancy guard: a sweep awaits daemon terminates serially, so a wedged
      // host could push one tick past the interval — never stack a second sweep.
      if (this.sweeping) return;
      this.sweeping = true;
      void this.sweepIdleThreads()
        .catch((err) => log.session.warn('side thread: idle sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        }))
        .finally(() => { this.sweeping = false; });
    }, IDLE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    log.session.info('side-thread manager started');
  }

  stop(): void {
    this.started = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.standbyTimers.values()) clearTimeout(timer);
    this.standbyTimers.clear();
    this.standbyParentOffsets.clear();
    this.warmedStandbys.clear();
    // NOTE: clears without draining — an op chained before stop() and one issued
    // after can overlap. Acceptable: stop() only runs at shutdown/test teardown,
    // and surviving standbys self-heal via the next start()'s boot sweep.
    this.inFlight.clear();
  }

  // ── Standby ────────────────────────────────────────────────────────────────

  /**
   * Make sure a usable standby fork exists for `parentSid`. Fire-and-forget from
   * the route: the caller never waits on a spawn.
   */
  async ensureStandby(parentSid: string): Promise<string | null> {
    return this.serialize(parentSid, async () => {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      const parent = await getSessionByClaudeId(parentSid);
      if (!parent) return null;
      const existing = await this.findStandby(parentSid);
      if (existing) {
        if (await this.isStandbyUsable(parentSid, existing)) {
          const warmed = this.warmedStandbys.get(parentSid) === existing.claudeSessionId;
          this.armStandbyTtl(parentSid, existing.claudeSessionId, warmed ? WARMED_STANDBY_TTL_MS : STANDBY_TTL_MS);
          return existing.claudeSessionId;
        }
        // Stale (the parent kept working after the fork was taken) or dead —
        // either way its transcript is not what the user would be asking about.
        // Fire-and-forget: nothing downstream needs the retire to finish.
        void this.retireSession(existing.claudeSessionId, 'side_thread_standby_stale');
        this.warmedStandbys.delete(parentSid);
      }
      const parentOffset = parent.consumedOffset;
      const { sessionId } = await forkSideThreadSession(parentSid, STANDBY_THREAD_ID);
      this.standbyParentOffsets.set(parentSid, parentOffset);
      this.armStandbyTtl(parentSid, sessionId);
      return sessionId;
    });
  }

  private async findStandby(parentSid: string): Promise<SessionRecord | null> {
    const { getSessionByLane } = await import('../session-tracker.js');
    return getSessionByLane(sideThreadLaneKey(parentSid, STANDBY_THREAD_ID));
  }

  /** Usable = its CLI is (still) parked AND the parent's TRANSCRIPT has not
   *  grown since the fork. Staleness keys off `consumedOffset` (advances only
   *  when stream events land), NOT `lastActiveAt` — the latter is stamped by
   *  every bookkeeping write (~2/min on a busy parent), which judged nearly
   *  every standby stale and turned the prewarm into pure overhead. */
  private async isStandbyUsable(parentSid: string, standby: SessionRecord): Promise<boolean> {
    // A never-turned fork has no transcript of its own, so a dead standby is
    // unresumable — it must be replaced, never consumed.
    if (!isLive(standby)) return false;
    // No offset captured (map lost, e.g. standby minted by an older code path)
    // → can't prove freshness → stale. Safe direction: worst case a fresh fork.
    if (!this.standbyParentOffsets.has(parentSid)) return false;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const parent = await getSessionByClaudeId(parentSid);
    if (!parent) return false;
    return parent.consumedOffset === this.standbyParentOffsets.get(parentSid);
  }

  private armStandbyTtl(parentSid: string, sessionId: string, ttlMs = STANDBY_TTL_MS): void {
    const prev = this.standbyTimers.get(parentSid);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.standbyTimers.delete(parentSid);
      // Through serialize + a lane re-read: `clearTimeout` cannot cancel a
      // callback that already FIRED, so a consume landing inside this callback's
      // async window would otherwise send the question into a session that is
      // being terminated + archived. The rename is the commit point — once the
      // lane is no longer `:standby`, this expiry has nothing to retire.
      void this.serialize(parentSid, async () => {
        const { getSessionByClaudeId } = await import('../session-tracker.js');
        const record = await getSessionByClaudeId(sessionId).catch(() => null);
        if (!record || parseSideLaneKey(record.lane)?.threadId !== STANDBY_THREAD_ID) return;
        this.standbyParentOffsets.delete(parentSid);
        this.warmedStandbys.delete(parentSid);
        await this.retireSession(sessionId, 'side_thread_standby_ttl');
      }).catch(() => {});
    }, ttlMs);
    timer.unref?.();
    this.standbyTimers.set(parentSid, timer);
  }

  /**
   * Run the standby's cache warm-up turn (see side-thread-warmup.ts). Called
   * when the user starts TYPING a new question: the fork's first API call pays
   * the full prefix write no matter what, so paying it while they type turns
   * the actual question into a cached follow-up. Idempotent per standby; a
   * missing or stale standby is a no-op (the ask path will fork fresh anyway).
   */
  async warmStandby(parentSid: string): Promise<{ warmed: boolean; reason?: string }> {
    return this.serialize(parentSid, async () => {
      const standby = await this.findStandby(parentSid);
      if (!standby) return { warmed: false, reason: 'no_standby' };
      if (!(await this.isStandbyUsable(parentSid, standby))) return { warmed: false, reason: 'stale' };
      if (this.warmedStandbys.get(parentSid) === standby.claudeSessionId) {
        return { warmed: true, reason: 'already_warm' };
      }
      const { sendMessageToSession } = await import('../session-message-queue.js');
      markWarmupTurnPending(standby.claudeSessionId);
      await sendMessageToSession(standby.claudeSessionId, CACHE_WARMUP_MESSAGE, { source: 'side-thread-warmup' });
      this.warmedStandbys.set(parentSid, standby.claudeSessionId);
      this.armStandbyTtl(parentSid, standby.claudeSessionId, WARMED_STANDBY_TTL_MS);
      log.session.info('side thread: standby cache warm-up sent', {
        parentSid, standbySid: standby.claudeSessionId,
      });
      return { warmed: true };
    });
  }

  // ── Threads ────────────────────────────────────────────────────────────────

  /**
   * Open a side thread on `parentSid` and ask `question` in it.
   *
   * Two delivery shapes, deliberately different: a CONSUMED standby is already
   * live on its FIFO, so the question goes through the ordinary send path
   * (streaming + optimistic bubble + incremental cache). A FRESH fork carries the
   * question as its spawn's first turn instead — a send issued right after
   * SESSION_START can lose that race and cold-`--resume` an id the CLI has never
   * seen (see personal-ai-lane.ts LaneSession.created).
   *
   * `imageContext` (attachment paths for the CLI to Read) rides the MESSAGE only.
   * The stored entry keeps the plain question, so the chip label, the injected
   * transcript and a promoted task never carry the machine preamble.
   */
  async createThread(
    parentSid: string,
    input: { question: string; title?: string; imageContext?: string },
  ): Promise<SideThread> {
    const question = input.question?.trim();
    if (!question) throw new SessionControlError('question (non-empty string) is required', 400);
    return this.serialize(parentSid, async () => {
      const threadId = mintSideThreadId();
      const title = input.title?.trim() || undefined;
      const message = input.imageContext ? `${input.imageContext}\n\n${question}` : question;

      const consumed = await this.consumeStandby(parentSid, threadId, title);
      const threadSessionId = consumed
        ?? (await forkSideThreadSession(parentSid, threadId, { message, ...(title ? { title } : {}) })).sessionId;

      // The fork is committed before the store row — if anything below throws,
      // retire the orphan fork so no hidden CLI survives with no row to find it.
      let entry;
      try {
        const { addSideThread } = await import('../side-questions.js');
        entry = await addSideThread(parentSid, {
          id: threadId, question, threadSessionId, ...(title ? { title } : {}),
        });
        if (consumed) {
          const { sendMessageToSession } = await import('../session-message-queue.js');
          await sendMessageToSession(threadSessionId, message, { source: 'side-thread' });
        }
      } catch (err) {
        void this.retireSession(threadSessionId, 'side_thread_create_failed');
        if (entry) {
          const { removeSideThread } = await import('../side-questions.js');
          void removeSideThread(parentSid, threadId).catch(() => {});
        }
        throw err;
      }

      // Cap enforcement is best-effort background work (each eviction is a
      // daemon RPC that can block 30s on a wedged host) — never in the path
      // between the user's ask and the answer starting to stream.
      void this.enforceLiveCap(parentSid, threadSessionId).catch(() => {});

      log.session.info('side thread: created', {
        parentSid, threadId, threadSessionId, fromStandby: !!consumed,
      });
      return {
        id: entry.id, threadSessionId, ...(title ? { title } : {}), createdAt: entry.createdAt,
      };
    });
  }

  /** Re-point a usable standby's lane at the real thread id. Returns its id, or
   *  null when there was nothing usable to consume. */
  private async consumeStandby(
    parentSid: string,
    threadId: string,
    title?: string,
  ): Promise<string | null> {
    const standby = await this.findStandby(parentSid);
    if (!standby) return null;
    if (!(await this.isStandbyUsable(parentSid, standby))) {
      // Fire-and-forget: the caller is about to fork fresh; the stale standby's
      // teardown (a daemon RPC) must not sit in the user's ask path.
      void this.retireSession(standby.claudeSessionId, 'side_thread_standby_stale');
      this.standbyParentOffsets.delete(parentSid);
      this.warmedStandbys.delete(parentSid);
      return null;
    }
    const timer = this.standbyTimers.get(parentSid);
    if (timer) {
      clearTimeout(timer);
      this.standbyTimers.delete(parentSid);
    }
    this.standbyParentOffsets.delete(parentSid);
    this.warmedStandbys.delete(parentSid);
    const lane = sideThreadLaneKey(parentSid, threadId);
    const { updateSessionRecord } = await import('../session-tracker.js');
    await updateSessionRecord(standby.claudeSessionId, {
      lane,
      ...(title ? { title } : {}),
    });
    // Sync the LIVE instance too: the runner echoes `_lane` into the record on
    // every turn result, so a stale in-memory copy would revert this rename the
    // moment the thread's first answer lands (and the reverted "standby" would
    // then be retired or re-consumed under the user).
    try {
      const { sessionRunner } = await import('../../providers/claude-code-session.js');
      sessionRunner.syncLane(standby.claudeSessionId, lane);
    } catch { /* runner unavailable (tests) — the record write above still holds */ }
    return standby.claudeSessionId;
  }

  /** Terminate + archive a thread and drop its store entry. A PROMOTED thread's
   *  session belongs to its task now — only the drawer row is removed, the
   *  session stays alive under the normal session controls. */
  async retireThread(parentSid: string, threadId: string): Promise<void> {
    const { getSideQuestion, removeSideThread } = await import('../side-questions.js');
    const entry = await getSideQuestion(parentSid, threadId);
    if (!entry?.threadSessionId) throw new SessionControlError('Side thread not found', 404);
    if (!entry.promotedTaskId) {
      await this.retireSession(entry.threadSessionId, 'side_thread_retired');
    }
    await removeSideThread(parentSid, threadId);
  }

  /** Store entries for a parent, enriched with the record's archived flag. */
  async listThreads(parentSid: string): Promise<{
    threads: Array<SideQuestion & { archived: boolean }>;
    legacy: SideQuestion[];
  }> {
    const { listSideQuestions, isSideThreadEntry } = await import('../side-questions.js');
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const all = await listSideQuestions(parentSid);
    const threads: Array<SideQuestion & { archived: boolean }> = [];
    const legacy: SideQuestion[] = [];
    for (const entry of all) {
      if (!isSideThreadEntry(entry)) {
        legacy.push(entry);
        continue;
      }
      const record = await getSessionByClaudeId(entry.threadSessionId!).catch(() => null);
      threads.push({ ...entry, archived: !record || !!record.archived });
    }
    return { threads, legacy };
  }

  // ── Reapers ────────────────────────────────────────────────────────────────

  /** Keep at most MAX_LIVE_THREADS live thread processes per parent, evicting the
   *  least-recently-active. Terminate only — the record stays resumable.
   *  Runs in the background AFTER a create, so `keepSessionId` (the brand-new
   *  thread, whose record may not look revivable yet) is never a victim. */
  private async enforceLiveCap(parentSid: string, keepSessionId?: string): Promise<void> {
    const live = (await this.threadRecords(parentSid))
      .filter((r) => r.claudeSessionId !== keepSessionId && isLive(r) && isRevivable(r))
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt));
    let overBy = live.length - (MAX_LIVE_THREADS - 1);
    for (const victim of live) {
      if (overBy <= 0) break;
      overBy -= 1;
      log.session.info('side thread: evicting for live cap', {
        parentSid, sessionId: victim.claudeSessionId, lastActiveAt: victim.lastActiveAt,
      });
      await this.terminateProcess(victim.claudeSessionId, 'side_thread_live_cap');
    }
  }

  private async sweepIdleThreads(): Promise<void> {
    const cutoff = new Date(Date.now() - THREAD_IDLE_MS).toISOString();
    for (const r of await this.threadRecords()) {
      const ids = parseSideLaneKey(r.lane);
      if (!ids || ids.threadId === STANDBY_THREAD_ID) continue;
      if (r.lastActiveAt >= cutoff) continue;
      if (isLive(r) && isRevivable(r)) {
        log.session.info('side thread: retiring idle process', {
          sessionId: r.claudeSessionId, lastActiveAt: r.lastActiveAt,
        });
        await this.terminateProcess(r.claudeSessionId, 'side_thread_idle');
        continue;
      }
      // A thread whose spawn never produced a CLI (bad host, `claude` missing)
      // is not revivable and would otherwise sit as a non-archived record and a
      // dead drawer chip forever — this manager is its only reaper. The idle
      // cutoff doubles as the grace period, far past any legitimate spawn.
      if (!isRevivable(r)) {
        log.session.info('side thread: archiving never-initialized record', {
          sessionId: r.claudeSessionId, lastActiveAt: r.lastActiveAt,
        });
        await this.retireSession(r.claudeSessionId, 'side_thread_spawn_orphan');
      }
    }
  }

  private async sweepOrphanStandbys(): Promise<void> {
    for (const r of await this.threadRecords()) {
      const ids = parseSideLaneKey(r.lane);
      if (!ids || ids.threadId !== STANDBY_THREAD_ID) continue;
      log.session.info('side thread: archiving orphaned standby', { sessionId: r.claudeSessionId });
      await this.retireSession(r.claudeSessionId, 'side_thread_standby_orphan');
    }
  }

  /** Non-archived side-thread records. Global form (no parent) includes standby
   *  lanes (the sweeps handle them); the per-parent form excludes them (cap math
   *  counts real threads only — the standby is parked, not conversing). */
  private async threadRecords(parentSid?: string): Promise<SessionRecord[]> {
    const { listSessions } = await import('../session-tracker.js');
    const out: SessionRecord[] = [];
    for (const s of await listSessions()) {
      if (s.archived) continue;
      const ids = parseSideLaneKey(s.lane);
      if (!ids) continue;
      if (parentSid && ids.parentSid !== parentSid) continue;
      if (parentSid && ids.threadId === STANDBY_THREAD_ID) continue;
      out.push(s);
    }
    return out;
  }

  // ── Primitives ─────────────────────────────────────────────────────────────

  /** Stop the CLI, keep the record (the next send revives it). */
  private async terminateProcess(sessionId: string, reason: string): Promise<void> {
    try {
      const { sessionRunner } = await import('../../providers/claude-code-session.js');
      // Mark first — an unmarked kill surfaces as a spurious error toast.
      sessionRunner.markExpectedTeardown(sessionId, reason);
    } catch { /* runner unavailable — the terminate below is still correct */ }
    try {
      const { terminateSession } = await import('./session-lifecycle.js');
      // force: a thread inherits the parent's cron-armed state, and the guard
      // would 409 an internal reap.
      // Bounded: the kill can be a daemon RPC over SSH (30s command timeout) and
      // every caller here is best-effort — a wedged host must not pin a route or
      // a sweep. The RPC keeps running past the deadline; only the wait ends.
      const kill = terminateSession(sessionId, { force: true });
      // A post-deadline rejection must not become an unhandledRejection.
      kill.catch((err) => log.session.warn('side thread: terminate failed (late)', {
        sessionId, reason, error: err instanceof Error ? err.message : String(err),
      }));
      await Promise.race([
        kill,
        new Promise<void>((resolve) => { setTimeout(resolve, 8_000).unref?.(); }),
      ]);
    } catch (err) {
      log.session.warn('side thread: terminate failed', {
        sessionId, reason, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stop the CLI and archive the record — for good. */
  private async retireSession(sessionId: string, reason: string): Promise<void> {
    await this.terminateProcess(sessionId, reason);
    try {
      const { updateSessionRecord } = await import('../session-tracker.js');
      // updateSessionRecord, not patchSession: patchSession 400s when archiving a
      // live session, which would turn a failed terminate into a failed retire.
      await updateSessionRecord(sessionId, { archived: true, archive_reason: reason });
    } catch (err) {
      log.session.warn('side thread: archive failed', {
        sessionId, reason, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** One op at a time per parent (see `inFlight`). */
  private serialize<T>(parentSid: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.inFlight.get(parentSid) ?? Promise.resolve()).catch(() => {});
    const run = prev.then(fn);
    const tail = run.catch(() => {}).finally(() => {
      // Tail-identity check, not an unconditional delete (see side-questions.ts).
      if (this.inFlight.get(parentSid) === tail) this.inFlight.delete(parentSid);
    });
    this.inFlight.set(parentSid, tail);
    return run;
  }
}

export const sideThreadManager = new SideThreadManager();
