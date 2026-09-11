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
 *
 * The second half of the file is the case that refusal creates (2026-09-09): the
 * Mac app's window is never hidden, so "wait for a hidden moment" meant a whole
 * evening on a bundle six deploys old, silently. Staying silent is the bug — the
 * reload rules do not change, we just publish the drift and let the HUMAN click.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getStaleBuild,
  initStaleBuildUpgrade,
  subscribeStaleBuild,
  type StaleBuildUpgradeDeps,
} from '../../web/src/utils/stale-assets';

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
  /** How many callbacks are waiting on exactly `ms` — "was the clock restarted?". */
  countAt(ms: number): number {
    return [...this.pending.values()].filter((t) => t.ms === ms).length;
  }
  get size() { return this.pending.size; }
}

const SETTLE_MS = 5_000;
const HIDDEN_GRACE_MS = 20_000;
/** STALE_VISIBLE_PROMPT_MS: drift must persist this long before the human is told. */
const PROMPT_MS = 3 * 60_000;
/** PERIODIC_CHECK_MS: the re-check for a deploy that never bounced the WS. */
const PERIODIC_MS = 10 * 60_000;
/** MIN_FETCH_INTERVAL_MS: at most one /api/config from this module per minute. */
const MIN_FETCH_MS = 60_000;

/** The served() promise plus the async check body. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface Harness {
  teardown: () => void;
  timers: FakeTimers;
  reload: ReturnType<typeof vi.fn>;
  reconnect: () => void;
  visibilityChanged: () => void;
  state: { running: string | null; served: string | null; hidden: boolean; unsaved: boolean };
  session: FakeStorage;
  /** Manual clock, so the fetch rate limit is a fact and not a race. */
  clock: { t: number };
  /** reconnect → settle → the served-bundle promise resolves. */
  reconnectAndSettle: () => Promise<void>;
}

function harness(over?: Partial<StaleBuildUpgradeDeps>): Harness {
  const timers = new FakeTimers();
  const reload = vi.fn();
  const session = new FakeStorage();
  const clock = { t: 1_700_000_000_000 };
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
    now: () => clock.t,
    ...over,
  });

  const reconnect = () => onReconnect?.();
  const visibilityChanged = () => onVisibility?.();
  return {
    teardown, timers, reload, reconnect, visibilityChanged, state, session, clock,
    reconnectAndSettle: async () => {
      reconnect();
      timers.fire(SETTLE_MS);
      await flush();
    },
  };
}

let h: Harness;
beforeEach(() => { h = harness(); });
// The published drift is a MODULE store, so a test that leaves it set would leak
// into the next one. Teardown retracts it; calling it twice is a no-op.
afterEach(() => { h.teardown(); });

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

describe('telling the human when the tab cannot be healed quietly', () => {
  it('publishes the drift after three minutes on a visible tab', async () => {
    const seen = vi.fn();
    const unsubscribe = subscribeStaleBuild(seen);
    h.state.hidden = false;
    await h.reconnectAndSettle();
    expect(getStaleBuild(), 'silence first: a tab about to be hidden heals on its own').toBeNull();
    h.timers.fire(PROMPT_MS);
    expect(getStaleBuild()).toEqual({ running: 'OLD', served: 'NEW' });
    expect(seen).toHaveBeenCalledTimes(1);
    // The whole point: telling the human is NOT reloading under them.
    expect(h.reload).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('retracts the prompt once the server serves what this tab runs', async () => {
    h.state.hidden = false;
    await h.reconnectAndSettle();
    h.timers.fire(PROMPT_MS);
    expect(getStaleBuild()).not.toBeNull();
    // A rollback, or a deploy of the very build this tab already runs.
    h.state.served = 'OLD';
    h.clock.t += MIN_FETCH_MS;
    await h.reconnectAndSettle();
    expect(getStaleBuild()).toBeNull();
  });

  it('a deploy storm keeps the original clock and never flashes the pill', async () => {
    h.state.hidden = false;
    await h.reconnectAndSettle();
    expect(h.timers.countAt(PROMPT_MS)).toBe(1);
    // Second deploy of the hour, before the three minutes are up. Re-arming here
    // would push the prompt out for as long as deploys keep landing.
    h.state.served = 'NEWER';
    h.clock.t += MIN_FETCH_MS;
    await h.reconnectAndSettle();
    expect(h.timers.countAt(PROMPT_MS), 'still the first clock').toBe(1);
    h.timers.fire(PROMPT_MS);
    expect(getStaleBuild()).toEqual({ running: 'OLD', served: 'NEWER' });
    // Third deploy AFTER the pill is up: the label follows the server, but the
    // pill must not blink out and back in.
    h.state.served = 'NEWEST';
    h.clock.t += MIN_FETCH_MS;
    await h.reconnectAndSettle();
    expect(getStaleBuild()).toEqual({ running: 'OLD', served: 'NEWEST' });
    expect(h.timers.countAt(PROMPT_MS), 'no second prompt armed on top of a live one').toBe(0);
  });

  it('leaves the hidden tab healing silently — nothing to tell', async () => {
    h.state.hidden = true;
    await h.reconnectAndSettle();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(getStaleBuild(), 'a reload nobody had to be asked about needs no pill').toBeNull();
  });

  it('escalates a hidden tab that could not be reloaded over a draft', async () => {
    h.state.hidden = true;
    h.state.unsaved = true;
    await h.reconnectAndSettle();
    h.timers.fire(HIDDEN_GRACE_MS);
    expect(h.reload, 'the draft still wins over the reload').not.toHaveBeenCalled();
    // Refusing forever in silence is how the incident happened: the user has to
    // learn that saving their text is what unblocks the upgrade.
    h.timers.fire(PROMPT_MS);
    expect(getStaleBuild()).toEqual({ running: 'OLD', served: 'NEW' });
  });

  it('re-checks on a timer, so a deploy that never bounces the WS is noticed', async () => {
    const served = vi.fn(() => Promise.resolve('NEW' as string | null));
    const t = harness({ served });
    try {
      // No reconnect at all: the socket stayed up straight through the deploy.
      t.clock.t += PERIODIC_MS;
      t.timers.fire(PERIODIC_MS);
      await flush();
      expect(served).toHaveBeenCalledTimes(1);
      t.timers.fire(PROMPT_MS);
      expect(getStaleBuild()).toEqual({ running: 'OLD', served: 'NEW' });
      // …and the cycle re-arms rather than firing once and stopping.
      t.state.hidden = true;
      t.clock.t += PERIODIC_MS;
      t.timers.fire(PERIODIC_MS);
      await flush();
      expect(served, 'a hidden tab is nobody\'s problem this second').toHaveBeenCalledTimes(1);
      t.state.hidden = false;
      t.clock.t += PERIODIC_MS;
      t.timers.fire(PERIODIC_MS);
      await flush();
      expect(served).toHaveBeenCalledTimes(2);
    } finally {
      t.teardown();
    }
  });

  it('asks the server at most once a minute, and defers the ask it skipped', async () => {
    const served = vi.fn(() => Promise.resolve('NEW' as string | null));
    const t = harness({ served });
    try {
      await t.reconnectAndSettle();
      expect(served).toHaveBeenCalledTimes(1);
      // A flapping socket reconnects again seconds later.
      t.clock.t += 5_000;
      await t.reconnectAndSettle();
      expect(served).toHaveBeenCalledTimes(1);
      // Deferred, not dropped: a deploy is exactly when the WS bounces, and
      // losing that check means ten more minutes on the old bundle.
      t.clock.t += MIN_FETCH_MS;
      t.timers.fire(MIN_FETCH_MS);
      await flush();
      expect(served).toHaveBeenCalledTimes(2);
    } finally {
      t.teardown();
    }
  });

  it('an offline second changes nothing — neither the pill nor the arming', async () => {
    let bundle: string | null = 'NEW';
    const t = harness({ served: () => Promise.resolve(bundle) });
    try {
      t.state.hidden = false;
      await t.reconnectAndSettle();
      t.timers.fire(PROMPT_MS);
      expect(getStaleBuild()).toEqual({ running: 'OLD', served: 'NEW' });
      // The server is briefly unreachable. Claiming the tab is current here
      // would retract a pill that is still true.
      bundle = null;
      t.clock.t += MIN_FETCH_MS;
      await t.reconnectAndSettle();
      expect(getStaleBuild()).toEqual({ running: 'OLD', served: 'NEW' });
    } finally {
      t.teardown();
    }
  });

  it('teardown retracts the prompt', async () => {
    h.state.hidden = false;
    await h.reconnectAndSettle();
    h.timers.fire(PROMPT_MS);
    expect(getStaleBuild()).not.toBeNull();
    h.teardown();
    expect(getStaleBuild()).toBeNull();
    expect(h.timers.size).toBe(0);
  });
});
