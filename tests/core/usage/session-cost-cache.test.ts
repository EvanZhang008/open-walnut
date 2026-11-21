/**
 * The session cost's stale-while-revalidate (src/core/usage/session-cost-cache.ts): the kept
 * value answers at once and starts one refresh; a `pending` answer never replaces it.
 */
import { describe, it, expect, vi } from 'vitest';
import { SwrCache } from '../../../src/core/usage/session-cost-cache.js';

type Value = { status: string; n: number };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function cache(read: (id: string) => Promise<Value>, now = () => 0) {
  return new SwrCache<Value>({ read, keep: (v) => v.status !== 'pending', max: 2, freshMs: 5_000, now });
}

describe('session cost cache', () => {
  it('answers the second read at once with the kept value and starts exactly one refresh', async () => {
    let clock = 0;
    const reads: ReturnType<typeof deferred<Value>>[] = [];
    const c = cache(() => { const d = deferred<Value>(); reads.push(d); return d.promise; }, () => clock);
    const first = c.get('s1');
    reads[0]!.resolve({ status: 'priced', n: 1 });
    expect(await first).toEqual({ status: 'priced', n: 1 });

    clock = 10_000;
    // The refresh hangs (a cold transcript): both reads still answer at once with the kept value.
    expect(await c.get('s1')).toEqual({ status: 'priced', n: 1 });
    expect(await c.get('s1')).toEqual({ status: 'priced', n: 1 });
    expect(reads).toHaveLength(2);
    reads[1]!.resolve({ status: 'priced', n: 2 });
    await reads[1]!.promise;
    await Promise.resolve();
    expect(c.peek('s1')).toEqual({ status: 'priced', n: 2 });
  });

  it('a fresh kept value starts no refresh', async () => {
    const read = vi.fn(async () => ({ status: 'priced', n: 1 }));
    const c = cache(read);
    await c.get('s1');
    await c.get('s1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a pending refresh keeps the priced value; with nothing kept the pending answer is passed on', async () => {
    let clock = 0;
    let answer: Value = { status: 'pending', n: 0 };
    const c = cache(async () => answer, () => clock);
    expect(await c.get('s1')).toEqual({ status: 'pending', n: 0 });
    answer = { status: 'priced', n: 5 };
    expect(await c.get('s1')).toEqual({ status: 'priced', n: 5 });
    answer = { status: 'pending', n: 0 };
    clock = 10_000;
    expect(await c.get('s1')).toEqual({ status: 'priced', n: 5 });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.peek('s1')).toEqual({ status: 'priced', n: 5 });
  });

  it('a failed refresh keeps the value, and a 404 forgets it', async () => {
    let clock = 0;
    let fail: unknown = null;
    const c = cache(async () => { if (fail) throw fail; return { status: 'priced', n: 1 }; }, () => clock);
    await c.get('s1');
    clock = 10_000;
    fail = new Error('host gone');
    expect(await c.get('s1')).toEqual({ status: 'priced', n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.peek('s1')).toEqual({ status: 'priced', n: 1 });
    clock = 20_000;
    fail = Object.assign(new Error('session not found'), { statusCode: 404 });
    await c.get('s1');
    await new Promise((r) => setTimeout(r, 0));
    expect(c.peek('s1')).toBeUndefined();
  });

  it('a turn end only marks the kept value stale: nothing is read until the next request', async () => {
    let n = 0;
    const read = vi.fn(async () => ({ status: 'priced', n: ++n }));
    const c = cache(read, () => 0);
    await c.get('s1');
    c.invalidate('s1');
    c.invalidate('other');
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(await c.get('s1')).toEqual({ status: 'priced', n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(2);
    expect(c.peek('s1')).toEqual({ status: 'priced', n: 2 });
  });

  it('a read begun before a turn end lands stale, so the next request reads again', async () => {
    const reads: ReturnType<typeof deferred<Value>>[] = [];
    const c = cache(() => { const d = deferred<Value>(); reads.push(d); return d.promise; }, () => 0);
    const first = c.get('s1');
    c.invalidate('s1');
    reads[0]!.resolve({ status: 'priced', n: 1 });
    await first;
    expect(await c.get('s1')).toEqual({ status: 'priced', n: 1 });
    expect(reads).toHaveLength(2);
  });

  it('keeps at most `max` sessions, the least recently read dropped first', async () => {
    const c = cache(async (id) => ({ status: 'priced', n: id.length }));
    await c.get('a'); await c.get('bb'); await c.get('a'); await c.get('ccc');
    expect(c.peek('a')).toBeDefined();
    expect(c.peek('bb')).toBeUndefined();
    expect(c.peek('ccc')).toBeDefined();
  });
});
