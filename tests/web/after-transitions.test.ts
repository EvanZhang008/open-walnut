/**
 * afterOwnTransitions (web/src/utils/after-transitions.ts): a reveal runs once
 * the element's own CSS transitions are over, never on a padded timer alone.
 *
 * 2026-10-31: the comment card's grow revealed itself on `GROW_MS + 40`; in
 * WebKit the 160 ms glide started a frame late, the timer read the card at 445
 * of its 520 px and its foot ended under the fold. The ratchet below fails on a
 * new timer padded past a transition's length in the web app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterOwnTransitions } from '@/utils/after-transitions';

class FakeTransition {
  playState = 'running';
  finished: Promise<void>;
  private settle!: () => void;
  private fail!: (e: Error) => void;
  constructor() {
    this.finished = new Promise<void>((res, rej) => { this.settle = res; this.fail = rej; });
  }
  end() { this.playState = 'finished'; this.settle(); }
  cancel() { this.playState = 'idle'; this.fail(new Error('AbortError')); }
}

function element(anims: () => FakeTransition[]): Element {
  return { getAnimations: () => anims() } as unknown as Element;
}

describe('afterOwnTransitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('CSSTransition', FakeTransition);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('runs after the minimum wait when nothing transitions', async () => {
    const fn = vi.fn();
    afterOwnTransitions(element(() => []), fn, 200);
    await vi.advanceTimersByTimeAsync(199);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits for a glide still running at the timer, and one frame after it', async () => {
    const fn = vi.fn();
    const t = new FakeTransition();
    let list = [t];
    afterOwnTransitions(element(() => list), fn, 200);
    await vi.advanceTimersByTimeAsync(400);
    expect(fn).not.toHaveBeenCalled();
    t.end(); list = [];
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a retargeted transition (the old one rejects) waits for the new one', async () => {
    const fn = vi.fn();
    const first = new FakeTransition();
    const second = new FakeTransition();
    let list = [first];
    afterOwnTransitions(element(() => list), fn, 200);
    await vi.advanceTimersByTimeAsync(210);
    list = [second];
    first.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).not.toHaveBeenCalled();
    second.end(); list = [];
    await vi.advanceTimersByTimeAsync(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('an endless animation never holds it, and the cap ends a stuck wait', async () => {
    const fn = vi.fn();
    const breathing = { playState: 'running', finished: new Promise<void>(() => {}) };
    afterOwnTransitions({ getAnimations: () => [breathing] } as unknown as Element, fn, 200);
    await vi.advanceTimersByTimeAsync(220);
    expect(fn).toHaveBeenCalledTimes(1);

    const stuck = vi.fn();
    const never = new FakeTransition();
    afterOwnTransitions(element(() => [never]), stuck, 200, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(stuck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(stuck).toHaveBeenCalledTimes(1);
    never.end();
    await vi.advanceTimersByTimeAsync(50);
    expect(stuck).toHaveBeenCalledTimes(1);
  });

  it('cancel stops it', async () => {
    const fn = vi.fn();
    const cancel = afterOwnTransitions(element(() => []), fn, 200);
    cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ratchet: no timer padded past a transition stands in for its end', () => {
  const root = path.resolve(__dirname, '../../web/src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(name)) files.push(p);
    }
  };
  walk(root);

  it('scans the web app', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no setTimeout delay reads "<SOMETHING>_MS + n": wait with afterOwnTransitions', () => {
    // `}, GROW_MS + 40)` closing a timer callback, or an inline delay argument.
    const padded = /(?:\},|setTimeout\([^;]*?,)\s*[A-Z][A-Z0-9_]*_MS\s*\+\s*\d+\s*\)/g;
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(padded)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${path.relative(root, f)}:${line}  ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    expect(hits, 'a timer padded past a transition fires mid-glide when frames come late').toEqual([]);
    // The shape this replaced is caught.
    const old = 'const t = window.setTimeout(() => {\n  card.scrollIntoView();\n}, GROW_MS + 40);';
    expect([...old.matchAll(padded)]).toHaveLength(1);
    expect([...'setTimeout(reveal, FADE_MS + 20)'.matchAll(padded)]).toHaveLength(1);
  });
});
