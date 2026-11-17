/**
 * Which host problems toast (web/src/utils/host-problem-toasts.ts): once when a problem row
 * first appears, never again on a reload while the host stays down, again after it healed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BannerRow } from '../../web/src/utils/attention-banner-model';
import {
  TOASTED_STORAGE_KEY, decideHostToasts, hostToastText, problemKeyOf, readToasted, sameToasted, writeToasted, type ToastedProblems,
} from '../../web/src/utils/host-problem-toasts';
import { NOT_QUIET, quietAllowsToast, type QuietState } from '../../web/src/contexts/notifications/quiet-model';
import { IS_PERSISTENT, SHOULD_TOAST } from '../../web/src/contexts/notifications/types';

const row = (host: string, over: Partial<BannerRow> = {}): BannerRow => ({
  id: `host:${host}`, type: 'connect', group: 'connect', hosts: [host], labels: [host],
  headline: `Could not connect to ${host}`, hint: 'Check that it is on.', dismissKeys: [`${host}|connect`], actions: ['retry'],
  ...over,
});

/** The memory as it holds rows: entries by problemKeyOf. */
const known = (entries: Array<[string, string[]]>): ToastedProblems => new Map(entries.map(([id, hosts]) => [problemKeyOf(row(hosts[0], { id, hosts })), hosts]));
const all = () => true;
const none = () => false;

describe('decideHostToasts', () => {
  it('toasts a new problem and remembers it', () => {
    const d = decideHostToasts([row('home-pc')], known([]), all, none);
    expect(d.toast.map((r) => r.id)).toEqual(['host:home-pc']);
    expect([...d.known.keys()]).toEqual([problemKeyOf(row('home-pc'))]);
  });

  it('does not toast a problem it already toasted (a reload, a new frame)', () => {
    const d = decideHostToasts([row('home-pc'), row('mac')], known([['host:home-pc', ['home-pc']]]), all, none);
    expect(d.toast.map((r) => r.id)).toEqual(['host:mac']);
  });

  it('keeps a problem known while its row is away but the host is still unhealthy (an auto retry)', () => {
    const d = decideHostToasts([], known([['host:home-pc', ['home-pc']]]), all, none);
    expect(d.known.has(problemKeyOf(row('home-pc')))).toBe(true);
    expect(d.healed).toEqual([]);
    // The row comes back: no second toast.
    expect(decideHostToasts([row('home-pc')], d.known, all, none).toast).toEqual([]);
  });

  it('forgets a problem once its host healed, so the next outage toasts again', () => {
    const d = decideHostToasts([], known([['host:home-pc', ['home-pc']]]), all, all);
    expect(d.known.size).toBe(0);
    expect(d.healed).toEqual(['home-pc']);
    expect(decideHostToasts([row('home-pc')], d.known, all, none).toast).toHaveLength(1);
  });

  it('forgets a host removed from the config', () => {
    const d = decideHostToasts([], known([['host:gone', ['gone']]]), none, none);
    expect(d.known.size).toBe(0);
    expect(d.healed).toEqual([]);
  });
});

describe('once per host until it heals', () => {
  it('a host whose cause changed while still broken toasts nothing; a host that joins a group toasts', () => {
    // 2026-11-17, the user: "if it show once don't show it so many times".
    const was = known([['host:home-pc', ['home-pc']]]);
    const readiness = row('home-pc', { type: 'readiness', group: 'readiness', kind: 'claude_missing' });
    expect(decideHostToasts([readiness], was, all, none).toast).toHaveLength(0);
    const group = (hosts: string[]) => row(hosts[0], { id: 'cred:agent_missing', kind: 'agent_missing', hosts, labels: hosts });
    const one = decideHostToasts([group(['a'])], new Map(), all, none);
    expect(decideHostToasts([group(['a'])], one.known, all, none).toast).toHaveLength(0);
    expect(decideHostToasts([group(['a', 'b'])], one.known, all, none).toast).toHaveLength(1);
  });

  it('the same problem reported again and again, its cause flapping, toasts once; healed and broken again, once more', () => {
    let memory = new Map<string, readonly string[]>();
    let toasts = 0;
    const kinds = ['daemon', 'timeout', 'unknown', 'daemon', 'unreachable', 'timeout', 'daemon', 'unknown', 'daemon', 'timeout'];
    for (const kind of kinds) {
      const d = decideHostToasts([row('chrismac', { kind })], memory, all, none);
      toasts += d.toast.length;
      memory = new Map(d.known);
    }
    expect(toasts).toBe(1);
    // It heals (no problem row, the host healthy), then breaks again: a new time.
    memory = new Map(decideHostToasts([], memory, all, all).known);
    expect(decideHostToasts([row('chrismac', { kind: 'daemon' })], memory, all, none).toast).toHaveLength(1);
  });

  it('sameToasted compares entries and hosts', () => {
    expect(sameToasted(known([['host:a', ['a']]]), known([['host:a', ['a']]]))).toBe(true);
    expect(sameToasted(known([['host:a', ['a']]]), new Map())).toBe(false);
  });
});

describe('the toasted memory survives a reload', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('round-trips through localStorage', () => {
    writeToasted(new Map([['host:home-pc#connect#home-pc', ['home-pc']], ['cred:agent#agent#a,b', ['a', 'b']]]));
    expect([...readToasted()]).toEqual([['host:home-pc#connect#home-pc', ['home-pc']], ['cred:agent#agent#a,b', ['a', 'b']]]);
  });

  it('reads garbage as empty', () => {
    localStorage.setItem(TOASTED_STORAGE_KEY, '{not json');
    expect(readToasted().size).toBe(0);
    localStorage.setItem(TOASTED_STORAGE_KEY, JSON.stringify({ 'host:x': 'nope', 'host:y': ['y', 3] }));
    expect([...readToasted()]).toEqual([['host:y', ['y']]]);
  });
});

describe('hostToastText', () => {
  it('one host: its headline and hint', () => {
    expect(hostToastText([row('home-pc')])).toEqual({ title: 'Could not connect to home-pc', body: 'Check that it is on.' });
  });

  it('several: a count and each headline', () => {
    expect(hostToastText([row('home-pc'), row('mac')])).toEqual({
      title: '2 remote hosts need attention', body: 'Could not connect to home-pc. Could not connect to mac',
    });
  });
});

describe("the 'host' toast kind", () => {
  it('toasts only a problem the person must clear, stays out of the feed (the panel lists the live problem), and quiet mode holds it', () => {
    // audience.ts: a host Walnut reconnects by itself is Walnut Health's (2026-11-17).
    expect(SHOULD_TOAST({ kind: 'host', severity: 'error' })).toBe(false);
    expect(SHOULD_TOAST({ kind: 'host', severity: 'error', needsYou: 'sign-in' })).toBe(true);
    expect(IS_PERSISTENT.host).toBe(false);
    const quiet: QuietState = { active: true, allowPermissions: false, holds: [{ source: 'user' } as QuietState['holds'][number]] };
    expect(quietAllowsToast(NOT_QUIET, 'host')).toBe(true);
    // A feedback kind (an Undo hint) still shows in quiet; a host problem does not.
    expect(quietAllowsToast(quiet, 'hint')).toBe(true);
    expect(quietAllowsToast(quiet, 'host')).toBe(false);
  });
});
