/**
 * releaseHeldLocksSync (src/utils/file-lock.ts): what a process gives back when it exits while
 * it takes or holds a lock. The real 'exit' path, with child processes, is pinned in
 * tests/e2e/file-lock-exit-release.test.ts; here the hook is called in-process at the exact
 * moment each case needs, which a real exit cannot be timed to.
 *
 * Both give back a lock dir this process made by removing it only while it is empty: a claim
 * that landed in it meanwhile is another holder's lock, and a recursive remove there lets two
 * writers in at once. The last cases pin that for the exit hook and for a failed claim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileLockTimeoutError, withFileLock, withFileLockSync, releaseHeldLocksSync } from '../../src/utils/file-lock.js';

let dir: string;
let store: string;
let lock: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-lock-exit-'));
  store = path.join(dir, 'store.json');
  lock = `${store}.lock`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

/** The token of the lock's holder, read the way the protocol reads it (no takeover chain here). */
function holderToken(): string | undefined {
  return fs.readdirSync(path.join(lock, 'owner')).find((name) => /^\d+-[0-9a-f]{12}$/.test(name));
}

describe('a process that exits while it holds a lock', () => {
  it('gives a sync lock back, and the next caller gets it at once', () => {
    let seen: boolean | undefined;
    withFileLockSync(store, () => {
      releaseHeldLocksSync();
      seen = fs.existsSync(lock);
    });
    expect(seen).toBe(false);
    const started = Date.now();
    expect(withFileLockSync(store, () => 'in')).toBe('in');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('never releases again a lock it gave back, which another caller may hold by then', async () => {
    let gate!: () => void;
    const opened = new Promise<void>((resolve) => { gate = resolve; });
    let second: Promise<void> | undefined;
    let secondToken: string | undefined;
    await withFileLock(store, async () => {
      releaseHeldLocksSync();
      second = withFileLock(store, async () => {
        secondToken = holderToken();
        await opened;
      });
      while (!secondToken) await new Promise((resolve) => setTimeout(resolve, 5));
    });
    // The first call has returned: the lock must still be the second caller's.
    expect(holderToken()).toBe(secondToken);
    gate();
    await second;
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('a process that exits while it takes a lock', () => {
  it.each(['async', 'sync'] as const)('takes back the empty dir it made before its claim (%s)', async (mode) => {
    // The exit lands after the lock dir was made and before the claim: left there, that empty
    // dir reads as unclaimed and every other caller waits until it is 30s old.
    let existsAfterExit: boolean | undefined;
    const atClaim = (): never => {
      releaseHeldLocksSync();
      existsAfterExit = fs.existsSync(lock);
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); // stop this call here
    };
    const isClaim = (p: unknown) => String(p).startsWith(path.join(lock, '.claim-'));
    const realMkdir = fsp.mkdir.bind(fsp);
    const realMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (isClaim(p) ? atClaim() : realMkdir(p, o))) as never);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (isClaim(p) ? atClaim() : realMkdirSync(p, o))) as never);
    if (mode === 'async') await expect(withFileLock(store, async () => 'in')).rejects.toThrow();
    else expect(() => withFileLockSync(store, () => 'in')).toThrow();
    expect(existsAfterExit).toBe(false);
  });

  it.each(['async', 'sync'] as const)('keeps the dir it made once another claim landed in it (%s)', async (mode) => {
    // Another process claimed the dir between our mkdir and our claim (it judged the dir stale:
    // this process was paused past the stale age, say), and then this process exits. The lock
    // is theirs: removing it, as the old exit hook's rm -rf did, lets two writers in at once.
    const other = `${process.pid}-0123456789ab`; // a live holder: this pid, another token
    let ownerAfterExit: boolean | undefined;
    const atClaim = (): never => {
      fs.mkdirSync(path.join(lock, 'owner', other), { recursive: true }); // their claim lands
      releaseHeldLocksSync();
      ownerAfterExit = fs.existsSync(path.join(lock, 'owner', other));
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); // stop this call here
    };
    const isClaim = (p: unknown) => String(p).startsWith(path.join(lock, '.claim-'));
    const realMkdir = fsp.mkdir.bind(fsp);
    const realMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (isClaim(p) ? atClaim() : realMkdir(p, o))) as never);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (isClaim(p) ? atClaim() : realMkdirSync(p, o))) as never);
    if (mode === 'async') await expect(withFileLock(store, async () => 'in')).rejects.toThrow();
    else expect(() => withFileLockSync(store, () => 'in')).toThrow();
    expect(ownerAfterExit).toBe(true);
    expect(holderToken()).toBe(other);
  });

  it('leaves alone the lock another holder has while it waits, and takes nothing after', async () => {
    const other = `${process.pid}-0123456789ab`; // a live holder: this pid, another token
    fs.mkdirSync(path.join(lock, 'owner', other), { recursive: true });
    const waiter = withFileLock(store, async () => 'in');
    await new Promise((resolve) => setTimeout(resolve, 60));
    releaseHeldLocksSync();
    expect(holderToken()).toBe(other);
    await expect(waiter).rejects.toThrow(/given back at exit/);
    expect(holderToken()).toBe(other);
  });
});

describe('a claim that fails on the dir it just made', () => {
  // The caller takes that dir back off the path so later callers do not wait on it for 30s,
  // but only while it is empty: a claim that landed in it meanwhile (a waiter that judged it
  // stale) holds the lock now. EIO is retried within the wait; EACCES fails at once.
  it.each([['async', 'EIO'], ['async', 'EACCES'], ['sync', 'EACCES']] as const)(
    'leaves alone the lock another claim landed in (%s, %s)',
    async (mode, code) => {
      const other = `${process.pid}-0123456789ab`; // a live holder: this pid, another token
      let armed = true;
      const atClaim = (): never => {
        armed = false;
        fs.mkdirSync(path.join(lock, 'owner', other), { recursive: true }); // their claim lands
        throw Object.assign(new Error(code), { code });
      };
      const isClaim = (p: unknown) => armed && String(p).startsWith(path.join(lock, '.claim-'));
      const realMkdir = fsp.mkdir.bind(fsp);
      const realMkdirSync = fs.mkdirSync.bind(fs);
      vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (isClaim(p) ? atClaim() : realMkdir(p, o))) as never);
      vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (isClaim(p) ? atClaim() : realMkdirSync(p, o))) as never);
      if (mode === 'async') {
        const result = await withFileLock(store, async () => 'in', { timeoutMs: 300 }).catch((err: unknown) => err);
        expect(result).toBeInstanceOf(code === 'EIO' ? FileLockTimeoutError : Error);
      } else {
        expect(() => withFileLockSync(store, () => 'in')).toThrow(/cannot be claimed/);
      }
      expect(holderToken()).toBe(other);
    },
  );
});
