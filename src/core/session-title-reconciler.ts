/**
 * Durable placeholder-title reconciler — the sweep arm of session auto-titling.
 *
 * Every event-driven title trigger (launch kick, onMessageSend hook,
 * observed-message tail, turn-complete safety net) lives in process memory and
 * needs a live session wrapper or a healthy daemon control pipe at the moment
 * it fires. The 2026-08-23 repro (task mt65k8x5): a local daemon that stopped
 * answering hello at launch failed every channel once, the CLI then ran the
 * whole session fine with no wrapper attached, and nothing ever retried — the
 * task wore `Session: walnut` through 49 minutes of real work.
 *
 * This sweep re-derives "still untitled" from DISK every tick (tasks store +
 * session registry + session JSONL), so it survives server restarts, dead
 * wrappers, and burned in-memory attempt budgets. Idempotent by construction:
 * askAndApplyTitle only ever writes while the exact placeholder is still in
 * place, so a human or agent rename permanently wins.
 *
 * Robustness contract (each clause is deliberate — keep them all):
 *  - one task's failure never skips the others (per-task isolation);
 *  - passes never overlap (in-flight guard; the next tick is armed BEFORE the
 *    pass runs, so a hung pass also can't stop the clock);
 *  - per-task exponential backoff is armed BEFORE each attempt, and pacing
 *    state self-prunes when a task leaves the candidate set — no leaks;
 *  - per-pass attempt cap bounds worst-case model spend even in pathological
 *    states (hundreds of stuck tasks);
 *  - no-op on test servers and cloud replicas (the primary owns titling; a
 *    replica write would race it through task sync).
 */

import { log } from '../logging/index.js';
import { CLOUD_MODE } from '../constants.js';
import { backgroundAiDisabled } from './cheap-model.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
/** First sweep waits for boot to settle (session reconnects, daemon dials). */
const FIRST_SWEEP_DELAY_MS = 90_000;
/** Placeholder tasks older than this are considered abandoned — a stale title
 *  on week-old work is not worth a model call per sweep forever. */
const MAX_TASK_AGE_MS = 48 * 3600_000;
/** askAndApplyTitle budget when the sweep drives the ask — deliberately above
 *  the interactive AUTO_TITLE_MAX_ATTEMPTS (3). The budget decays hourly in
 *  builtins.ts, so even a burned budget recovers; this number only bounds the
 *  burst spend within one decay window. */
const SWEEP_MAX_ATTEMPTS = 12;
/** Hard per-pass cap on titling attempts — bounds one pass's model spend and
 *  wall-clock even if something floods the store with placeholder tasks. The
 *  cap is on ATTEMPTS, not candidates: skipped/backed-off tasks don't consume
 *  it, and the next pass (5 min) picks up where this one stopped. */
const MAX_ATTEMPTS_PER_SWEEP = 10;
/** Soft wall-clock budget for one pass. Attempts against unreachable remote
 *  hosts each burn a daemon read timeout; without this, ten of them run the
 *  pass ~20 minutes long and the in-flight guard then eats whole ticks. What
 *  the deadline drops is logged — never a silent cap. */
const PASS_SOFT_DEADLINE_MS = 4 * 60_000;

/** Automation nudges that sometimes lead a transcript — useless as a title
 *  source. The sweep prefers the first message that is NOT one of these (and
 *  not a slash command / not sub-8-chars), falling back to the first non-empty
 *  message when nothing better exists: a vague real title beats a placeholder. */
const NUDGE_RE = /^(continue|go on|proceed|resume|retry|ok(ay)?|yes|y|do it|next)[.!]?$/i;

/** Per-task pacing: 5min → 10 → 20 → 40 → capped 60min between attempts.
 *  In-memory on purpose — after a restart the sweep just retries sooner, and
 *  every attempt is idempotent. */
const backoffUntil = new Map<string, number>();
const backoffCount = new Map<string, number>();

let timer: NodeJS.Timeout | null = null;
let sweepInFlight = false;

/** Test-only: clear pacing state and stop the interval. */
export function __resetTitleReconcilerForTesting(): void {
  backoffUntil.clear();
  backoffCount.clear();
  sweepInFlight = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

function armBackoff(taskId: string, now: number): void {
  const n = (backoffCount.get(taskId) ?? 0) + 1;
  backoffCount.set(taskId, n);
  backoffUntil.set(taskId, now + Math.min(60, 5 * 2 ** (n - 1)) * 60_000);
}

/**
 * One sweep pass. Exported for tests and for manual invocation; never throws.
 * Returns what it did so callers/logs can see coverage.
 */
export async function sweepPlaceholderTitles(now = Date.now()): Promise<{
  candidates: number; attempted: number; retitled: number; errors: number;
}> {
  const stats = { candidates: 0, attempted: 0, retitled: 0, errors: 0 };
  if (sweepInFlight) {
    log.session.warn('title-reconciler: previous sweep still running — skipped this tick');
    return stats;
  }
  sweepInFlight = true;
  const seenThisPass = new Set<string>();
  const passStart = Date.now();
  try {
    const { listTasksSlim } = await import('./task-manager.js');
    const { defaultSessionTaskTitle } = await import('./sessions/quick-start.js');
    const { getSessionsForTask } = await import('./session-tracker.js');
    const { autoTitleFromObservedMessage } = await import('./session-hooks/builtins.js');

    // Cheap textual prefilter first; the exact placeholder check (which needs
    // the sessions' cwds too) runs only on the survivors. Slim minimal
    // projection: the full listTasks() drags note/description/ext for every
    // row through the event loop (the session-health-monitor learned this at
    // 3493 rows/tick); the sweep needs only id/title/status/created_at/cwd.
    const suspects = (await listTasksSlim({ minimal: true })).filter((t) =>
      t.status !== 'done'
      && (t.title ?? '').startsWith('Session: ')
      && now - new Date(t.created_at).getTime() < MAX_TASK_AGE_MS);

    let deadlineHit = false;
    for (const task of suspects) {
      // Per-task isolation: one task's daemon hang / store hiccup must not
      // starve the rest of the pass.
      let armed = false;
      try {
        if (Date.now() - passStart > PASS_SOFT_DEADLINE_MS) {
          // Preserve pacing state for everything not reached this pass.
          seenThisPass.add(task.id);
          deadlineHit = true;
          continue;
        }
        const sessions = (await getSessionsForTask(task.id)).filter((s) => !s.archived);
        if (!sessions.length) continue;
        const isPlaceholder = [task.cwd, ...sessions.map((s) => s.cwd)]
          .filter((c): c is string => !!c)
          .some((c) => task.title === defaultSessionTaskTitle(c));
        if (!isPlaceholder) continue;
        stats.candidates++;
        seenThisPass.add(task.id);
        if ((backoffUntil.get(task.id) ?? 0) > now) continue;
        if (stats.attempted >= MAX_ATTEMPTS_PER_SWEEP) continue; // count remaining candidates, attempt next pass
        // Arm backoff BEFORE the attempt: history reads and model calls cost
        // real time/money even when they fail.
        armBackoff(task.id, now);
        armed = true;
        stats.attempted++;

        // Most recently active session first (freshest JSONL); fall through to
        // older sessions when the newest has no readable user message yet.
        // Message sources, in order of fidelity: the session JSONL (what the
        // CLI actually received), then the disk message queue (a launch whose
        // CLI never spawned leaves its message stranded in 'pending' — the
        // only source that exists in that failure mode).
        const ordered = [...sessions].sort((a, b) =>
          (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
        let titled = false;
        for (const session of ordered) {
          const message = (await firstUserMessage(session, task.cwd))
            || (await firstQueuedMessage(session.claudeSessionId));
          if (!message) continue;
          titled = await autoTitleFromObservedMessage(
            session.claudeSessionId, task.id, message,
            // noColdAttach: the sweep's premise is a possibly-dead session —
            // it must never pay an ACP worker cold-spawn per attempt (up to 10
            // sequential ones per pass). preferBackend: a background sweep
            // spends the bounded fast model, never minutes of main-model
            // side_questions; already-live channels remain the fallback for
            // zero-Walnut-credential setups.
            { maxAttempts: SWEEP_MAX_ATTEMPTS, noColdAttach: true, preferBackend: true });
          break; // one attempt per pass — the backoff owns retry pacing
        }
        if (titled) {
          stats.retitled++;
          backoffUntil.delete(task.id);
          backoffCount.delete(task.id);
          log.session.info('title-reconciler: retitled placeholder task', { taskId: task.id });
        } else {
          log.session.info('title-reconciler: attempt did not title — backoff armed', {
            taskId: task.id, nextTryInMs: (backoffUntil.get(task.id) ?? now) - now,
          });
        }
      } catch (err) {
        stats.errors++;
        // The throw may have landed before this task was registered: protect
        // its pacing state from the prune below, and make the failure cost a
        // backoff step (unless the attempt already armed one) so an
        // intermittently-failing task can't be retried at full tick rate with
        // its curve silently reset.
        seenThisPass.add(task.id);
        if (!armed) armBackoff(task.id, now);
        log.session.warn('title-reconciler: task pass failed — continuing sweep', {
          taskId: task.id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (deadlineHit) {
      log.session.warn('title-reconciler: pass hit its soft deadline — remaining candidates deferred to the next tick', {
        deadlineMs: PASS_SOFT_DEADLINE_MS, ...stats,
      });
    }

    // Prune pacing state for tasks that left the candidate set (titled by any
    // path, completed, aged out, deleted) — the maps must track only live work.
    for (const key of [...backoffUntil.keys()]) {
      if (!seenThisPass.has(key)) { backoffUntil.delete(key); backoffCount.delete(key); }
    }

    if (stats.candidates > 0) {
      log.session.info('title-reconciler: sweep done', stats);
    }
  } catch (err) {
    stats.errors++;
    log.session.warn('title-reconciler: sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    sweepInFlight = false;
  }
  return stats;
}

/** Pick the title source from candidate user texts (in transcript order):
 *  the first SUBSTANTIVE one — not a slash command, not an automation nudge,
 *  ≥8 chars after the image-prefix strip — falling back to the first non-slash
 *  message so a terse-but-real request still gets a (vague) title rather than
 *  none. Slash commands are excluded even from the fallback:
 *  autoTitleFromObservedMessage hard-rejects them anyway, so returning one
 *  would only burn an attempt per backoff cycle for the whole 48h window. */
function pickTitleSource(texts: string[]): string {
  const notSlash = (t: string) => {
    const stripped = t.replace(/^\[Images attached[^\]]*\]\n(?:- \S[^\n]*\n)*\n?/, '').trim();
    return stripped && !/^\/[a-z][\w-]*(\s|$)/i.test(stripped) ? stripped : '';
  };
  const substantive = texts.find((t) => {
    const stripped = notSlash(t);
    return stripped.length >= 8 && !NUDGE_RE.test(stripped);
  });
  return substantive ?? texts.find((t) => !!notSlash(t)) ?? '';
}

/** First substantive user message from the session's history (host-aware,
 *  delivery-path independent). Raw text — autoTitleFromObservedMessage owns
 *  the image-prefix strip and the final slash-command gate.
 *  Provider-shaped read: ACP (codex) history lives in the worker journal —
 *  routing a codex sid into the native JSONL reader burns the full 30s daemon
 *  read timeout on a file that never exists (2026-08-10 incident).
 *  Known limitation: the native reader returns the LAST ~4MB window, so on a
 *  whale JSONL (placeholder survived hours of heavy work) the "first" message
 *  is really the earliest one still in the tail — a mid-session user message.
 *  Accepted: it is still the user's own words for this session, and a vague
 *  title beats a placeholder; a head-window reader isn't worth building for
 *  this edge. */
async function firstUserMessage(
  session: import('./types.js').SessionRecord,
  taskCwd?: string,
): Promise<string> {
  try {
    let history;
    if (session.engine === 'codex') {
      const { readAcpSessionHistory } = await import('../providers/acp-session-history.js');
      history = await readAcpSessionHistory(session);
    } else {
      const { readSessionHistoryTail } = await import('./session-history.js');
      history = await readSessionHistoryTail(
        session.claudeSessionId, session.cwd ?? taskCwd, session.host, session.outputFile);
    }
    const userTexts = (history ?? [])
      .filter((m) => m.role === 'user' && m.text.trim())
      .map((m) => m.text.trim());
    return pickTitleSource(userTexts);
  } catch (err) {
    // Visible, not silent: a wedged daemon read looks identical to "no message
    // yet" from the stats — this warn is the ops signal that distinguishes them.
    log.session.warn('title-reconciler: history read failed — will retry after backoff', {
      sessionId: session.claudeSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/** Queued (pending/processing) messages for a session — the message source of
 *  last resort, for launches whose CLI never wrote a JSONL. Same substantive
 *  picker as the history path: the stranded queue can just as easily lead with
 *  an auto-continue "continue" that must not become the title. */
async function firstQueuedMessage(sessionId: string): Promise<string> {
  try {
    const { getQueue } = await import('./session-message-queue.js');
    const rows = (await getQueue(sessionId)).filter((m) => m.status !== 'parked');
    return pickTitleSource(rows.map((m) => (m.message ?? '').trim()).filter(Boolean));
  } catch {
    return '';
  }
}

/**
 * Start the periodic sweep. No-op on test servers (a background retitle mid-
 * assertion is a flake), on cloud replicas, and when explicitly disabled.
 * Safe to call more than once.
 */
export function startSessionTitleReconciler(): void {
  if (timer) return;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test') return;
  // The Playwright fixture server is a REAL server that sets only
  // WALNUT_DISABLE_BACKGROUND_AI=1 (tests/e2e/browser/test-server.ts) — the
  // gate above misses it, and a sweep retitling a quick-start task mid-spec is
  // exactly the flake this function's contract forbids. backgroundAiDisabled()
  // is also the right call for constrained deployments: the sweep's primary
  // channel IS an unprompted background model call.
  if (backgroundAiDisabled()) return;
  if (CLOUD_MODE) return;
  if (process.env.WALNUT_DISABLE_TITLE_RECONCILER === '1') return;

  // The next tick is armed BEFORE the pass runs: a pass that hangs forever
  // (wedged daemon read) delays nothing — the in-flight guard skips overlap
  // and the clock keeps ticking.
  const tick = () => {
    timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    timer.unref?.();
    void sweepPlaceholderTitles();
  };
  timer = setTimeout(tick, FIRST_SWEEP_DELAY_MS);
  timer.unref?.();
  log.session.info('title-reconciler: started', {
    intervalMs: SWEEP_INTERVAL_MS, maxTaskAgeMs: MAX_TASK_AGE_MS,
    maxAttemptsPerSweep: MAX_ATTEMPTS_PER_SWEEP,
  });
}
