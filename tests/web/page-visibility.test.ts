/**
 * Page Visibility helpers (web/src/utils/page-visibility.ts).
 *
 * Hidden tabs must not keep polling the server: N open tabs share the
 * browser's 6-connections-per-origin pool, so background pollers multiply
 * every refresh burst by N. The helpers sleep while hidden and run ONE
 * catch-up on the hidden→visible edge.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type VisListener = () => void;

function makeFakeDocument(initial: 'visible' | 'hidden') {
  const listeners: VisListener[] = [];
  const doc = {
    visibilityState: initial as string,
    addEventListener: (name: string, cb: VisListener) => {
      if (name === 'visibilitychange') listeners.push(cb);
    },
    removeEventListener: () => {},
    setVisibility(state: 'visible' | 'hidden') {
      doc.visibilityState = state;
      for (const cb of [...listeners]) cb();
    },
  };
  return doc;
}

describe('page-visibility', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let mod: typeof import('../../web/src/utils/page-visibility');

  beforeEach(async () => {
    vi.useFakeTimers();
    doc = makeFakeDocument('visible');
    vi.stubGlobal('document', doc);
    // Fresh module per test: it memoizes its visibilitychange wiring.
    vi.resetModules();
    mod = await import('../../web/src/utils/page-visibility');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('visibleInterval', () => {
    it('ticks normally while visible', () => {
      const tick = vi.fn();
      const cancel = mod.visibleInterval(tick, 1000);
      vi.advanceTimersByTime(3000);
      expect(tick).toHaveBeenCalledTimes(3);
      cancel();
    });

    it('skips ticks while hidden, then runs exactly ONE catch-up on return', () => {
      const tick = vi.fn();
      const cancel = mod.visibleInterval(tick, 1000);

      doc.setVisibility('hidden');
      vi.advanceTimersByTime(10_000); // 10 missed ticks
      expect(tick).not.toHaveBeenCalled();

      doc.setVisibility('visible');
      expect(tick).toHaveBeenCalledTimes(1); // catch-up collapses to one

      vi.advanceTimersByTime(2000); // resumes normal cadence
      expect(tick).toHaveBeenCalledTimes(3);
      cancel();
    });

    it('no catch-up when nothing was missed while hidden', () => {
      const tick = vi.fn();
      const cancel = mod.visibleInterval(tick, 1000);
      doc.setVisibility('hidden');
      doc.setVisibility('visible'); // hidden shorter than one period
      expect(tick).not.toHaveBeenCalled();
      cancel();
    });

    it('catchUp: false suppresses the catch-up tick', () => {
      const tick = vi.fn();
      const cancel = mod.visibleInterval(tick, 1000, { catchUp: false });
      doc.setVisibility('hidden');
      vi.advanceTimersByTime(5000);
      doc.setVisibility('visible');
      expect(tick).not.toHaveBeenCalled();
      cancel();
    });

    it('cancel stops both ticking and the pending catch-up', () => {
      const tick = vi.fn();
      const cancel = mod.visibleInterval(tick, 1000);
      doc.setVisibility('hidden');
      vi.advanceTimersByTime(3000);
      cancel();
      doc.setVisibility('visible');
      vi.advanceTimersByTime(3000);
      expect(tick).not.toHaveBeenCalled();
    });
  });

  describe('runWhenVisible', () => {
    it('runs immediately when visible', () => {
      const fn = vi.fn();
      mod.runWhenVisible('k', fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('defers while hidden and coalesces by key (latest wins)', () => {
      doc.setVisibility('hidden');
      const first = vi.fn();
      const second = vi.fn();
      mod.runWhenVisible('same-key', first);
      mod.runWhenVisible('same-key', second);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();

      doc.setVisibility('visible');
      expect(first).not.toHaveBeenCalled(); // superseded
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('different keys each run once on return', () => {
      doc.setVisibility('hidden');
      const a = vi.fn();
      const b = vi.fn();
      mod.runWhenVisible('a', a);
      mod.runWhenVisible('b', b);
      doc.setVisibility('visible');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('deferred jobs fire once, not again on the next visible edge', () => {
      doc.setVisibility('hidden');
      const fn = vi.fn();
      mod.runWhenVisible('once', fn);
      doc.setVisibility('visible');
      doc.setVisibility('hidden');
      doc.setVisibility('visible');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('no-DOM environment (node)', () => {
    it('degrades to always-on behavior when document is undefined', async () => {
      vi.unstubAllGlobals();
      vi.stubGlobal('document', undefined);
      vi.resetModules();
      const bare = await import('../../web/src/utils/page-visibility');
      expect(bare.isPageHidden()).toBe(false);
      const fn = vi.fn();
      bare.runWhenVisible('k', fn); // runs immediately — nothing to defer against
      expect(fn).toHaveBeenCalledTimes(1);
      const tick = vi.fn();
      const cancel = bare.visibleInterval(tick, 1000);
      vi.advanceTimersByTime(2000);
      expect(tick).toHaveBeenCalledTimes(2);
      cancel();
    });
  });
});
