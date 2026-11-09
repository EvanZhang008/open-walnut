import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRouterSource, currentRouterSources, readRouterItem, registerRouterSource, resolveRouterItem,
  type RouterItemContent, type RouterSourceAdapter,
} from '../../src/core/router/source-registry.js';
import type { RouterSource } from '../../src/core/router/types.js';

const source = { kind: 'wechat' as const, account: 'fixture', message: 'item-1' };
const itemOf = (one: RouterSource, key = 'key') => ({ source: one, key, sender: 'sender', subject: 'subject' });
const contentOf = (one: RouterSource): RouterItemContent => ({
  item: itemOf(one), body: { text: 'body' }, bodyAvailable: true, attachments: [], attachmentsAvailable: false,
});
const changedSources: RouterSource[] = [
  { ...source, account: 'other' }, { ...source, message: 'other' }, { ...source, kind: 'slack' },
  { ...source, account: 'Fixture' }, { ...source, message: ' item-1' },
];

/** Registers for the duration of `work` only, so no adapter outlives its test even when it fails. */
async function withAdapter(adapter: RouterSourceAdapter, work: () => Promise<void>): Promise<void> {
  const dispose = registerRouterSource('wechat', adapter);
  try { await work(); } finally { dispose(); }
}

afterEach(() => { vi.useRealTimers(); });

describe('router source identity', () => {
  it('refuses an adapter returning a different delivery version', async () => {
    const requested = { ...source, version: 'confirmed' };
    await withAdapter({ resolve: async () => itemOf({ ...source, version: 'later' }) }, async () => {
      await expect(resolveRouterItem(requested)).rejects.toThrow('identity does not match');
    });
  });

  it('accepts only the exact requested kind, account and message', async () => {
    for (const changed of changedSources) {
      await withAdapter({ resolve: async () => itemOf(changed) }, async () => {
        await expect(resolveRouterItem(source)).rejects.toThrow('identity does not match');
      });
    }
  });

  it('disposing an earlier plugin activation never removes the replacement adapter', async () => {
    const old = registerRouterSource('wechat', { resolve: async () => itemOf(source, 'old') });
    const current = registerRouterSource('wechat', { resolve: async () => itemOf(source, 'current') });
    try {
      old();
      expect((await resolveRouterItem(source)).key).toBe('current');
    } finally {
      old();
      current();
    }
    await expect(resolveRouterItem(source)).rejects.toThrow('not available');
  });
});

describe('router source cache-only read', () => {
  it('returns the adapter\'s content for the exact item', async () => {
    const read = vi.fn(async (one: RouterSource) => contentOf(one));
    await withAdapter({ resolve: async (one) => itemOf(one), read }, async () => {
      expect(await readRouterItem(source)).toEqual(contentOf(source));
      expect(read).toHaveBeenCalledWith(source);
    });
  });

  it('refuses content whose identity is not exactly the requested item', async () => {
    for (const changed of changedSources) {
      await withAdapter({ resolve: async () => itemOf(source), read: async () => contentOf(changed) }, async () => {
        await expect(readRouterItem(source)).rejects.toThrow('identity does not match');
      });
    }
  });

  it('is unavailable with no adapter, with an adapter that has no reader, and after dispose', async () => {
    await expect(readRouterItem(source)).rejects.toThrow('no cache-only content reader');

    const resolve = vi.fn(async (one: RouterSource) => itemOf(one));
    await withAdapter({ resolve }, async () => {
      await expect(readRouterItem(source)).rejects.toThrow('no cache-only content reader');
      // The reader never falls back to the resolver, or to any other source.
      expect(resolve).not.toHaveBeenCalled();
    });

    const read = vi.fn(async (one: RouterSource) => contentOf(one));
    const dispose = registerRouterSource('wechat', { resolve, read });
    dispose();
    await expect(readRouterItem(source)).rejects.toThrow('no cache-only content reader');
    expect(read).not.toHaveBeenCalled();
  });

  it('never reads through another kind\'s adapter', async () => {
    const read = vi.fn(async (one: RouterSource) => contentOf(one));
    const dispose = registerRouterSource('slack', { resolve: async (one) => itemOf(one), read });
    try {
      await expect(readRouterItem(source)).rejects.toThrow('no cache-only content reader');
      expect(read).not.toHaveBeenCalled();
    } finally { dispose(); }
  });

  it('marks adapter failures unavailable but preserves a confirmed cache miss', async () => {
    await withAdapter({ resolve: async () => { throw new Error('adapter offline'); }, read: async () => { throw Object.assign(new Error('not cached'), { code: 'source_missing' }); } }, async () => {
      await expect(resolveRouterItem(source)).rejects.toMatchObject({ code: 'source_unavailable' });
      await expect(readRouterItem(source)).rejects.toMatchObject({ code: 'source_missing' });
    });
    await expect(resolveRouterItem(source)).rejects.toMatchObject({ code: 'source_unavailable' });
  });

  it('passes an adapter failure through and leaves no timer behind', async () => {
    vi.useFakeTimers();
    await withAdapter({ resolve: async (one) => itemOf(one), read: async () => { throw new Error('cache read failed'); } }, async () => {
      await expect(readRouterItem(source)).rejects.toThrow('cache read failed');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('times out a read that never answers at 3 seconds, on a fake clock, and clears its timer', async () => {
    vi.useFakeTimers();
    await withAdapter({ resolve: async (one) => itemOf(one), read: () => new Promise<never>(() => {}) }, async () => {
      let settled = false;
      const pending = readRouterItem(source);
      pending.then(() => { settled = true; }, () => { settled = true; });
      const outcome = expect(pending).rejects.toThrow('Routing content lookup timed out.');
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('times out a resolve that never answers the same way', async () => {
    vi.useFakeTimers();
    await withAdapter({ resolve: () => new Promise<never>(() => {}) }, async () => {
      const pending = resolveRouterItem(source);
      const outcome = expect(pending).rejects.toThrow('Routing source lookup timed out.');
      await vi.advanceTimersByTimeAsync(3_000);
      await outcome;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('clears its timer after a prompt answer', async () => {
    vi.useFakeTimers();
    await withAdapter({ resolve: async (one) => itemOf(one), read: async (one) => contentOf(one) }, async () => {
      await readRouterItem(source);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('router source current check', () => {
  const mailOf = (message: string, version = 'v1'): RouterSource => ({ kind: 'mail', account: 'desk', message, version });
  const resolve = async (one: RouterSource) => itemOf(one);

  /** Registers several kinds for the duration of `work` only. */
  async function withKinds(kinds: Partial<Record<RouterSource['kind'], RouterSourceAdapter>>, work: () => Promise<void>): Promise<void> {
    const disposers = Object.entries(kinds).map(([kind, adapter]) => registerRouterSource(kind as RouterSource['kind'], adapter!));
    try { await work(); } finally { disposers.forEach((dispose) => dispose()); }
  }

  it('keeps the exact subset the adapter names, in input order, from frozen copies', async () => {
    const asked = [mailOf('m1'), mailOf('m2'), mailOf('m3')];
    const currentSources = vi.fn(async (sources: readonly RouterSource[]) => {
      expect(sources.every((one) => Object.isFrozen(one))).toBe(true);
      return [{ ...sources[2]! }, { ...sources[0]! }];
    });
    await withKinds({ mail: { resolve, currentSources } }, async () => {
      const current = await currentRouterSources(asked);
      expect(current).toEqual([asked[0], asked[2]]);
      expect(current[0]).toBe(asked[0]);
      expect(currentSources).toHaveBeenCalledTimes(1);
    });
  });

  it('calls each kind once, keeps a kind without the check whole, and fails closed for mail without one', async () => {
    const slack = { kind: 'slack' as const, account: 'team', message: 'ts-1' };
    const chat = { ...source };
    const mailCheck = vi.fn(async (sources: readonly RouterSource[]) => sources.filter((one) => one.message !== 'm2'));
    const chatCheck = vi.fn(async () => [] as RouterSource[]);
    const asked = [mailOf('m1'), slack, chat, mailOf('m2'), mailOf('m3')];
    await withKinds({ mail: { resolve, currentSources: mailCheck }, slack: { resolve }, wechat: { resolve, currentSources: chatCheck } }, async () => {
      expect(await currentRouterSources(asked)).toEqual([asked[0], slack, asked[4]]);
      expect(mailCheck).toHaveBeenCalledTimes(1);
      expect(mailCheck.mock.calls[0]![0]).toHaveLength(3);
      expect(chatCheck).toHaveBeenCalledTimes(1);
    });
    // No slack adapter at all still keeps slack items; mail with no adapter or no batch check is refused.
    expect(await currentRouterSources([slack])).toEqual([slack]);
    await expect(currentRouterSources([mailOf('m1')])).rejects.toMatchObject({ code: 'source_unavailable' });
    await withKinds({ mail: { resolve } }, async () => {
      await expect(currentRouterSources([mailOf('m1')])).rejects.toMatchObject({ code: 'source_unavailable' });
    });
    expect(await currentRouterSources([])).toEqual([]);
  });

  it('refuses an answer naming an item it was not asked about, a changed version, a duplicate or no list', async () => {
    const asked = [mailOf('m1'), mailOf('m2')];
    const answers: unknown[] = [
      [mailOf('m9')], [mailOf('m1', 'v2')], [{ ...mailOf('m1'), account: 'Desk' }], [{ kind: 'mail', account: 'desk', message: 'm1' }],
      [mailOf('m1'), mailOf('m1')], [{ ...mailOf('m1'), version: '' }], [null], 'm1', null,
    ];
    for (const answer of answers) {
      await withKinds({ mail: { resolve, currentSources: async () => answer as RouterSource[] } }, async () => {
        await expect(currentRouterSources(asked)).rejects.toMatchObject({ code: 'source_unavailable' });
      });
    }
  });

  it('turns an adapter failure into source_unavailable and times out at 3 seconds, clearing its timer', async () => {
    await withKinds({ mail: { resolve, currentSources: async () => { throw new Error('cache locked'); } } }, async () => {
      await expect(currentRouterSources([mailOf('m1')])).rejects.toMatchObject({ code: 'source_unavailable', message: 'cache locked' });
    });
    vi.useFakeTimers();
    await withKinds({ mail: { resolve, currentSources: () => new Promise<never>(() => {}) } }, async () => {
      const outcome = expect(currentRouterSources([mailOf('m1')])).rejects.toThrow('Routing source current check timed out.');
      await vi.advanceTimersByTimeAsync(3_000);
      await outcome;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('a plugin adapter may carry currentSources, only as a function', () => {
    expect(() => assertRouterSource('mail', { resolve, currentSources: async () => [] })).not.toThrow();
    expect(() => assertRouterSource('mail', { resolve, currentSources: [] })).toThrow('currentSources must be a function');
    expect(() => assertRouterSource('mail', { resolve, current: async () => [] })).toThrow('not "current"');
  });
});
