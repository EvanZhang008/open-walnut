/**
 * N19: on a phone, work the first screen does not show waits for the first task list to paint
 * (or a few seconds at most); off a phone it runs at once, so a desktop starts as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterFirstScreen,
  FIRST_SCREEN_FALLBACK_MS,
  firstScreenPending,
  markFirstScreen,
  resetFirstScreenForTests,
} from '../../web/src/utils/after-first-screen';

function setPhone(phone: boolean): void {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: phone }) });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Frames as timers, so the two-frame paint wait is driven by the fake clock.
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 16));
  resetFirstScreenForTests();
});

afterEach(() => {
  resetFirstScreenForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('afterFirstScreen', () => {
  it('off a phone runs at once', () => {
    setPhone(false);
    const fn = vi.fn();
    afterFirstScreen(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('on a phone waits for the first list, then two frames, and runs each queued job once', async () => {
    setPhone(true);
    const a = vi.fn();
    const b = vi.fn();
    afterFirstScreen(a);
    afterFirstScreen(b);
    expect(a).not.toHaveBeenCalled();
    expect(firstScreenPending()).toBe(2);
    markFirstScreen();
    await vi.advanceTimersByTimeAsync(16);
    expect(a).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    markFirstScreen();
    await vi.advanceTimersByTimeAsync(FIRST_SCREEN_FALLBACK_MS);
    expect(a).toHaveBeenCalledTimes(1);
    // After the first screen, new work runs at once.
    const c = vi.fn();
    afterFirstScreen(c);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('on a phone whose list never answers, the queue runs after the fallback', async () => {
    setPhone(true);
    const fn = vi.fn();
    afterFirstScreen(fn);
    await vi.advanceTimersByTimeAsync(FIRST_SCREEN_FALLBACK_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('one job that throws does not stop the others', async () => {
    setPhone(true);
    const after = vi.fn();
    afterFirstScreen(() => { throw new Error('boom'); });
    afterFirstScreen(after);
    markFirstScreen();
    await vi.advanceTimersByTimeAsync(40);
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('afterFirstScreen behind the sign-in page (N2-35)', () => {
  it('waits while the sign-in page shows, and runs once it is gone', () => {
    setPhone(true);
    let notice = true;
    vi.stubGlobal('document', { querySelector: (sel: string) => (notice && sel.includes('unpaired-notice') ? {} : null) });
    const fn = vi.fn();
    afterFirstScreen(fn);
    vi.advanceTimersByTime(FIRST_SCREEN_FALLBACK_MS * 3);
    expect(fn).not.toHaveBeenCalled();
    notice = false;
    vi.advanceTimersByTime(FIRST_SCREEN_FALLBACK_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
