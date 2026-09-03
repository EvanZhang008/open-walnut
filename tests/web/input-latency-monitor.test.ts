/**
 * Input-latency monitor: keystroke → paint latency per 30s window, tagged
 * mac-app vs browser. What this pins: the aggregation is right, slow windows
 * are reported at once while quiet ones are reported once per five minutes
 * (a baseline must exist to compare a bad window against), non-editable
 * targets are ignored, and the client detection keys off the Mac app's
 * native bridges and nothing else.
 */
import { describe, it, expect } from 'vitest';
import {
  summarize, isSlowWindow, detectInputClient, initInputLatencyMonitor, type LatencyWindow,
} from '../../web/src/utils/input-latency-monitor';

class FakeDoc {
  listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, l: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (e: Event) => void) { this.listeners.get(type)?.delete(l); }
  emit(type: string, e: Partial<Event>) { for (const l of this.listeners.get(type) ?? []) l(e as Event); }
}

describe('summarize / isSlowWindow', () => {
  it('computes p50/p95/max and counts felt keystrokes', () => {
    const paint = [10, 12, 15, 20, 30, 40, 50, 60, 120, 400];
    const s = summarize(paint, paint.map((v) => v / 2));
    expect(s.n).toBe(10);
    expect(s.p50).toBe(40);
    expect(s.p95).toBe(400);
    expect(s.max).toBe(400);
    expect(s.slow).toBe(2);
    expect(s.queueP95).toBe(200);
    expect(isSlowWindow(s)).toBe(true);
  });

  it('a smooth window is not slow', () => {
    const s = summarize([8, 9, 10, 11, 12, 14, 16, 18], [1, 1, 1, 1, 1, 1, 1, 1]);
    expect(isSlowWindow(s)).toBe(false);
    expect(s.slow).toBe(0);
  });
});

describe('detectInputClient', () => {
  it('is mac-app only when the desktop bridges exist', () => {
    expect(detectInputClient({} as Window)).toBe('browser');
    expect(detectInputClient({ webkit: { messageHandlers: {} } } as unknown as Window)).toBe('browser');
    expect(detectInputClient({ webkit: { messageHandlers: { walnutChrome: {} } } } as unknown as Window)).toBe('mac-app');
  });
});

describe('initInputLatencyMonitor', () => {
  function harness() {
    let t = 1000;
    const reports: Array<LatencyWindow & { client: string; reason: string }> = [];
    const rafs: Array<() => void> = [];
    const doc = new FakeDoc();
    // `window`/`performance` exist in the vitest node env? Guard: the monitor
    // returns a no-op without them, so provide globals for the duration.
    const g = globalThis as Record<string, unknown>;
    const hadWindow = 'window' in g;
    if (!hadWindow) g.window = { location: { pathname: '/x' } };
    if (!('performance' in g)) g.performance = { now: () => t };
    const stop = initInputLatencyMonitor({
      now: () => t,
      raf: (cb) => { rafs.push(cb); },
      report: (s) => { reports.push(s); },
      client: 'mac-app',
      target: doc,
    });
    const key = (timeStamp: number, editable = true) => {
      doc.emit('keydown', { timeStamp, target: editable ? { tagName: 'TEXTAREA' } : { tagName: 'DIV' } } as unknown as Partial<Event>);
    };
    const paintAll = () => { while (rafs.length) rafs.shift()!(); };
    return {
      reports, key, paintAll, setTime: (v: number) => { t = v; }, stop,
      cleanup: () => { stop(); if (!hadWindow) delete g.window; },
    };
  }

  it('ignores keys outside editable elements and reports a slow window at once', () => {
    const h = harness();
    // 6 keystrokes; the key waited 5ms, painted 300ms later (a visibly late glyph).
    for (let i = 0; i < 6; i++) {
      h.setTime(1000 + i * 10 + 5); h.key(1000 + i * 10); h.setTime(1000 + i * 10 + 300); h.paintAll();
    }
    h.setTime(2000); h.key(1999, false); h.paintAll();   // non-editable: not counted
    // Window flushes on the first paint past 30s.
    h.setTime(40_000); h.key(39_990); h.setTime(40_010); h.paintAll();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ client: 'mac-app', reason: 'slow', n: 7, slow: 6 });
    h.cleanup();
  });

  it('a smooth window is reported only on the five-minute cadence', () => {
    const h = harness();
    const type = (base: number) => {
      for (let i = 0; i < 6; i++) {
        h.setTime(base + i * 10 + 1); h.key(base + i * 10); h.setTime(base + i * 10 + 12); h.paintAll();
      }
    };
    type(1000);
    h.setTime(40_000); h.key(39_990); h.setTime(40_005); h.paintAll();   // flush #1: smooth, too soon → silent
    expect(h.reports).toHaveLength(0);
    type(41_000);
    h.setTime(400_000); h.key(399_990); h.setTime(400_005); h.paintAll(); // flush #2: > 5 min since start → periodic
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].reason).toBe('periodic');
    h.cleanup();
  });

  it('drops a keystroke whose timestamp is from another clock', () => {
    const h = harness();
    // A timeStamp AHEAD of our clock (a different time base) would compute a
    // negative wait; those keys are dropped rather than logged as instant.
    for (let i = 0; i < 6; i++) { h.setTime(1000); h.key(1500); h.paintAll(); }
    h.setTime(40_000); h.key(39_990); h.setTime(40_010); h.paintAll();
    expect(h.reports).toHaveLength(0);                                      // 1 valid key < MIN_KEYS
    h.cleanup();
  });
});
