/**
 * Interaction timer: one click, measured to the first painted frame.
 *
 * Reported 2026-09-02: "I open the file tab and click outside to get out, and it
 * takes like 3 s — do you have a log?" There was none, which is the bug this
 * file guards against coming back. What it pins: the number spans click → the
 * frame after the paint (two rAFs, not one), a felt delay is a warning while a
 * fast one is info, and the per-minute cap holds (a wedged UI must not turn its
 * own logger into the load).
 *
 * And, since 2026-09-03, the part that cost hours: a big number is NOT proof of a
 * freeze. rAF measures "time until the page next painted", and a WKWebView stops
 * painting when its window is occluded — so clicking something and then switching
 * to another app reported a 29.9-SECOND close for work the app had already
 * finished. Every slow report therefore carries `frames`/`wakeups`/`hidden` and a
 * `verdict`: timers keep firing (throttled) in the background while a blocked main
 * thread runs nothing, so those two counters separate the cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { traceInteraction, _resetInteractionTimer } from '../../web/src/utils/interaction-timer';

/**
 * `tick`/`wake` ADVANCE THE CLOCK, because the verdict is derived from the longest
 * silence between beats. Firing 30 wakeups at one instant and then jumping 30s
 * forward is not an occluded page, it is a page that stalled for 30s — and a
 * harness that models it that way would test the opposite of what it claims to.
 */
function harness(startAt = 1000, opts: { hidden?: boolean; frameMs?: number; wakeMs?: number } = {}) {
  let t = startAt;
  const frameMs = opts.frameMs ?? 16;
  // Background timers are throttled to roughly 1/s rather than the 250ms cadence.
  const wakeMs = opts.wakeMs ?? (opts.hidden ? 1000 : 250);
  const frames: Array<() => void> = [];
  const ticks: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const reports: Array<{ level: string; payload: Record<string, unknown> }> = [];
  return {
    setTime: (v: number) => { t = v; },
    paint: () => { while (frames.length) frames.shift()!(); },
    /** One display frame: the page painted once. */
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) { t += frameMs; const q = ticks.splice(0); q.forEach((f) => f()); }
    },
    /** One timer wakeup: the page is alive even if it is not painting. */
    wake: (n = 1) => {
      for (let i = 0; i < n; i++) { t += wakeMs; const q = timers.splice(0); q.forEach((f) => f()); }
    },
    reports,
    deps: {
      now: () => t,
      // Mirrors the real double-rAF: the callback runs after the paint.
      raf: (cb: () => void) => { frames.push(cb); },
      rafTick: (cb: () => void) => { ticks.push(cb); },
      timer: (cb: () => void) => { timers.push(cb); return timers.length; },
      clearTimer: () => { timers.length = 0; },
      hidden: () => opts.hidden === true,
      report: (level: 'info' | 'warn', payload: Record<string, unknown>) => { reports.push({ level, payload }); },
    },
  };
}

beforeEach(() => { _resetInteractionTimer(); });

describe('traceInteraction', () => {
  it('reports a felt interaction as a warning with its duration and meta', () => {
    const h = harness();
    traceInteraction('fullscreen-exit', { sessionId: 'abc' }, h.deps);
    h.setTime(4000);            // 3s later, like the report
    h.paint();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].level).toBe('warn');
    expect(h.reports[0].payload).toMatchObject({ name: 'fullscreen-exit', ms: 3000, sessionId: 'abc' });
  });

  it('reports a fast interaction at info level', () => {
    const h = harness();
    traceInteraction('view-open:files', {}, h.deps);
    h.setTime(1040);
    h.paint();
    expect(h.reports[0].level).toBe('info');
    expect(h.reports[0].payload.ms).toBe(40);
  });

  it('nothing is reported until the frame actually paints', () => {
    const h = harness();
    traceInteraction('view-close:files', {}, h.deps);
    expect(h.reports).toHaveLength(0);
    h.paint();
    expect(h.reports).toHaveLength(1);
  });

  it('a long wait with no frames and no wakeups is called a real block', () => {
    const h = harness();
    traceInteraction('fullscreen-exit', {}, h.deps);
    h.setTime(31_000);          // 30s, and nothing ran in between
    h.paint();
    expect(h.reports[0].payload).toMatchObject({
      ms: 30_000, frames: 0, wakeups: 0, stalledMs: 30_000, verdict: 'main-thread-blocked',
    });
  });

  it('a block is still a block when a few beats squeezed through', () => {
    // The real one, measured 2026-09-03 on the Files panel: 2,130ms in which 3
    // frames and 1 wakeup arrived. Counting zeroes called this "slow but painting";
    // it was a genuine freeze, and the user could not close the panel.
    const h = harness();
    traceInteraction('fullscreen-exit', {}, h.deps);
    h.tick(3);
    h.wake(1);
    h.setTime(3130);            // one contiguous ~2.8s stretch with nothing in it
    h.paint();
    expect(h.reports[0].payload.verdict).toBe('main-thread-blocked');
    expect(h.reports[0].payload.frames).toBe(3);
    // Most of the wait was one unbroken silence, which is the whole basis for the
    // verdict — so assert the proportion rather than a hand-computed millisecond.
    const { ms, stalledMs } = h.reports[0].payload as { ms: number; stalledMs: number };
    expect(stalledMs / ms).toBeGreaterThan(0.5);
  });

  it('a long wait whose timers kept firing while hidden is called page-hidden, not a block', () => {
    const h = harness(1000, { hidden: true });
    traceInteraction('fullscreen-exit', {}, h.deps);
    // The window is occluded: rAF is throttled to nothing, timers keep ticking at
    // roughly 1/s — a regular cadence, so no long stretch of total silence.
    h.wake(30);
    h.paint();
    expect(h.reports[0].payload).toMatchObject({ frames: 0, verdict: 'page-hidden', hidden: true });
    expect(h.reports[0].payload.wakeups).toBeGreaterThan(0);
    expect(h.reports[0].payload.stalledMs as number).toBeLessThan(2000);
  });

  it('a long wait that kept painting is slow work, not a stall', () => {
    const h = harness();
    traceInteraction('view-open:files', {}, h.deps);
    for (let i = 0; i < 8; i++) { h.tick(15); h.wake(1); }
    h.paint();
    expect(h.reports[0].payload).toMatchObject({ verdict: 'slow-but-painting' });
    expect(h.reports[0].payload.frames).toBe(120);
  });

  it('a fast interaction carries no verdict or counters (they would only be noise)', () => {
    const h = harness();
    traceInteraction('view-open:files', {}, h.deps);
    h.setTime(1040);
    h.paint();
    expect(h.reports[0].payload.verdict).toBeUndefined();
    expect(h.reports[0].payload.frames).toBeUndefined();
  });

  it('caps the reports per minute, and the window slides', () => {
    const h = harness();
    for (let i = 0; i < 40; i++) { traceInteraction(`i${i}`, {}, h.deps); }
    h.paint();
    expect(h.reports).toHaveLength(30);
    h.setTime(62_000);
    traceInteraction('after-window', {}, h.deps);
    h.paint();
    expect(h.reports.at(-1)?.payload.name).toBe('after-window');
  });
});
