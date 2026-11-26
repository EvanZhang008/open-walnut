/**
 * The session cost's stale-while-revalidate (src/core/usage/session-cost-cache.ts): the kept
 * value answers at once and starts one refresh; a `pending` answer never replaces it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepOnDisk, SwrCache } from '../../../src/core/usage/session-cost-cache.js';
import { flushSessionCostDisk, getSessionCost, resetSessionCostCacheForTests, startSessionCostDisk } from '../../../src/core/usage/session-cost.js';

// No session is recorded: a refresh of a cost read back from disk answers 404.
vi.mock('../../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }));

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

const tmpFiles: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-disk-'));
  tmpFiles.push(dir);
  return path.join(dir, 'session-costs.json');
}
const isValue = (_id: string, v: unknown): v is Value => !!v && typeof (v as Value).status === 'string' && typeof (v as Value).n === 'number';
const onDisk = (c: SwrCache<Value>, file: string, maxBytes = 1_000_000) =>
  keepOnDisk(c, { file, version: 1, maxBytes, delayMs: 60_000, valid: isValue, onError: (err) => { throw err; } });
/** Resolves with the value, or 'waited' when it did not answer within a few ticks. */
async function atOnce<T>(p: Promise<T>): Promise<T | 'waited'> {
  return Promise.race([p, new Promise<'waited'>((r) => setTimeout(() => r('waited'), 20))]);
}

describe('session cost cache across a restart (disk copy)', () => {
  afterEach(async () => {
    // A write the cost module asked for goes now, before its folder is removed.
    await flushSessionCostDisk();
    resetSessionCostCacheForTests();
    for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // Guard (2026-11-25): 73 of the 77 cost reads over 1 s on 11-24/25 were a session's first read
  // after a restart, waiting seconds on the host for a long transcript. A restart must not empty
  // what the last process read: the first read answers at once and starts one refresh.
  it('a new process answers a session\'s first read from the disk copy, without waiting on the host', async () => {
    const file = tmpFile();
    const before = cache(async () => ({ status: 'priced', n: 1 }));
    const diskBefore = onDisk(before, file);
    await diskBefore.readback;
    await before.get('s1');
    await diskBefore.flush();

    // The new process's host read hangs (a cold 290 MB transcript).
    const reads: ReturnType<typeof deferred<Value>>[] = [];
    const after = cache(() => { const d = deferred<Value>(); reads.push(d); return d.promise; });
    await onDisk(after, file).readback;
    expect(await atOnce(after.get('s1'))).toEqual({ status: 'priced', n: 1 });
    // Read back means stale: exactly one refresh, and its answer replaces the value.
    expect(await atOnce(after.get('s1'))).toEqual({ status: 'priced', n: 1 });
    expect(reads).toHaveLength(1);
    reads[0]!.resolve({ status: 'priced', n: 2 });
    await reads[0]!.promise;
    await Promise.resolve();
    expect(after.peek('s1')).toEqual({ status: 'priced', n: 2 });
  });

  it('a value kept during the readback wins, and the restored ones go to the old end of the cap', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [['a', { status: 'priced', n: 1 }], ['b', { status: 'priced', n: 1 }]] }));
    const c = cache(async () => ({ status: 'priced', n: 9 }));
    await c.get('b');
    await onDisk(c, file).readback;
    expect(c.peek('b')).toEqual({ status: 'priced', n: 9 });
    expect(c.kept().map(([id]) => id)).toEqual(['a', 'b']);
    await c.get('x'); // max 2: the restored 'a' goes first
    expect(c.peek('a')).toBeUndefined();
  });

  it('a file of another version, one that does not parse, or a value of another shape reads as none', async () => {
    for (const body of [JSON.stringify({ v: 2, entries: [['a', { status: 'priced', n: 1 }]] }), '{not json',
      JSON.stringify({ v: 1, entries: [['a', { status: 'priced' }], ['b'], 'c'] })]) {
      const file = tmpFile();
      fs.writeFileSync(file, body);
      const c = cache(async () => ({ status: 'priced', n: 1 }));
      await onDisk(c, file).readback;
      expect(c.kept()).toEqual([]);
    }
  });

  it('writes the newest values that fit in the byte cap', async () => {
    const file = tmpFile();
    const c = new SwrCache<Value>({ read: async (id) => ({ status: 'priced', n: id.length }), keep: () => true, max: 10, freshMs: 5_000 });
    const disk = onDisk(c, file, 100); // 32 of envelope plus two rows of 33
    await disk.readback;
    for (const id of ['old', 'mid', 'new']) await c.get(id);
    await disk.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: [string, Value][] };
    expect(saved.entries.map(([id]) => id)).toEqual(['mid', 'new']);
  });

  it('the cost route\'s module reads its disk copy back: a kept cost answers before any host read', async () => {
    const file = tmpFile();
    const cost = { sessionId: 's1', engine: 'claude', source: 'claude-transcript', status: 'priced', totalUsd: 1.5,
      responses: 3, unpricedResponses: 0, models: [], prices: {} };
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [['s1', cost], ['s2', { ...cost, sessionId: 'other' }]] }));
    await startSessionCostDisk(file);
    expect(await atOnce(getSessionCost('s1'))).toEqual(cost);
    // A saved cost under another session's id is refused; with nothing kept the read goes to the host (404 here).
    await expect(getSessionCost('s2')).rejects.toMatchObject({ statusCode: 404 });
  });
});
