/**
 * How long withFileLock waits, and what it throws when the wait runs out
 * (src/utils/file-lock.ts): `timeoutMs` (default 10s) and FileLockTimeoutError, an Error whose
 * message is the one every caller saw before. A caller that can come back later passes a short
 * wait instead of waiting out a holder that may be waiting on it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  FileLockTimeoutError, releaseHeldLocksSync, withFileLock, withFileLockSync,
} from '../../src/utils/file-lock.js';

let dir: string;
let store: string;
let lock: string;
const other = `${process.pid}-0123456789ab`; // a live holder: this pid, another token

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-lock-timeout-'));
  store = path.join(dir, 'store.json');
  lock = `${store}.lock`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

function plantLiveHolder(): void {
  fs.mkdirSync(path.join(lock, 'owner', other), { recursive: true });
}

/** Date.now() as usual for the first call (the deadline), then far past any deadline. */
function clockJumpsAfterDeadline(): void {
  const real = Date.now.bind(Date);
  let calls = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? real() : real() + 3_600_000));
}

describe('withFileLock timeoutMs', () => {
  it('gives up after a short wait on a held lock, leaves the lock alone, and never runs fn', async () => {
    plantLiveHolder();
    let ran = false;
    const started = Date.now();
    const err = await withFileLock(store, async () => { ran = true; }, { timeoutMs: 60 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileLockTimeoutError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`File lock timeout after 60ms: ${lock}`);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ran).toBe(false);
    // The call that gave up holds nothing, so an exit now gives nothing back.
    releaseHeldLocksSync();
    expect(fs.readdirSync(path.join(lock, 'owner'))).toEqual([other]);
  });

  it('gets a lock released within the wait', async () => {
    plantLiveHolder();
    setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 50);
    expect(await withFileLock(store, async () => 'in', { timeoutMs: 2_000 })).toBe('in');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('still makes one attempt with no wait at all', async () => {
    expect(await withFileLock(store, async () => 'in', { timeoutMs: 0 })).toBe('in');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('waits 10s by default, with the message callers saw before', async () => {
    plantLiveHolder();
    clockJumpsAfterDeadline();
    const err = await withFileLock(store, async () => 'in').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileLockTimeoutError);
    expect((err as Error).message).toBe(`File lock timeout after 10000ms: ${lock}`);
  });
});

describe('withFileLockSync timeout', () => {
  it('throws FileLockTimeoutError after 10s, with the same message', () => {
    plantLiveHolder();
    clockJumpsAfterDeadline();
    let caught: unknown;
    try { withFileLockSync(store, () => 'in'); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(FileLockTimeoutError);
    expect((caught as Error).message).toBe(`File lock timeout after 10000ms: ${lock}`);
    expect(fs.readdirSync(path.join(lock, 'owner'))).toEqual([other]);
  });
});
