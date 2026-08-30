/**
 * Human time ACCRUAL invariants, proven through the INSTALLER — the impure half:
 * real DOM signals bubbling to the real document listeners, the real 30s flush
 * interval, and a real multi-hour gap.
 *
 * time-tracking-lease.test.ts already pins the pure state machine. This file
 * exists because the doubt that prompted it was about the WIRING, not the
 * arithmetic ("I never worked 8 hours"):
 *
 *   (a) a parked cursor, and a laptop that SLEEPS for hours, must bank at most
 *       ONE lease. The dangerous implementation is a flush that computes
 *       `now - lastFlush`, which turns a 3h sleep into one 3h slice; the audit
 *       this test enforces is that every duration is capped by the lease window.
 *   (b) two panels must never both accrue the same wall-clock second: banked
 *       windows are contiguous and non-overlapping across a context switch.
 *
 * linkedom gives a real-enough DOM (bubbling, closest, instanceof Element); the
 * clock is injected, so nothing here reads a real timer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  FLUSH_INTERVAL_MS, installTimeTracker, LEASE_MS, type TimeSample,
} from '@/utils/time-tracking';

const T0 = 1_800_000_000_000; // fixed epoch ms

const HTML = `<body>
  <div class="todo-panel-item" data-task-id="t_alpha"><span id="alpha">alpha</span></div>
  <div class="todo-panel-item" data-task-id="t_beta"><span id="beta">beta</span></div>
</body>`;

let clock = T0;
let sent: TimeSample[] = [];
let uninstall: () => void = () => {};
let dom: ReturnType<typeof parseHTML>;

/** Fire a real keydown on a real element, bubbling to the document listener. */
function signal(id: string): void {
  const el = dom.document.getElementById(id);
  if (!el) throw new Error(`fixture missing #${id}`);
  el.dispatchEvent(new dom.window.Event('keydown', { bubbles: true }));
}

/**
 * Time passes AND timers fire — an awake machine. Stepped so each interval tick
 * observes a clock close to its own firing time (one jumbo jump would let a
 * broken implementation look fine).
 */
function elapse(totalMs: number, stepMs = 1_000): void {
  for (let left = totalMs; left > 0; left -= stepMs) {
    const step = Math.min(stepMs, left);
    clock += step;
    vi.advanceTimersByTime(step);
  }
}

/** The machine SLEEPS: the wall clock jumps, no timer fires until it wakes. */
function sleepThenWake(gapMs: number): void {
  clock += gapMs;
  vi.advanceTimersByTime(FLUSH_INTERVAL_MS); // the first tick after wake
}

const totalMs = (samples: TimeSample[]): number =>
  samples.reduce((sum, s) => sum + s.durationMs, 0);

/** [startMs, endMs) of each banked window, in bank order. */
const windows = (samples: TimeSample[]): Array<[number, number]> =>
  samples.map((s) => [Date.parse(s.ts), Date.parse(s.ts) + s.durationMs]);

beforeEach(() => {
  dom = parseHTML(HTML);
  // The installer reads `document` / `window` / `Element` from globals.
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = dom.document;
  g.window = dom.window;
  g.Element = dom.window.Element;
  vi.useFakeTimers();
  clock = T0;
  sent = [];
  uninstall = installTimeTracker({
    getPathname: () => '/',
    now: () => clock,
    send: (batch) => { sent.push(...batch); },
  });
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.window;
  delete g.Element;
});

describe('an automation-driven browser', () => {
  // Playwright/CDP browsers set navigator.webdriver; their clicks are real DOM
  // events, so without this gate every UI-verification run against the live
  // console banks hours of fake human time (the 2026-08-30 "8h42m overnight"
  // incident). The gate lives at install time: nothing is wired at all.
  // Node's own globalThis.navigator is getter-only; defineProperty shadows it.
  const setNavigator = (value: unknown): void => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  };
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const restoreNavigator = (): void => {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  };

  it('installs nothing: real signals and flush ticks bank zero samples', () => {
    uninstall(); // replace the human-browser tracker from beforeEach
    setNavigator({ webdriver: true });
    try {
      uninstall = installTimeTracker({
        getPathname: () => '/',
        now: () => clock,
        send: (batch) => { sent.push(...batch); },
      });
      signal('alpha');
      elapse(10 * 60_000);
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      expect(sent).toEqual([]);
    } finally {
      restoreNavigator();
    }
  });

  it('opts back in via localStorage for tests that exercise tracking itself', () => {
    uninstall();
    const g = globalThis as unknown as Record<string, unknown>;
    setNavigator({ webdriver: true });
    g.localStorage = { getItem: (k: string) => (k === 'walnut.time.allowAutomation' ? '1' : null) };
    try {
      uninstall = installTimeTracker({
        getPathname: () => '/',
        now: () => clock,
        send: (batch) => { sent.push(...batch); },
      });
      signal('alpha');
      elapse(3 * 60_000);
      expect(totalMs(sent)).toBe(LEASE_MS);
    } finally {
      restoreNavigator();
      delete g.localStorage;
    }
  });
});

describe('a parked cursor', () => {
  it('banks exactly one lease over three idle hours, never the idle time', () => {
    signal('alpha');
    elapse(3 * 60 * 60_000);

    expect(totalMs(sent)).toBe(LEASE_MS);
    expect(sent.every((s) => s.taskId === 't_alpha' && s.kind === 'triage')).toBe(true);
    // Contiguous from the signal to the lease expiry, and nothing after it.
    const spans = windows(sent);
    expect(spans[0]![0]).toBe(T0);
    expect(spans.at(-1)![1]).toBe(T0 + LEASE_MS);
  });
});

describe('a laptop that sleeps mid-lease', () => {
  it('does not attribute the sleep gap as one giant slice', () => {
    signal('alpha');
    // Sleep starts 5s into the lease; the interval never fires while asleep.
    elapse(5_000);
    sleepThenWake(3 * 60 * 60_000);

    // The dangerous outcome is 3h+ here (a `now - lastFlush` duration).
    expect(totalMs(sent)).toBe(LEASE_MS);
    expect(totalMs(sent)).toBeLessThanOrEqual(LEASE_MS);

    // And staying awake afterwards adds nothing: the lease is long gone.
    elapse(10 * 60_000);
    expect(totalMs(sent)).toBe(LEASE_MS);
  });

  it('caps the unload flush too — a tab closed after a sleep cannot bank the gap', () => {
    signal('beta');
    clock += 4 * 60 * 60_000; // asleep, then the lid opens onto a closing tab
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));

    expect(totalMs(sent)).toBe(LEASE_MS);
    expect(sent.every((s) => s.taskId === 't_beta')).toBe(true);
  });
});

describe('one active context at a time', () => {
  it('stops the first panel at the second panel\'s first signal, with no overlap', () => {
    signal('alpha');            // T0
    elapse(20_000);
    signal('beta');             // T0+20s — alpha stops HERE
    elapse(20_000);
    signal('alpha');            // T0+40s — beta stops HERE
    // Nothing further: alpha's lease runs out at T0+40s+LEASE_MS.
    elapse(140_000);

    // Total equals the wall clock from the first signal to the last expiry —
    // no second is counted twice, and none is lost.
    expect(totalMs(sent)).toBe(40_000 + LEASE_MS);

    const perTask = new Map<string, number>();
    for (const s of sent) perTask.set(s.taskId!, (perTask.get(s.taskId!) ?? 0) + s.durationMs);
    expect(perTask.get('t_beta')).toBe(20_000);
    expect(perTask.get('t_alpha')).toBe(20_000 + LEASE_MS);

    // Windows are strictly contiguous: [T0, T0+40s+LEASE) covered exactly once.
    const spans = windows(sent).sort((a, b) => a[0] - b[0]);
    expect(spans[0]![0]).toBe(T0);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]![0]).toBe(spans[i - 1]![1]); // no gap, no overlap
    }
    expect(spans.at(-1)![1]).toBe(T0 + 40_000 + LEASE_MS);
  });

  it('bills the panel under the cursor, never both, when signals alternate fast', () => {
    // Alternating every second for a minute: 30 windows, one earner at a time.
    for (let i = 0; i < 60; i++) {
      signal(i % 2 === 0 ? 'alpha' : 'beta');
      elapse(1_000);
    }
    elapse(2 * LEASE_MS);

    const spans = windows(sent).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
    }
    // 60s of alternating work + one final lease tail, and not a second more.
    expect(totalMs(sent)).toBe(59_000 + LEASE_MS);
  });
});
