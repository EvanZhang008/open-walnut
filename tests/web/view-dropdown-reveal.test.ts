/**
 * view-dropdown-reveal.ts: the "show me that control" bridge the lock-grant hint uses.
 *
 * `whenSettled` is the part worth pinning on its own: the task panel slides open over 250ms
 * and a menu placed from the trigger's rect mid-slide lands in the wrong spot, so the open
 * waits for a visible box that holds still for a frame, and gives up after ~60 frames so a
 * trigger that never shows (another route, display:none) cannot park the request forever.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VIEW_DROPDOWN_REVEAL_EVENT, revealViewOption, whenSettled,
} from '../../web/src/components/tasks/view-dropdown-reveal';

type Rect = { left: number; width: number; height: number; top?: number };

/** A fake element whose box follows a script, one entry per frame (the last repeats). */
function element(frames: Rect[]): Element {
  let i = 0;
  return {
    getBoundingClientRect: () => {
      const r = frames[Math.min(i, frames.length - 1)];
      i++;
      const top = r.top ?? 0;
      return { left: r.left, width: r.width, height: r.height, top, right: r.left + r.width, bottom: top + r.height, x: r.left, y: top } as DOMRect;
    },
  } as unknown as Element;
}

/** Manual rAF: `pump(n)` runs up to n queued frames. */
let queue: Array<() => void> = [];
let cancelled = 0;
function pump(n: number): number {
  let ran = 0;
  while (queue.length && ran < n) { queue.shift()!(); ran++; }
  return ran;
}

const g = globalThis as unknown as {
  requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown; window?: unknown; CustomEvent?: unknown;
};
let saved: Partial<typeof g>;

beforeEach(() => {
  saved = { requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame };
  queue = [];
  cancelled = 0;
  g.requestAnimationFrame = (cb: () => void) => { queue.push(cb); return queue.length; };
  g.cancelAnimationFrame = () => { cancelled++; queue = []; };
});
afterEach(() => {
  g.requestAnimationFrame = saved.requestAnimationFrame;
  g.cancelAnimationFrame = saved.cancelAnimationFrame;
});

describe('whenSettled', () => {
  it('fires once the box is visible and unchanged from the previous frame', () => {
    let fired = 0;
    // Sliding open: left and width move for three frames, then hold.
    whenSettled(element([
      { left: 0, width: 0, height: 30 },
      { left: 40, width: 20, height: 30 },
      { left: 80, width: 20, height: 30 },
      { left: 120, width: 20, height: 30 },
      { left: 120, width: 20, height: 30 },
    ]), () => { fired++; });
    pump(4);
    expect(fired).toBe(0);
    pump(1);
    expect(fired).toBe(1);
    // Nothing is left queued: the loop ends with the callback.
    expect(queue).toHaveLength(0);
  });

  it('a box that only moves vertically is still moving (a toolbar wrapping as its panel widens)', () => {
    let fired = 0;
    whenSettled(element([
      { left: 300, width: 28, height: 28, top: 60 },
      { left: 300, width: 28, height: 28, top: 44 },
      { left: 300, width: 28, height: 28, top: 36 },
      { left: 300, width: 28, height: 28, top: 36 },
    ]), () => { fired++; });
    pump(3);
    expect(fired).toBe(0);
    pump(1);
    expect(fired).toBe(1);
  });

  it('a trigger that is already still fires on the second frame, not the first', () => {
    let fired = 0;
    whenSettled(element([{ left: 300, width: 28, height: 28 }]), () => { fired++; });
    pump(1);
    expect(fired).toBe(0);
    pump(1);
    expect(fired).toBe(1);
  });

  it('a box that never becomes visible is not waited on forever', () => {
    let fired = 0;
    whenSettled(element([{ left: 0, width: 0, height: 0 }]), () => { fired++; });
    const ran = pump(200);
    expect(fired).toBe(1);
    expect(ran).toBeLessThanOrEqual(63);
    expect(ran).toBeGreaterThan(50);
  });

  it('the returned cancel stops the loop before the callback', () => {
    let fired = 0;
    const cancel = whenSettled(element([{ left: 300, width: 28, height: 28 }]), () => { fired++; });
    pump(1);
    cancel();
    expect(cancelled).toBe(1);
    pump(10);
    expect(fired).toBe(0);
  });
});

describe('revealViewOption', () => {
  it('dispatches the reveal event on window with the option key', () => {
    const seen: unknown[] = [];
    const savedWindow = g.window;
    const savedCustomEvent = g.CustomEvent;
    class FakeCustomEvent { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } }
    g.CustomEvent = FakeCustomEvent;
    g.window = { dispatchEvent: (e: unknown) => { seen.push(e); return true; } };
    try {
      revealViewOption('session-panels');
    } finally {
      g.window = savedWindow;
      g.CustomEvent = savedCustomEvent;
    }
    expect(seen).toHaveLength(1);
    const e = seen[0] as FakeCustomEvent;
    expect(e.type).toBe(VIEW_DROPDOWN_REVEAL_EVENT);
    expect(e.detail).toEqual({ option: 'session-panels' });
  });
});
