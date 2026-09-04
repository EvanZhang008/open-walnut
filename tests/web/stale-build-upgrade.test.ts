/**
 * Moving a stale tab onto the current build WITHOUT reloading under a click.
 *
 * The reported bug (2026-09-03, Mac app): "I click a path, the page flashes,
 * nothing opens. After it settles I click again and the Files panel appears."
 * The reload was ours — `vite:preloadError` recovery firing the moment the click
 * asked for a chunk a deploy had deleted. The server now keeps old chunks
 * servable, so nothing breaks mid-click; this is the other half: pick a moment
 * NOBODY is looking and get onto the new build then.
 *
 * The rule under test, and every way it must refuse:
 *   reconnect → settle → compare bundles → reload only while HIDDEN, only with
 *   no unsaved text, only within the rate limit, and never on an unknown.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initStaleBuildUpgrade, type StaleBuildUpgradeDeps } from '../../web/src/utils/stale-assets';

class FakeStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

/** Manual clock: every scheduled callback fires only when the test says so. */
class FakeTimers {
  private pending = new Map<number, { fn: () => void; ms: number }>();
  private nextId = 1;
  set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clear = (id: unknown): void => { this.pending.delete(id as number); };
  /** Fire every callback scheduled for exactly `ms`. */
  fire(ms: number): void {
    for (const [id, t] of [...this.pending]) {
      if (t.ms !== ms) continue;
      this.pending.delete(id);
      t.fn();
    }
  }
  get size() { return this.pending.size; }
}

const SETTLE_MS = 5_000;
const HIDDEN_GRACE_MS = 20_000;

interface Harness {
  teardown: () => void;
  timers: FakeTimers;
  reload: ReturnType<typeof vi.fn>;
  reconnect: () => void;
  visibilityChanged: () => void;
  state: { running: string | null; served: string | null; hidden: boolean; unsaved: boolean };
  session: FakeStorage;
  /** reconnect → settle → the served-bundle promise resolves. */
  reconnectAndSettle: () => Promise<void>;
}

function harness(over?: Partial<StaleBuildUpgradeDeps>): Harness {
  const timers = new FakeTimers();
  const reload = vi.fn();
  const session = new FakeStorage();
  const state = { running: 'OLD' as string | null, served: 'NEW' as string | null, hidden: false, unsaved: false };
  let onReconnect: (() => void) | null = null;
  let onVisibility: (() => void) | null = null;

  const teardown = initStaleBuildUpgrade({
    running: () => state.running,
    served: () => Promise.resolve(state.served),
    hidden: () => state.hidden,
    onReconnect: (cb) => { onReconnect = cb; return () => { onReconnect = null; }; },
    onVisibility: (cb) => { onVisibility = cb; return () => { onVisibility = null; }; },
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    hasUnsaved: () => state.unsaved,
    reload,
    session: session as unknown as Storage,
    now: () => Date.now(),
    ...over,
  });

  const reconnect = () => onReconnect?.();
  const visibilityChanged = () => onVisibility?.();
  return {
    teardown, timers, reload, reconnect, visibilityChanged, state, session,
    reconnectAndSettle: async () => {
      reconnect();
      timers.fire(SETTLE_MS);
      // The served() promise plus the async check body.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

let h: Harness;
beforeEach(() => { h = harness(); });

describe('stale-build upgrade', () => {
  it('does NOT reload while the tab is visible — the reported flash', async () => {
    h.state.hidden = false;
    await h.reconnectAndSettle();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).not.toHaveBeenCalled();
    h.teardown();
  });

  it('reloads once the tab has been hidden for the grace period', async () => {
    h.state.hidden = false;
    await h.reconnectAndSettle();
    // The user switches away.
    h.state.hidden = true;
    h.visibilityChanged();
    expect(h.reload, 'hiding alone is not enough — the grace must elapse').not.toHaveBeenCalled();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.teardown();
  });

  it('a tab already hidden at reconnect still waits out the grace', async () => {
    h.state.hidden = true;
    await h.reconnectAndSettle();
    expect(h.reload).not.toHaveBeenCalled();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.teardown();
  });

  it('cancels when the user comes back mid-grace', async () => {
    h.state.hidden = true;
    await h.reconnectAndSettle();
    // Back before the grace elapses.
    h.state.hidden = false;
    h.visibilityChanged();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).not.toHaveBeenCalled();
    // …and it re-arms for the next time they leave.
    h.state.hidden = true;
    h.visibilityChanged();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.teardown();
  });

  it('never reloads on top of unsaved text, however long the tab is hidden', async () => {
    h.state.hidden = true;
    h.state.unsaved = true;
    await h.reconnectAndSettle();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).not.toHaveBeenCalled();
    h.teardown();
  });

  it('does nothing when the bundles match', async () => {
    h.state.served = 'OLD';
    h.state.hidden = true;
    await h.reconnectAndSettle();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).not.toHaveBeenCalled();
    h.teardown();
  });

  it('does nothing on an UNKNOWN — a reload on a guess is the bug, not the fix', async () => {
    for (const unknown of [{ running: null }, { served: null }]) {
      const t = harness();
      Object.assign(t.state, { hidden: true }, unknown);
      await t.reconnectAndSettle();
      t.timers.fire(HIDDEN_GRACE_MS);
      expect(t.reload).not.toHaveBeenCalled();
      t.teardown();
    }
  });

  it('survives a failing bundle query without reloading', async () => {
    const t = harness({ served: () => Promise.reject(new Error('offline')) });
    t.state.hidden = true;
    await t.reconnectAndSettle();
    t.timers.fire(HIDDEN_GRACE_MS);
    expect(t.reload).not.toHaveBeenCalled();
    t.teardown();
  });

  it('waits out the settle delay instead of hitting a seconds-old server', async () => {
    h.state.hidden = true;
    h.reconnect();
    // No settle fire: the check has not run, so nothing is armed yet.
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).not.toHaveBeenCalled();
    h.teardown();
  });

  it('stops after the rate limit rather than reload-looping', async () => {
    // A server that keeps reporting a different bundle (a mismatched deploy, a
    // proxy serving an old index) must not spin the tab. The reload count is
    // asserted EXACTLY: "at most 3" also passes when nothing reloads at all,
    // which would hide the rule failing open.
    const reloads: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = harness({ session: h.session as unknown as Storage });
      t.state.hidden = true;
      await t.reconnectAndSettle();
      t.timers.fire(HIDDEN_GRACE_MS);
      reloads.push(t.reload.mock.calls.length);
      t.teardown();
    }
    // MAX_RELOADS is 3 within the window, shared through sessionStorage: the
    // first three attempts reload, the last two are refused.
    expect(reloads).toEqual([1, 1, 1, 0, 0]);
    const history = JSON.parse(h.session.getItem('open-walnut-stale-asset-reloads') ?? '[]');
    expect(history).toHaveLength(3);
    h.teardown();
  });

  it('teardown drops every listener and timer', async () => {
    h.state.hidden = true;
    await h.reconnectAndSettle();
    h.teardown();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);
  });
});
