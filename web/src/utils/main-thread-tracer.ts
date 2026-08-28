/**
 * Main-thread tracer — Firefox-safe replacement for the longtask observer,
 * with PHASE ATTRIBUTION.
 *
 * Why it exists: the 2026-07-23 slow-load investigation showed requests whose
 * network time was 233ms being logged as "→ 200 in 9915ms" — the delta is the
 * main thread being blocked, so fetch callbacks (and everything else) queued
 * for ~10s. `longtask-monitor.ts` would have named the culprit, but Firefox
 * doesn't implement the `longtask` PerformanceObserver entry type, so on
 * Firefox we were blind. This tracer needs no observer API:
 *
 *   1. LAG SAMPLER — a self-scheduling setTimeout chain. When a wakeup
 *      arrives ≥250ms late, the main thread was blocked for ~that long.
 *   2. PHASE REGISTRY — boot/init/render code brackets itself with
 *      startPhase()/endPhase() (or tracePhase()). When a block is detected,
 *      the log line carries the phases ACTIVE during the block and the ones
 *      recently ended — turning "something blocked for 10s" into
 *      "react-mount was running while the 10s block happened".
 *
 * Logs via console.warn → browser-logger → server log, same as longtask
 * lines, so blocks self-identify in /tmp/open-walnut/open-walnut-<date>.log.
 */

import { installCallbackTracing, slowCallbacksSince } from './trace-dispatchers';

const SAMPLE_INTERVAL_MS = 100;
const REPORT_THRESHOLD_MS = 250;
const RECENT_PHASE_BUFFER = 8;
const MAX_REPORTS_PER_MIN = 12;

interface ActivePhase { name: string; startedAt: number }
interface EndedPhase { name: string; startedAt: number; endedAt: number }

const active: ActivePhase[] = [];
const recentlyEnded: EndedPhase[] = [];

/** Mark the beginning of a traced phase (boot step, heavy render, parse). */
export function startPhase(name: string): void {
  active.push({ name, startedAt: performance.now() });
}

/** Mark the end of a traced phase. Name must match the startPhase call. */
export function endPhase(name: string): void {
  const idx = active.findIndex((p) => p.name === name);
  if (idx < 0) return;
  const [phase] = active.splice(idx, 1);
  recentlyEnded.push({ name: phase.name, startedAt: phase.startedAt, endedAt: performance.now() });
  if (recentlyEnded.length > RECENT_PHASE_BUFFER) recentlyEnded.shift();
}

/** Bracket a synchronous step. The phase shows up in block attribution. */
export function tracePhase<T>(name: string, fn: () => T): T {
  startPhase(name);
  try {
    return fn();
  } finally {
    endPhase(name);
  }
}

/** Bracket an async step (the phase stays active across awaits). */
export async function tracePhaseAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  startPhase(name);
  try {
    return await fn();
  } finally {
    endPhase(name);
  }
}

function describePhases(blockStart: number): { active: string[]; recent: string[] } {
  const activeNames = active.map(
    (p) => `${p.name}(+${Math.round(performance.now() - p.startedAt)}ms)`,
  );
  // A phase that ENDED during/after the block window very likely contains the
  // blocking work (sync work ends before our late wakeup runs).
  const recent = recentlyEnded
    .filter((p) => p.endedAt >= blockStart)
    .map((p) => `${p.name}(${Math.round(p.endedAt - p.startedAt)}ms)`);
  return { active: activeNames, recent };
}

export function initMainThreadTracer(): void {
  if (typeof window === 'undefined') return;
  installCallbackTracing();

  let windowStart = Date.now();
  let reportsThisWindow = 0;
  let suppressed = 0;
  let suppressedTotalMs = 0;
  let expectedAt = performance.now() + SAMPLE_INTERVAL_MS;

  // Background-tab guard: browsers throttle hidden-tab timers to ≥1/min, so a
  // backgrounded tab reports fake "blocks" of 30-200+s (2026-07-24: 42 bogus
  // >30s reports, worst 211s, all at page-age 70+min — tab was just hidden).
  // Skip reporting while hidden AND for one tick after becoming visible (the
  // first wakeup still carries the throttled gap).
  let visibleSince = document.visibilityState === 'visible' ? 0 : Infinity;
  document.addEventListener('visibilitychange', () => {
    visibleSince = document.visibilityState === 'visible' ? performance.now() : Infinity;
  });

  const tick = (): void => {
    const now = performance.now();
    const lateBy = now - expectedAt;
    const hiddenOrJustShown = document.visibilityState !== 'visible'
      || now - visibleSince < SAMPLE_INTERVAL_MS + REPORT_THRESHOLD_MS;

    if (lateBy >= REPORT_THRESHOLD_MS && !hiddenOrJustShown) {
      const blockStart = expectedAt - SAMPLE_INTERVAL_MS;
      const wallNow = Date.now();
      if (wallNow - windowStart > 60_000) {
        if (suppressed > 0) {
          console.warn('[perf] main-thread block (suppressed summary)', {
            count: suppressed, totalMs: Math.round(suppressedTotalMs),
          });
        }
        windowStart = wallNow;
        reportsThisWindow = 0;
        suppressed = 0;
        suppressedTotalMs = 0;
      }
      if (reportsThisWindow < MAX_REPORTS_PER_MIN) {
        reportsThisWindow++;
        const { active: activeNames, recent } = describePhases(blockStart);
        const slowCbs = slowCallbacksSince(blockStart);
        console.warn('[perf] main-thread block', {
          blockedMs: Math.round(lateBy),
          sincePageLoadMs: Math.round(now),
          activePhases: activeNames.length ? activeNames : undefined,
          endedDuringBlock: recent.length ? recent : undefined,
          slowCallbacks: slowCbs.length ? slowCbs : undefined,
          url: window.location.pathname,
        });
      } else {
        suppressed++;
        suppressedTotalMs += lateBy;
      }
    }

    expectedAt = performance.now() + SAMPLE_INTERVAL_MS;
    setTimeout(tick, SAMPLE_INTERVAL_MS);
  };

  setTimeout(tick, SAMPLE_INTERVAL_MS);
}
