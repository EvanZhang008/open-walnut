/**
 * Cross-panel composer insert (web/src/utils/composer-insert.ts): a live panel
 * consumes the event; with nobody listening the text parks in the persisted
 * draft and the session is opened on Home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = new Map<string, string>();
let target = new EventTarget();
let pathname = '/tasks';

beforeEach(() => {
  store.clear();
  target = new EventTarget();
  pathname = '/tasks';
  (globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: (e: Event) => target.dispatchEvent(e),
    addEventListener: (t: string, l: EventListener) => target.addEventListener(t, l),
    removeEventListener: (t: string, l: EventListener) => target.removeEventListener(t, l),
    get location() { return { pathname }; },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const SID = '33333333-cccc-4ccc-8ccc-cccccccccccc';

describe('insertIntoSessionComposer', () => {
  it('a live panel marks the event handled → inserted, and the user is sent home', async () => {
    const { insertIntoSessionComposer, COMPOSER_INSERT_EVENT } = await import('@/utils/composer-insert');
    const seen: string[] = [];
    target.addEventListener(COMPOSER_INSERT_EVENT, (e) => {
      const d = (e as CustomEvent<{ sessionId: string; text: string; handled: boolean }>).detail;
      if (d.sessionId === SID) { d.handled = true; seen.push(d.text); }
    });
    const navigate = vi.fn();
    expect(insertIntoSessionComposer(SID, '<task-ref id="t1" label="Fix"/> ', navigate)).toBe('inserted');
    expect(seen).toEqual(['<task-ref id="t1" label="Fix"/> ']);
    expect(navigate).toHaveBeenCalledWith('/');
    expect(store.size).toBe(0);
  });

  it('already on Home → no navigation', async () => {
    const { insertIntoSessionComposer, COMPOSER_INSERT_EVENT } = await import('@/utils/composer-insert');
    pathname = '/';
    target.addEventListener(COMPOSER_INSERT_EVENT, (e) => { (e as CustomEvent<{ handled: boolean }>).detail.handled = true; });
    const navigate = vi.fn();
    insertIntoSessionComposer(SID, 'x', navigate);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('no panel listening → queued in the persisted draft (appended) and opened on Home', async () => {
    const { insertIntoSessionComposer, sessionDraftKey } = await import('@/utils/composer-insert');
    store.set(sessionDraftKey(SID), 'half a sentence  ');
    const opened: string[] = [];
    target.addEventListener('main:open-session', (e) => { opened.push((e as CustomEvent<{ sessionId: string }>).detail.sessionId); });
    const navigate = vi.fn();
    expect(insertIntoSessionComposer(SID, '<task-ref id="t1" label="Fix"/> ', navigate)).toBe('queued');
    expect(store.get(sessionDraftKey(SID))).toBe('half a sentence <task-ref id="t1" label="Fix"/> ');
    expect(opened).toEqual([SID]);
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
