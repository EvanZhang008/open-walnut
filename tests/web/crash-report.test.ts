/**
 * Tests for the client-side crash report builder.
 *
 * Contract under test:
 *   - All sections render with a fake error + componentStack.
 *   - A seeded secret in the console ring comes out [REDACTED].
 *   - Storage snapshot shows key names + byte lengths, never values.
 *   - Builder never throws even when browser globals are hostile.
 *
 * Node env: window/navigator/storage are stubbed with the minimal surface the
 * builder touches (same style as crash-recovery.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

class FakeStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

const localStorage = new FakeStorage();
const sessionStorage = new FakeStorage();

// Browser globals BEFORE importing the module under test. Node ≥21 exposes
// a getter-only globalThis.navigator — defineProperty overrides it cleanly.
for (const [key, value] of Object.entries({
  window: {
    location: { href: 'http://localhost:3456/?task=t-123' },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    isSecureContext: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  navigator: { userAgent: 'test-agent/1.0', language: 'en-US', onLine: true },
  localStorage,
  sessionStorage,
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

const recentEntries: Array<Record<string, unknown>> = [];
vi.mock('../../web/src/utils/browser-logger', () => ({
  getRecentEntries: () => recentEntries.map((e) => ({ ...e })),
}));
vi.mock('../../web/src/api/ws', () => ({
  wsClient: {
    state: 'disconnected',
    lastClose: { code: 1006, codeDesc: 'abnormal (no close frame)', reason: 'none', at: '2026-07-14T00:00:00.000Z' },
  },
}));
// app-info imports nothing problematic, but stub for determinism.
vi.mock('../../web/src/utils/app-info', () => ({
  getAppInfo: () => ({ version: '0.2.0', mode: 'LIVE' }),
}));

import { buildCrashReport } from '../../web/src/utils/crash-report';

describe('buildCrashReport', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    recentEntries.length = 0;
  });

  it('renders all sections for a real Error + componentStack', () => {
    const err = new Error('boom from test');
    const text = buildCrashReport({ error: err, componentStack: '\n at TodoPanel\n at MainPage' });
    expect(text).toContain('WALNUT CRASH REPORT');
    expect(text).toContain('=== crash ===');
    expect(text).toContain('boom from test');
    expect(text).toContain('at TodoPanel');
    expect(text).toContain('=== environment ===');
    expect(text).toContain('test-agent/1.0');
    expect(text).toContain('=== connection ===');
    expect(text).toContain('code=1006');
    expect(text).toContain('=== crash history ===');
    expect(text).toContain('=== storage snapshot');
    expect(text).toContain('=== recent console');
  });

  it('redacts a secret leaked into the console ring', () => {
    const secret = 'sk-cccccccccccccccccccccccccccc';
    recentEntries.push({ time: '2026-07-14T01:02:03.000Z', level: 'error', message: `fetch failed with key ${secret}` });
    const text = buildCrashReport({ error: new Error('x') });
    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
  });

  it('storage snapshot shows walnut key names and byte lengths, never values', () => {
    localStorage.setItem('open-walnut-todo-active-tab', 'SECRET_TAB_VALUE');
    sessionStorage.setItem('open-walnut-home-focused-task', '');
    const text = buildCrashReport({ error: new Error('x') });
    expect(text).toContain('open-walnut-todo-active-tab=16');
    expect(text).toContain('open-walnut-home-focused-task=0'); // the truncated-value smoking gun
    expect(text).not.toContain('SECRET_TAB_VALUE');
  });

  it('reports deviceToken presence as a boolean only', () => {
    localStorage.setItem('walnut.deviceToken', 'wdt_super_secret_token');
    const text = buildCrashReport({ error: new Error('x') });
    expect(text).toContain('has deviceToken stored = yes');
    expect(text).not.toContain('wdt_super_secret_token');
  });

  it('never throws on a non-Error crash value and hostile storage', () => {
    const throwingStorage = {
      get length(): number { throw new Error('storage blocked'); },
      key() { throw new Error('storage blocked'); },
      getItem() { throw new Error('storage blocked'); },
    };
    (globalThis as Record<string, unknown>).sessionStorage = throwingStorage;
    const text = buildCrashReport({ error: 'plain string crash' });
    expect(text).toContain('WALNUT CRASH REPORT');
    expect(text).toContain('plain string crash');
    expect(text).toContain('(unavailable:');
    (globalThis as Record<string, unknown>).sessionStorage = sessionStorage;
  });
});
