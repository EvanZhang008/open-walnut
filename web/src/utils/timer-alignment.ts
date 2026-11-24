/**
 * Tells WebKit timer alignment from a blocked main thread, for the lag sampler in
 * main-thread-tracer.ts.
 *
 * WebKit (the Mac app's WKWebView) aligns the timers of a visually idle page: a
 * setTimeout chain nested 10 deep fires only on `k * 1s + offset`, where `offset` is
 * one random fraction of the interval per WebContent process
 * (`ScriptExecutionContext::alignedFireTime`, `Document::domTimerAlignmentInterval`).
 * The sampler then wakes up to ~900ms late with nothing running. Other intervals:
 * 30ms (low power mode, cross-origin frames) is under the report threshold, and the
 * growing interval of a hidden page never reaches us (hidden pages are skipped).
 * So on one page load the aligned wake times share ONE phase mod 1000ms.
 *
 * The sampler re-arms itself from a message task so WebKit should not align it at
 * all (see main-thread-tracer.ts); this filter is the net for any engine or build
 * that still does. A late wakeup is "quiet" when nothing traced ran in its window
 * and the user gave no input. A quiet one is alignment when:
 *   - it lands on the learned phase (a few ms of tolerance, the phase follows drift);
 *   - it is the tick right after an aligned one and comes no later than the next
 *     aligned point (a held timer released early when throttling turned off);
 *   - the next tick lands exactly one interval after it (the first two ticks of a
 *     run, before any phase is known). That is why a quiet late wakeup is held back
 *     for one tick before it is reported; the pair also teaches the phase.
 * A wakeup that is not quiet (traced work, input) is never absorbed, and neither is
 * one later than an interval (plus tolerance): alignment never holds a timer longer.
 * The phase lives as long as its run, except while the sampler runs on plain timers
 * on purpose (`keepPhaseAcrossRuns(true)`: an unfocused, idle window), where aligned
 * runs are expected and the next run's first tick is caught by the phase alone.
 */

export const ALIGNMENT_INTERVAL_MS = 1000;
// Wake time minus aligned fire time: the dispatch takes 0 to ~15ms, never negative.
// The learned phase itself carries up to that much dispatch latency, so a wake on the
// true phase can read as up to 15ms early: the window is symmetric.
const PHASE_EARLY_TOL_MS = 15;
const PHASE_LATE_TOL_MS = 15;
const MAX_ALIGNED_LATE_MS = ALIGNMENT_INTERVAL_MS + PHASE_LATE_TOL_MS;

export interface AlignmentSink<T> {
  /** A block to report (rate limiting is the caller's). */
  report(item: T): void;
  /** An aligned run began; `count` and `totalMs` include a held wakeup it confirmed. */
  runStarted(count: number, totalMs: number, at: number): void;
  runEnded(count: number, totalMs: number): void;
}

export interface AlignmentFilter<T> {
  /** A tick that was on time (or the page goes away): releases a held wakeup as a block, ends a run. */
  onTime(): void;
  /** A late tick. `quiet`: nothing traced ran in its window and no input came. */
  late(at: number, lateBy: number, quiet: boolean, item: T): void;
  /** The learned phase (ms mod the interval), or null. For tests and logs. */
  phase(): number | null;
  /** Keep the phase when a run ends (true only while alignment is expected); false forgets it now. */
  keepPhaseAcrossRuns(keep: boolean): void;
}

const mod = (v: number, m: number): number => ((v % m) + m) % m;

export function createAlignmentFilter<T>(sink: AlignmentSink<T>): AlignmentFilter<T> {
  let phase: number | null = null;
  let held: { at: number; lateBy: number; item: T } | null = null;
  let lastAlignedAt: number | null = null;
  let runCount = 0;
  let runMs = 0;
  let keepPhase = false;

  /** Signed distance from the phase to `at`, in (-interval/2, interval/2]. */
  const offPhase = (at: number, p: number): number => {
    const d = mod(at - p, ALIGNMENT_INTERVAL_MS);
    return d > ALIGNMENT_INTERVAL_MS / 2 ? d - ALIGNMENT_INTERVAL_MS : d;
  };
  const onPhase = (at: number): boolean => {
    if (phase === null) return false;
    const d = offPhase(at, phase);
    return d >= -PHASE_EARLY_TOL_MS && d <= PHASE_LATE_TOL_MS;
  };
  /** `b`, the tick right after `a`, lands one interval after it: both on one phase. */
  const oneIntervalApart = (a: number, b: number): boolean =>
    Math.abs(b - a - ALIGNMENT_INTERVAL_MS) <= PHASE_LATE_TOL_MS;
  /**
   * A wake time is the aligned fire time plus a few ms of dispatch, so the earliest
   * sample is the truest: move to an earlier one at once, toward a later one by a
   * quarter (slow drift is followed, one slow dispatch does not drag the phase).
   */
  const learn = (at: number): void => {
    if (phase === null) { phase = mod(at, ALIGNMENT_INTERVAL_MS); return; }
    const d = offPhase(at, phase);
    phase = mod(phase + (d < 0 ? d : d / 4), ALIGNMENT_INTERVAL_MS);
  };

  const releaseHeld = (): void => {
    if (held) sink.report(held.item);
    held = null;
  };
  const endRun = (): void => {
    if (runCount > 0) sink.runEnded(runCount, Math.round(runMs));
    runCount = 0;
    runMs = 0;
    lastAlignedAt = null;
    if (!keepPhase) phase = null;
  };
  const absorb = (at: number, count: number, totalMs: number): void => {
    const started = runCount === 0;
    runCount += count;
    runMs += totalMs;
    lastAlignedAt = at;
    if (started) sink.runStarted(runCount, Math.round(runMs), at);
  };

  return {
    onTime() {
      releaseHeld();
      endRun();
    },
    late(at, lateBy, quiet, item) {
      if (!quiet || lateBy > MAX_ALIGNED_LATE_MS) {
        releaseHeld();
        endRun();
        sink.report(item);
        return;
      }
      if (held && oneIntervalApart(held.at, at)) {
        // The first two ticks of a run: the held one and this one, one interval apart.
        phase = null;
        learn(held.at);
        learn(at);
        const h = held;
        held = null;
        absorb(at, 2, h.lateBy + lateBy);
        return;
      }
      if (onPhase(at)) {
        learn(at);
        releaseHeld(); // not on the phase itself, or it would have been absorbed
        absorb(at, 1, lateBy);
        return;
      }
      if (lastAlignedAt !== null && at <= lastAlignedAt + ALIGNMENT_INTERVAL_MS + PHASE_LATE_TOL_MS) {
        // The timer was held for the next aligned point and fired early: alignment
        // was switched off on the way (the user came back). Not a phase sample.
        absorb(at, 1, lateBy);
        return;
      }
      releaseHeld();
      endRun();
      held = { at, lateBy, item };
    },
    phase: () => phase,
    keepPhaseAcrossRuns(keep) {
      keepPhase = keep;
      if (!keep && runCount === 0) phase = null;
    },
  };
}
