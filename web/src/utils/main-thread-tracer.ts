/**
 * Main-thread tracer: a Firefox-safe replacement for the longtask observer,
 * with PHASE ATTRIBUTION.
 *
 * Why it exists: the 2026-07-23 slow-load investigation showed requests whose
 * network time was 233ms being logged as "200 in 9915ms": the delta is the
 * main thread being blocked, so fetch callbacks (and everything else) queued
 * for ~10s. `longtask-monitor.ts` would have named the culprit, but Firefox and
 * WebKit don't implement the `longtask` PerformanceObserver entry type. This
 * tracer needs no observer API:
 *
 *   1. LAG SAMPLER: a 100ms timer, re-armed after every wakeup. A wakeup that
 *      arrives 250ms or more late means the main thread was blocked for about
 *      that long.
 *   2. PHASE REGISTRY: boot/init/render code brackets itself with
 *      startPhase()/endPhase() (or tracePhase()). A block report carries the
 *      phases ACTIVE during the block and the ones that ended in it, plus the
 *      slow callbacks trace-dispatchers.ts timed. A block nothing traced explains
 *      carries what else happened (block-context.ts: draws, DOM mutations, focus,
 *      last input).
 *
 * Timer alignment (the Mac app's WKWebView, 2026-11-23: 143 reports in a day, most
 * while nobody used the window): WebKit aligns a visually idle page's timers to 1s,
 * but only timers nested 10 deep (a setTimeout armed from a timer callback, again
 * and again: exactly a sampler chain). So the sampler re-arms from a MessageChannel
 * message, a task that is not a timer: every timer it arms has nesting level 0 and
 * is never aligned, and a late wakeup means a busy thread again. The hop costs
 * about 10 wakeups a second where WebKit would coalesce to about 1, so it runs only
 * while someone may be using the page: a hidden page, or an unfocused window with no
 * input for IDLE_PLAIN_TIMER_MS, re-arms from the timer directly and lets the browser
 * throttle and align it (hidden pages are not reported anyway). Focus or input brings
 * the hop back at the next sample. timer-alignment.ts classifies what alignment is
 * left: aligned wakeups are counted in "timers throttled", never reported as blocks.
 *
 * Logs via console.warn to browser-logger to the server log, so blocks
 * self-identify in /tmp/open-walnut/open-walnut-<date>.log.
 */

import { installCallbackTracing, slowCallbacksSince } from './trace-dispatchers';
import { describeUntracedBlock, installBlockContext, lastInputAt, takeTickWindow } from './block-context';
import { createAlignmentFilter } from './timer-alignment';
import { beaconFlush } from './browser-logger';
import { log } from './log';

const SAMPLE_INTERVAL_MS = 100;
const REPORT_THRESHOLD_MS = 250;
const RECENT_PHASE_BUFFER = 8;
const MAX_REPORTS_PER_MIN = 12;
// Input this long before a block's window counts as the user interacting: such a
// block is always reported, even if it lands on the alignment phase.
const INPUT_GRACE_MS = 1000;
// An unfocused window with no input this long gets plain timers (see the header).
const IDLE_PLAIN_TIMER_MS = 30_000;

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

type BlockReport = Record<string, unknown>;

export function initMainThreadTracer(): void {
  if (typeof window === 'undefined') return;
  installCallbackTracing();
  installBlockContext();

  let windowStart = Date.now();
  let reportsThisWindow = 0;
  let suppressed = 0;
  let suppressedTotalMs = 0;
  let expectedAt = 0;

  const report = (block: BlockReport): void => {
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
      console.warn('[perf] main-thread block', block);
    } else {
      suppressed++;
      suppressedTotalMs += block.blockedMs as number;
    }
  };

  const alignment = createAlignmentFilter<BlockReport>({
    report,
    runStarted: (count, totalMs, at) => log.warn('perf', 'timers throttled (page idle)', {
      count, totalMs, sincePageLoadMs: Math.round(at), phaseMs: alignment.phase() ?? undefined,
    }),
    runEnded: (count, totalMs) => log.warn('perf', 'timers throttled ended', { count, totalMs }),
  });

  // Background-tab guard: browsers throttle hidden-tab timers to 1/min or less, so a
  // backgrounded tab reports fake "blocks" of 30-200+s (2026-07-24: 42 bogus
  // >30s reports, worst 211s, all at page-age 70+min: the tab was just hidden).
  // Skip reporting while hidden AND for one tick after becoming visible (the
  // first wakeup still carries the throttled gap).
  let visibleSince = document.visibilityState === 'visible' ? 0 : Infinity;
  document.addEventListener('visibilitychange', () => {
    visibleSince = document.visibilityState === 'visible' ? performance.now() : Infinity;
  });

  const tick = (): void => {
    const now = performance.now();
    const lateBy = now - expectedAt;
    const blockStart = expectedAt - SAMPLE_INTERVAL_MS;
    const win = takeTickWindow(); // per-sample counts, taken every tick
    const visible = document.visibilityState === 'visible';
    const plainTimers = !visible || (!hasFocus() && now - lastInputAt() > IDLE_PLAIN_TIMER_MS);
    alignment.keepPhaseAcrossRuns(visible && plainTimers); // alignment is expected only then

    if (!visible || now - visibleSince < SAMPLE_INTERVAL_MS + REPORT_THRESHOLD_MS) {
      alignment.onTime(); // a held wakeup is reported, a run ends: nothing pairs across a gap
    } else if (lateBy < REPORT_THRESHOLD_MS) {
      alignment.onTime();
    } else {
      const { active: activeNames, recent } = describePhases(blockStart);
      const slowCbs = slowCallbacksSince(blockStart);
      const traced = activeNames.length > 0 || recent.length > 0 || slowCbs.length > 0;
      const interacting = lastInputAt() >= blockStart - INPUT_GRACE_MS;
      alignment.late(now, lateBy, !traced && !interacting, {
        blockedMs: Math.round(lateBy),
        sincePageLoadMs: Math.round(now),
        activePhases: activeNames.length ? activeNames : undefined,
        endedDuringBlock: recent.length ? recent : undefined,
        slowCallbacks: slowCbs.length ? slowCbs : undefined,
        ...(traced ? {} : describeUntracedBlock(win, now)),
        url: window.location.pathname,
      });
    }
    rearm(!plainTimers);
  };

  // The hop that keeps WebKit from aligning the sampler (see the header).
  const Channel = (window as { MessageChannel?: typeof MessageChannel }).MessageChannel;
  const hop = typeof Channel === 'function' ? new Channel() : null;
  if (hop) hop.port1.onmessage = () => { setTimeout(tick, SAMPLE_INTERVAL_MS); };

  // expectedAt is set when the hop is posted, so a block that delays the hop
  // itself still counts as lateness.
  const rearm = (useHop: boolean): void => {
    expectedAt = performance.now() + SAMPLE_INTERVAL_MS;
    if (hop && useHop) hop.port2.postMessage(0);
    else setTimeout(tick, SAMPLE_INTERVAL_MS);
  };

  // A held wakeup would be lost with the page: report it, then send it (the
  // logger's own pagehide flush ran already; a second one sends only this).
  window.addEventListener?.('pagehide', () => {
    alignment.onTime();
    beaconFlush();
  });

  rearm(document.visibilityState === 'visible');
}

function hasFocus(): boolean {
  try { return typeof document.hasFocus === 'function' ? document.hasFocus() : true; } catch { return true; }
}
