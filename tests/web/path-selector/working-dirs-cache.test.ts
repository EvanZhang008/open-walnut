/**
 * The working-dirs cache behind the folder picker: stale-while-revalidate on
 * open, a refresh when the host config changes, and per-host pre-warm selection.
 * Pure tests: the loader is a scripted fake, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  createWorkingDirsCache,
  configChangeMayAffectHosts,
  hostsToPrewarm,
  type WorkingDirsResult,
} from '../../../web/src/api/working-dirs-cache';

const NO_HOST: WorkingDirsResult = { dirs: [], hosts: [] };
const WITH_DEVBOX: WorkingDirsResult = { dirs: [], hosts: [{ alias: 'devbox', label: 'Big dev box' }] };

/** A loader whose answers resolve only when the test says so. */
function scriptedLoader() {
  const pending: Array<(r: WorkingDirsResult) => void> = [];
  let calls = 0;
  const load = () => {
    calls++;
    return new Promise<WorkingDirsResult>((resolve) => { pending.push(resolve); });
  };
  return {
    load,
    get calls() { return calls; },
    /** Resolve the i-th request (0-based) with a deep copy of `r`. */
    answer(i: number, r: WorkingDirsResult) { pending[i](structuredClone(r)); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createWorkingDirsCache', () => {
  it('fetch serves the cached answer after the first load', async () => {
    const l = scriptedLoader();
    const cache = createWorkingDirsCache(l.load);
    const first = cache.fetch();
    l.answer(0, NO_HOST);
    expect(await first).toEqual(NO_HOST);
    expect(await cache.fetch()).toEqual(NO_HOST);
    expect(l.calls).toBe(1);
  });

  it('revalidate refetches: an equal answer keeps the cached object, a new host replaces it', async () => {
    const l = scriptedLoader();
    const cache = createWorkingDirsCache(l.load);
    const p0 = cache.fetch();
    l.answer(0, NO_HOST);
    const cached = await p0;

    const p1 = cache.revalidate();
    // Stale-while-revalidate: the old answer stays readable while the request runs.
    expect(cache.peek()).toBe(cached);
    l.answer(1, NO_HOST);
    expect(await p1).toBe(cached);

    const p2 = cache.revalidate();
    l.answer(2, WITH_DEVBOX);
    const fresh = await p2;
    expect(fresh).not.toBe(cached);
    expect(fresh.hosts.map(h => h.alias)).toEqual(['devbox']);
    expect(cache.peek()).toBe(fresh);
    expect(l.calls).toBe(3);
  });

  it('revalidate joins a request already in flight', async () => {
    const l = scriptedLoader();
    const cache = createWorkingDirsCache(l.load);
    const a = cache.fetch();
    const b = cache.revalidate();
    l.answer(0, WITH_DEVBOX);
    expect(await a).toBe(await b);
    expect(l.calls).toBe(1);
  });

  it('refresh supersedes an older in-flight request, whichever lands first', async () => {
    for (const order of ['old-first', 'new-first'] as const) {
      const l = scriptedLoader();
      const cache = createWorkingDirsCache(l.load);
      const older = cache.revalidate();   // started before the host was added
      const newer = cache.refresh();      // started after config:changed
      expect(l.calls).toBe(2);
      if (order === 'old-first') { l.answer(0, NO_HOST); await flush(); l.answer(1, WITH_DEVBOX); }
      else { l.answer(1, WITH_DEVBOX); await flush(); l.answer(0, NO_HOST); }
      // The older caller never applies the pre-change answer.
      expect((await older).hosts.map(h => h.alias)).toEqual(['devbox']);
      expect((await newer).hosts.map(h => h.alias)).toEqual(['devbox']);
      expect(cache.peek()?.hosts.map(h => h.alias)).toEqual(['devbox']);
    }
  });

  it('invalidate drops the value, and a request from before it does not bring it back', async () => {
    const l = scriptedLoader();
    const cache = createWorkingDirsCache(l.load);
    const p0 = cache.fetch();
    l.answer(0, NO_HOST);
    await p0;
    const stale = cache.revalidate();
    cache.invalidate();
    expect(cache.peek()).toBeNull();
    l.answer(1, NO_HOST);
    expect(await stale).toEqual(NO_HOST); // its caller still gets an answer
    expect(cache.peek()).toBeNull();
    const next = cache.fetch();
    expect(l.calls).toBe(3);
    l.answer(2, WITH_DEVBOX);
    expect((await next).hosts).toHaveLength(1);
  });

  it('a failed load rejects and leaves the cached answer in place', async () => {
    let fail = false;
    const cache = createWorkingDirsCache(() => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(NO_HOST)));
    const cached = await cache.fetch();
    fail = true;
    await expect(cache.revalidate()).rejects.toThrow('offline');
    expect(cache.peek()).toBe(cached);
  });
});

describe('configChangeMayAffectHosts', () => {
  const known = [{ alias: 'devbox', label: 'Big dev box' }];

  it('keyed writers (focus bar, favorites, ordering, tiers) never touch hosts', () => {
    for (const key of ['focus_bar', 'favorites', 'ordering', 'focus_tiers', 'agent']) {
      expect(configChangeMayAffectHosts({ key }, known)).toBe(false);
    }
  });

  it('a full config write compares its enabled hosts with the known ones', () => {
    const same = { config: { hosts: { devbox: { hostname: 'devbox.example.test', label: 'Big dev box' } } } };
    expect(configChangeMayAffectHosts(same, known)).toBe(false);
    const added = { config: { hosts: { ...same.config.hosts, lab: { hostname: 'lab.example.test' } } } };
    expect(configChangeMayAffectHosts(added, known)).toBe(true);
    const renamed = { config: { hosts: { devbox: { hostname: 'devbox.example.test', label: 'Renamed' } } } };
    expect(configChangeMayAffectHosts(renamed, known)).toBe(true);
    const disabled = { config: { hosts: { devbox: { hostname: 'devbox.example.test', enabled: false } } } };
    expect(configChangeMayAffectHosts(disabled, known)).toBe(true);
    // A disabled host added alongside changes nothing the picker shows.
    const addedDisabled = { config: { hosts: { ...same.config.hosts, lab: { hostname: 'x', enabled: false } } } };
    expect(configChangeMayAffectHosts(addedDisabled, known)).toBe(false);
    // An unlabeled host is shown under its alias, as the server does.
    expect(configChangeMayAffectHosts({ config: { hosts: { lab: { hostname: 'x' } } } }, [{ alias: 'lab', label: 'lab' }])).toBe(false);
  });

  it('a partial config without hosts (a plugin setting) is not about hosts', () => {
    expect(configChangeMayAffectHosts({ config: { plugins: { demo: {} } } }, known)).toBe(false);
  });

  it('an event with nothing to compare, or no known hosts yet, refetches', () => {
    expect(configChangeMayAffectHosts(undefined, known)).toBe(true);
    expect(configChangeMayAffectHosts({}, known)).toBe(true);
    expect(configChangeMayAffectHosts({ key: 'hosts' }, known)).toBe(true);
    expect(configChangeMayAffectHosts({ config: { hosts: {} } }, null)).toBe(true);
  });
});

describe('hostsToPrewarm', () => {
  const result: WorkingDirsResult = {
    dirs: [
      { cwd: '/srv/app', host: 'devbox', project: '', count: 9, lastUsed: '2026-09-20T00:00:00Z' },
      { cwd: '/srv/old', host: 'devbox', project: '', count: 1, lastUsed: '2026-09-01T00:00:00Z' },
      { cwd: '/Users/alice/code', host: null, project: '', count: 3, lastUsed: '2026-09-20T00:00:00Z' },
    ],
    hosts: [{ alias: 'devbox', label: 'Big dev box' }, { alias: 'lab', label: 'Lab' }],
  };

  it('warms each remote host once: its best history folder, else ~/', () => {
    expect(hostsToPrewarm(result, new Set())).toEqual([['devbox', '/srv/app'], ['lab', '~/']]);
  });

  it('a host that appears later is warmed without re-warming the others', () => {
    const warmed = new Set(['devbox']);
    expect(hostsToPrewarm(result, warmed)).toEqual([['lab', '~/']]);
    expect(hostsToPrewarm(result, new Set(['devbox', 'lab']))).toEqual([]);
  });
});
