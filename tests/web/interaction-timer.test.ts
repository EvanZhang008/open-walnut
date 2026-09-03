/**
 * Interaction timer: one click, measured to the first painted frame.
 *
 * Reported 2026-09-02: "I open the file tab and click outside to get out, and it
 * takes like 3 s — do you have a log?" There was none, which is the bug this
 * file guards against coming back. What it pins: the number spans click → the
 * frame after the paint (two rAFs, not one), a felt delay is a warning while a
 * fast one is info, and the per-minute cap holds (a wedged UI must not turn its
 * own logger into the load).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { traceInteraction, _resetInteractionTimer } from '../../web/src/utils/interaction-timer';

function harness(startAt = 1000) {
  let t = startAt;
  const frames: Array<() => void> = [];
  const reports: Array<{ level: string; payload: Record<string, unknown> }> = [];
  return {
    setTime: (v: number) => { t = v; },
    paint: () => { while (frames.length) frames.shift()!(); },
    reports,
    deps: {
      now: () => t,
      // Mirrors the real double-rAF: the callback runs after the paint.
      raf: (cb: () => void) => { frames.push(cb); },
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
