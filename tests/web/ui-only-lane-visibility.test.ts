/**
 * `shouldHideUiOnlyMessage` — butler LANE notices are visible by default.
 *
 * The `session` UI-only category ships defaultOn:false (an external coding
 * session's "Session Result" dump is noise in the butler timeline). On the lane
 * engine that default became a blackout: the ONLY thing a lane turn puts in the
 * chat timeline is a `<session-ref>` breadcrumb — also source:'session',
 * notification:true — so a user who sent a message saw absolutely nothing come
 * back. The carve-out: a ref notice ignores the DEFAULT but still honors an
 * EXPLICIT opt-out, so "hide session results" remains a real setting.
 *
 * Node env: localStorage is stubbed with the minimal surface the hook touches
 * (same style as file-view-state.test.ts). No React render is involved —
 * shouldHideUiOnlyMessage is a pure function over (source, notification, content).
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

let storage: FakeStorage;

/** The breadcrumb the lane branch of chat.ts persists, verbatim in shape. */
const LANE_NOTICE = 'Butler ran on session <session-ref id="abc-123" label="Butler chat"/>';
/** A normal session summary — the thing the category was created to hide. */
const SESSION_RESULT = '**Session Result** (task-1):\n\nfinished the refactor';

beforeEach(async () => {
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
  // window is only touched by the subscribe/write paths, but stub it so an
  // accidental import-time listener registration can't throw here.
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
  vi.resetModules();
});

async function load() {
  return await import('../../web/src/hooks/useDeveloperSettings');
}

describe('lane session-ref notices', () => {
  it('are VISIBLE with default settings (nothing stored)', async () => {
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('session', true, LANE_NOTICE)).toBe(false);
  });

  it('stay visible when the user explicitly turns the session category ON', async () => {
    const { shouldHideUiOnlyMessage, setShowUiOnlyCategory } = await load();
    setShowUiOnlyCategory('session', true);
    expect(shouldHideUiOnlyMessage('session', true, LANE_NOTICE)).toBe(false);
  });

  it('are HIDDEN when the user explicitly turns the session category OFF', async () => {
    // An explicit false is a real user decision and outranks the carve-out.
    const { shouldHideUiOnlyMessage, setShowUiOnlyCategory } = await load();
    setShowUiOnlyCategory('session', false);
    expect(shouldHideUiOnlyMessage('session', true, LANE_NOTICE)).toBe(true);
  });

  it('the carve-out is keyed on the tag, not on the source alone', async () => {
    // An ordinary session summary must keep its old default-hidden behavior —
    // otherwise this fix would un-hide the very noise the category exists for.
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('session', true, SESSION_RESULT)).toBe(true);
    // …and a caller that passes no content behaves exactly as before the change.
    expect(shouldHideUiOnlyMessage('session', true)).toBe(true);
  });

  it('does not leak the carve-out into other categories', async () => {
    // A triage/subagent entry that happens to quote a session-ref is still
    // governed by its own toggle.
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('triage', true, LANE_NOTICE)).toBe(true);
    expect(shouldHideUiOnlyMessage('subagent', true, LANE_NOTICE)).toBe(true);
  });

  it('ignores non-string content instead of throwing', async () => {
    // Display entries can carry block arrays; the filter runs on every render.
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('session', true, [{ type: 'text', content: LANE_NOTICE }])).toBe(true);
    expect(shouldHideUiOnlyMessage('session', true, null)).toBe(true);
  });
});

describe('unchanged behavior', () => {
  it('errors are never hidden', async () => {
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('agent-error', true, 'boom')).toBe(false);
    expect(shouldHideUiOnlyMessage('session-error', true, 'boom')).toBe(false);
  });

  it('non-notification messages (real turn text) are never hidden', async () => {
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('session', false, LANE_NOTICE)).toBe(false);
    expect(shouldHideUiOnlyMessage(undefined, false, 'hello')).toBe(false);
  });

  it('an unknown source is never hidden', async () => {
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('quick-start', true, 'x')).toBe(false);
  });

  it('other categories still follow their own toggle', async () => {
    const { shouldHideUiOnlyMessage, setShowUiOnlyCategory } = await load();
    expect(shouldHideUiOnlyMessage('triage', true, 'a triage summary')).toBe(true);
    setShowUiOnlyCategory('triage', true);
    expect(shouldHideUiOnlyMessage('triage', true, 'a triage summary')).toBe(false);
  });

  it('degrades sanely (no throw) when localStorage is denied', async () => {
    // Private browsing: no toggle can be read, so there IS no explicit opt-out —
    // the lane notice stays visible (the user still sees the butler answer) while
    // an ordinary session summary stays hidden by its default. The filter runs on
    // every render, so the one unacceptable outcome is a throw.
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    });
    const { shouldHideUiOnlyMessage } = await load();
    expect(shouldHideUiOnlyMessage('session', true, LANE_NOTICE)).toBe(false);
    expect(shouldHideUiOnlyMessage('session', true, SESSION_RESULT)).toBe(true);
  });
});
