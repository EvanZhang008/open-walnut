/**
 * The tab store of unsaved drawing edits (web/src/components/drawing/drawing-store.ts): a new tab
 * (the Mac app relaunched after a crash drops sessionStorage, so its page is a new tab) takes over
 * the drafts of a tab that is gone, and never those of a live tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAWING_ALIVE_PREFIX, DRAWING_STORE_PREFIX, GONE_AFTER_MS, HEARTBEAT_MS, drawingTabId, resetDrawingTabForTest, tabDrawingStore,
} from '../../web/src/components/drawing/drawing-store';

class FakeStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const g = globalThis as Record<string, unknown>;
const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage };
let local: FakeStorage;

/** A new tab: its own sessionStorage, the shared localStorage. */
function newTab(): string {
  resetDrawingTabForTest();
  g.sessionStorage = new FakeStorage();
  return drawingTabId();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  local = new FakeStorage();
  g.localStorage = local;
});
afterEach(() => {
  resetDrawingTabForTest();
  vi.useRealTimers();
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

const KEY = 'file:Inbox/a.excalidraw';

describe("a gone tab's drawing drafts", () => {
  it('are never taken from a live tab, even one whose timers run about once a minute in the background', () => {
    const first = newTab();
    tabDrawingStore.write(KEY, 'edits of tab one');
    expect(local.getItem(`${DRAWING_ALIVE_PREFIX}${first}`)).not.toBeNull();
    newTab();
    // The first tab lives on in the background (one process per tab in a real browser): its
    // throttled timer beats once a minute, by hand here.
    vi.setSystemTime(Date.now() + 60_000);
    local.setItem(`${DRAWING_ALIVE_PREFIX}${first}`, String(Date.now()));
    vi.setSystemTime(Date.now() + 60_000);
    tabDrawingStore.adopt!(KEY);
    expect(tabDrawingStore.read(KEY)).toBe('');
    expect(local.getItem(`${DRAWING_STORE_PREFIX}${first}:${KEY}`)).toBe('edits of tab one');
  });

  it('are taken over by the next tab that opens the same file once the heartbeat stopped', () => {
    const first = newTab();
    tabDrawingStore.write(KEY, 'edits of tab one');
    tabDrawingStore.write('file:Inbox/other.excalidraw', 'other edits');
    // The tab crashes: its heartbeat stops (the timer of this fake tab is gone with the reset).
    const second = newTab();
    vi.setSystemTime(Date.now() + GONE_AFTER_MS + 1);
    // The new tab's own heartbeat keeps it alive meanwhile.
    vi.advanceTimersByTime(HEARTBEAT_MS);
    tabDrawingStore.adopt!(KEY);
    expect(tabDrawingStore.read(KEY)).toBe('edits of tab one');
    expect(local.getItem(`${DRAWING_STORE_PREFIX}${first}:${KEY}`)).toBeNull();
    // Only the draft of what was opened moves; the gone tab keeps its record while it has others.
    expect(local.getItem(`${DRAWING_STORE_PREFIX}${first}:file:Inbox/other.excalidraw`)).toBe('other edits');
    expect(local.getItem(`${DRAWING_ALIVE_PREFIX}${first}`)).not.toBeNull();
    tabDrawingStore.adopt!('file:Inbox/other.excalidraw');
    expect(local.getItem(`${DRAWING_ALIVE_PREFIX}${first}`)).toBeNull();
    expect(local.getItem(`${DRAWING_ALIVE_PREFIX}${second}`)).not.toBeNull();
  });

  it("never replace this tab's own draft, and take a draft from before heartbeats existed", () => {
    newTab();
    tabDrawingStore.write(KEY, 'mine');
    local.setItem(`${DRAWING_STORE_PREFIX}old-tab:${KEY}`, 'from an older Walnut');
    tabDrawingStore.adopt!(KEY);
    expect(tabDrawingStore.read(KEY)).toBe('mine');
    tabDrawingStore.write(KEY, '');
    tabDrawingStore.adopt!(KEY);
    expect(tabDrawingStore.read(KEY)).toBe('from an older Walnut');
  });

  it('take the newest of several gone tabs, and match the whole key only', () => {
    newTab();
    const now = Date.now();
    local.setItem(`${DRAWING_STORE_PREFIX}t1:${KEY}`, 'older');
    local.setItem(`${DRAWING_ALIVE_PREFIX}t1`, String(now - GONE_AFTER_MS - 50_000));
    local.setItem(`${DRAWING_STORE_PREFIX}t2:${KEY}`, 'newer');
    local.setItem(`${DRAWING_ALIVE_PREFIX}t2`, String(now - GONE_AFTER_MS - 1));
    local.setItem(`${DRAWING_STORE_PREFIX}t3:${KEY}:unreadable`, 'set aside');
    tabDrawingStore.adopt!(KEY);
    expect(tabDrawingStore.read(KEY)).toBe('newer');
    expect(local.getItem(`${DRAWING_STORE_PREFIX}t1:${KEY}`)).toBe('older');
    expect(local.getItem(`${DRAWING_STORE_PREFIX}t3:${KEY}:unreadable`)).toBe('set aside');
  });
});
