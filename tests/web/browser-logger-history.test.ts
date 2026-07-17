/**
 * Tests for the browser-logger retained history ring (crash/bug report source).
 *
 * Contract under test:
 *   - getRecentEntries() retains entries across the ring cap (oldest dropped at 300).
 *   - Consecutive-duplicate dedup is visible via count.
 *   - Returned entries are clones — mutating them can't corrupt the live ring.
 *
 * Runs in node env: window is stubbed with the minimal surface initBrowserLogger
 * touches (addEventListener). location/navigator absences are handled by the
 * logger's own try/catch guards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Minimal window stub BEFORE importing the module under test.
(globalThis as Record<string, unknown>).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

// browser-logger imports wsClient (whose transitive `@/utils/log` alias isn't
// resolvable under the node vitest config) — stub the WS surface it touches.
vi.mock('../../web/src/api/ws', () => ({
  wsClient: { state: 'disconnected', sendRpc: () => Promise.resolve() },
}));

import {
  initBrowserLogger,
  destroyBrowserLogger,
  getRecentEntries,
} from '../../web/src/utils/browser-logger';

describe('browser-logger history ring', () => {
  beforeEach(() => {
    initBrowserLogger();
  });

  afterEach(() => {
    destroyBrowserLogger();
  });

  it('retains recent entries and drops the oldest beyond the 300 cap', () => {
    for (let i = 0; i < 320; i++) {
      console.info(`history-entry-${i}`);
    }
    const entries = getRecentEntries();
    expect(entries.length).toBeLessThanOrEqual(300);
    const messages = entries.map((e) => e.message);
    expect(messages).toContain('history-entry-319'); // newest kept
    expect(messages).not.toContain('history-entry-0'); // oldest dropped
  });

  it('dedups consecutive identical messages with a visible count', () => {
    console.warn('dup-message');
    console.warn('dup-message');
    console.warn('dup-message');
    const entries = getRecentEntries();
    const dup = entries.find((e) => e.message === 'dup-message');
    expect(dup).toBeDefined();
    expect(dup!.count).toBe(3);
  });

  it('returns clones — mutating a returned entry does not corrupt the ring', () => {
    console.error('immutable-check');
    const first = getRecentEntries().find((e) => e.message === 'immutable-check')!;
    first.message = 'TAMPERED';
    const second = getRecentEntries().find((e) => e.message === 'immutable-check');
    expect(second).toBeDefined();
  });
});
