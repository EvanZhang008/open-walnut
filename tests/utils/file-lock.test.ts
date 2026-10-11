/**
 * withFileLock / withFileLockSync (src/utils/file-lock.ts): one holder at a time, and a
 * stale lock is broken without ever breaking a live one.
 *
 * Pins the 2026-10-05 data loss: two writers of auth.json lost device records because two
 * holders were inside the lock at once. Two waiter paths removed a lock some other process
 * had just taken: (1) a waiter that saw the lock vanish (its holder released) treated it as
 * stale and removed it, deleting the NEXT holder's fresh lock; (2) every waiter that saw a
 * dead holder's pid removed the lock, so the second one deleted the first one's new lock.
 * Async workers in one process race the same way processes do, so these tests need no
 * child processes (tests/utils/file-lock-multiprocess.test.ts covers real processes).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { withFileLock, withFileLockSync } from '../../src/utils/file-lock.js';

let dir: string;
let store: string;
let lock: string;
let deadPid: number;

beforeAll(() => {
  // A pid that existed a moment ago and has exited (pids are not reused within a test run).
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  if (!pid) throw new Error('could not spawn a short-lived process');
  deadPid = pid;
});

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-lock-'));
  store = path.join(dir, 'store.json');
  lock = `${store}.lock`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

/** A lock as an older build leaves it: the directory plus a `pid` file. */
function plantLegacyLock(pid: number | null, ageMs = 0): void {
  fs.mkdirSync(lock);
  if (pid !== null) fs.writeFileSync(path.join(lock, 'pid'), String(pid));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(lock, then, then);
  }
}

/** A lock as this build leaves it when its holder dies: `owner/<token>` names the holder. */
function plantClaimedLock(pid: number): void {
  fs.mkdirSync(path.join(lock, 'owner', `${pid}-0123456789ab`), { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(pid));
  // An older build only knows the age rule for a lock without a pid it can use; age it so the
  // same test also runs against one (and fails fast on the overlap, not on a 10s timeout).
  const then = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, then, then);
}

/**
 * Run `workers` lockers at once, each doing a read-modify-write of a counter store the way
 * updateJsonFile does. Counts how often two were inside together, and the updates kept.
 */
async function burst(workers: number, iterations: number): Promise<{ overlaps: number; kept: number }> {
  await fsp.writeFile(store, '0');
  let inside = 0;
  let overlaps = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    for (let i = 0; i < iterations; i++) {
      await withFileLock(store, async () => {
        inside++;
        if (inside > 1) overlaps++;
        const n = Number(await fsp.readFile(store, 'utf-8'));
        const tmp = `${store}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        await fsp.writeFile(tmp, String(n + 1));
        await fsp.rename(tmp, store);
        inside--;
      });
    }
  }));
  return { overlaps, kept: Number(fs.readFileSync(store, 'utf-8')) };
}

/** A file's content, or a folder's entries with their content. */
function describePath(p: string): unknown {
  if (!fs.statSync(p).isDirectory()) return fs.readFileSync(p, 'utf-8');
  return fs.readdirSync(p).map((name) => [name, fs.readFileSync(path.join(p, name), 'utf-8')]);
}

/** Entries left beside the store: no lock, no released lock, no claim. */
function leftovers(): string[] {
  return fs.readdirSync(dir).filter((name) => name !== 'store.json');
}

interface Gate { reached: Promise<void>; hit: () => void; opened: Promise<void>; open: () => void }

function gate(): Gate {
  let hit!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => { hit = resolve; });
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { reached, hit, opened, open };
}

/** Fail instead of hanging when a step never happens. */
async function within<T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not within ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

const FS_CALLS = ['mkdir', 'rename', 'rm', 'rmdir', 'readdir', 'readFile', 'writeFile', 'stat'] as const;

/**
 * Run every fs/promises call the lock makes for real, telling `after` how each one went, and
 * hold the next call at a gate once `pauseNext` names one: a race replayed step by step.
 */
function interceptFs(after: (name: string, target: unknown, error: NodeJS.ErrnoException | null) => void): { pauseNext: (g: Gate) => void } {
  let pending: Gate | null = null;
  const real = Object.fromEntries(FS_CALLS.map((name) => [name, (fsp[name] as (...a: unknown[]) => Promise<unknown>).bind(fsp)]));
  for (const name of FS_CALLS) {
    vi.spyOn(fsp, name).mockImplementation((async (...args: unknown[]) => {
      const held = pending;
      if (held) { pending = null; held.hit(); await held.opened; }
      try {
        const out = await real[name](...args);
        after(name, args[0], null);
        return out;
      } catch (err) {
        after(name, args[0], err as NodeJS.ErrnoException);
        throw err;
      }
    }) as never);
  }
  return { pauseNext: (g) => { pending = g; } };
}

/**
 * Lockers V and X, recording the order and any overlap. A locker stays inside until the other one
 * is in too (the bug) or has checked this process's pid, which is how a waiter finds the holder
 * alive and settles down to wait. `onKill` sees every liveness check first.
 */
function lockers(onKill: (pid: number) => void = () => {}) {
  let inside = 0;
  let aliveChecks = 0;
  const seen = { overlaps: 0, order: [] as string[] };
  const entered = { V: gate(), X: gate() };
  const realKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    try { return realKill(pid, signal); } finally {
      if (pid === process.pid) aliveChecks++;
      onKill(Number(pid));
    }
  });
  const run = (name: 'V' | 'X') => withFileLock(store, async () => {
    inside++;
    if (inside > 1) seen.overlaps++;
    seen.order.push(`${name} in`);
    entered[name].hit();
    const checks = aliveChecks;
    const other = entered[name === 'V' ? 'X' : 'V'];
    let otherIn = false;
    void other.reached.then(() => { otherIn = true; });
    for (let waited = 0; waited < 1_000 && !otherIn && aliveChecks === checks; waited += 2) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    seen.order.push(`${name} out`);
    inside--;
  });
  return { run, seen, vIn: entered.V, xIn: entered.X };
}

/**
 * The dead-holder race, step by step: waiter V finds the lock's holder dead and is paused right
 * after that check; meanwhile a third locker takes that lock over and releases it, and X makes a
 * new one. Then V goes on. `x: 'holding'` lets X get all the way in before V goes on; `x: 'made'`
 * pauses X right after it made the new lock dir and lets V go on first.
 */
async function replayDeadHolderRace(x: 'holding' | 'made'): Promise<{ overlaps: number; order: string[] }> {
  const deadHolder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf-8'));
  const judged = gate();
  const made = gate();
  const vClaimed = gate();
  let armMade = false;
  let vGoing = false;
  const fsGate = interceptFs((name, target, error) => {
    if (name === 'mkdir' && target === lock && !error && armMade) { armMade = false; fsGate.pauseNext(made); }
    // While X is held, a claim (a rename of a prepared `.claim-*` dir) can only be V's.
    if (vGoing && name === 'rename' && String(target).startsWith(path.join(lock, '.claim-'))) vClaimed.hit();
  });
  let judgedOnce = false;
  const { run, seen, xIn, vIn } = lockers((pid) => {
    if (pid === deadHolder && !judgedOnce) { judgedOnce = true; fsGate.pauseNext(judged); }
  });

  const v = run('V');
  await within(judged.reached, 'V checking the dead holder');
  fs.rmSync(lock, { recursive: true }); // taken over and released by a third locker meanwhile
  armMade = x === 'made';
  const xDone = run('X');
  await within(x === 'holding' ? xIn.reached : made.reached, x === 'holding' ? 'X getting in' : 'X making a new lock');
  vGoing = x === 'made';
  judged.open();
  if (x === 'made') {
    // V goes as far as it can: in, or its claim made (then a moment for its re-check).
    const settle = vClaimed.reached.then(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await within(Promise.race([vIn.reached, settle]), 'V getting in or claiming');
    vGoing = false;
    made.open();
  }
  await within(Promise.all([v, xDone]), 'both lockers finishing');
  vi.restoreAllMocks();
  return seen;
}

/**
 * The vanished-lock race, step by step: V finds the lock held (mkdir EEXIST) and is paused; the
 * holder releases; V goes on, finds the lock gone, and is paused right there; X takes a new lock
 * and gets in. Then V goes on.
 */
async function replayVanishedLockRace(): Promise<{ overlaps: number; order: string[] }> {
  const blocked = gate();
  const vanished = gate();
  let armBlocked = false;
  let armVanished = false;
  const fsGate = interceptFs((name, target, error) => {
    if (target !== lock) return;
    if (armBlocked && name === 'mkdir' && error?.code === 'EEXIST') { armBlocked = false; fsGate.pauseNext(blocked); }
    if (armVanished && (name === 'stat' || name === 'readdir') && error?.code === 'ENOENT') {
      armVanished = false;
      fsGate.pauseNext(vanished);
    }
  });
  const { run, seen, xIn } = lockers();
  const holderIn = gate();
  const holderOut = gate();
  const holder = withFileLock(store, async () => { holderIn.hit(); await holderOut.opened; });
  await within(holderIn.reached, 'the first holder getting in');

  armBlocked = true;
  const v = run('V');
  await within(blocked.reached, 'V finding the lock held');
  holderOut.open();
  await within(holder, 'the first holder releasing');
  armVanished = true;
  blocked.open();
  await within(vanished.reached, 'V finding the lock gone');
  const xDone = run('X');
  await within(xIn.reached, 'X getting in');
  vanished.open();
  await within(Promise.all([v, xDone]), 'both lockers finishing');
  vi.restoreAllMocks();
  return seen;
}

/** One holder after the other; `first` names who must go first. */
function expectOneAtATime({ overlaps, order }: { overlaps: number; order: string[] }, first?: string): void {
  expect(overlaps).toBe(0);
  expect(order.map((step) => step.split(' ')[1])).toEqual(['in', 'out', 'in', 'out']);
  expect(order[0].split(' ')[0]).toBe(order[1].split(' ')[0]);
  if (first) expect(order[0]).toBe(`${first} in`);
}

describe('withFileLock: one holder at a time', () => {
  it('never lets two holders in while the lock is released and retaken constantly', async () => {
    expect(await burst(3, 20)).toEqual({ overlaps: 0, kept: 60 });
    expect(leftovers()).toEqual([]);
  });

  it('a waiter that saw the lock vanish never removes the next holder\'s lock', async () => {
    expectOneAtATime(await replayVanishedLockRace(), 'X');
    expect(leftovers()).toEqual([]);
  });

  it('a lock left by a dead pid is taken over by exactly one waiter at a time', async () => {
    let overlapRounds = 0;
    for (let round = 0; round < 5; round++) {
      plantLegacyLock(deadPid);
      const { overlaps, kept } = await burst(6, 1);
      if (overlaps > 0 || kept !== 6) overlapRounds++;
      expect(leftovers()).toEqual([]);
    }
    expect(overlapRounds).toBe(0);
  });

  it.each([
    ['an older build', 'holding'],
    ['this build', 'holding'],
    ['an older build', 'made'],
    ['this build', 'made'],
  ] as const)('a waiter that found a dead holder never takes a newer lock (lock from %s, X %s)', async (build, x) => {
    if (build === 'this build') plantClaimedLock(deadPid);
    else plantLegacyLock(deadPid);
    // X first when it got in before V went on.
    expectOneAtATime(await replayDeadHolderRace(x), x === 'holding' ? 'X' : undefined);
    expect(leftovers()).toEqual([]);
  });
});

describe('withFileLock: stale and live locks', () => {
  it('breaks a lock left by a dead pid', async () => {
    plantLegacyLock(deadPid);
    const started = Date.now();
    expect(await withFileLock(store, async () => 'in')).toBe('in');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(leftovers()).toEqual([]);
  });

  it('breaks a lock with no pid once it is older than the stale age', async () => {
    plantLegacyLock(null, 60_000);
    expect(await withFileLock(store, async () => 'in')).toBe('in');
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ['this process', () => process.pid],
    ['pid 1 (alive, even when signalling it is not permitted)', () => 1],
  ])('never breaks a lock held by a live pid: %s', async (_label, pidOf) => {
    plantLegacyLock(pidOf(), 60_000);
    let entered = false;
    const waiter = withFileLock(store, async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(entered).toBe(false);
    expect(fs.readFileSync(path.join(lock, 'pid'), 'utf-8')).toBe(String(pidOf()));
    fs.rmSync(lock, { recursive: true }); // the live holder releases
    await waiter;
    expect(entered).toBe(true);
  });

  it('waits for an unclaimed fresh lock instead of breaking it', async () => {
    plantLegacyLock(null);
    let entered = false;
    const waiter = withFileLock(store, async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(entered).toBe(false);
    fs.rmSync(lock, { recursive: true });
    await waiter;
    expect(entered).toBe(true);
  });

  it('never breaks the lock of a live holder in this build, however long it holds', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holderIn!: () => void;
    const holderStarted = new Promise<void>((resolve) => { holderIn = resolve; });
    const holder = withFileLock(store, async () => { holderIn(); await held; });
    await holderStarted;
    const then = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, then, then);
    let entered = false;
    const waiter = withFileLock(store, async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(entered).toBe(false);
    release();
    await Promise.all([holder, waiter]);
    expect(entered).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('releases when fn throws, and the error reaches the caller', async () => {
    await expect(withFileLock(store, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(leftovers()).toEqual([]);
    expect(await withFileLock(store, async () => 'again')).toBe('again');
  });

  it('takes the lock off its path in one rename, never by emptying it in place', async () => {
    // An entry may land in a held lock at any moment (a waiter acting on an older read). Emptying
    // the directory in place can then fail and strand the lock under a live pid for good.
    const rm = vi.spyOn(fsp, 'rm');
    const rmSync = vi.spyOn(fs, 'rmSync');
    const rename = vi.spyOn(fsp, 'rename');
    const renameSync = vi.spyOn(fs, 'renameSync');
    await withFileLock(store, async () => undefined);
    withFileLockSync(store, () => undefined);
    const inPlace = [...rm.mock.calls, ...rmSync.mock.calls].filter(([p]) => p === lock);
    expect(inPlace).toEqual([]);
    const moves = [...rename.mock.calls, ...renameSync.mock.calls].filter(([from]) => from === lock);
    expect(moves).toHaveLength(2);
    // The released name still ends in `.lock`, so data sync and backups skip it like a lock.
    for (const [, to] of moves) expect(String(to)).toMatch(/^.+\.lock\..+\.lock$/);
    expect(leftovers()).toEqual([]);
  });

  /** Make renaming the lock dir away fail with `code`; every other rename runs for real. */
  function refuseRenameAway(code: string): void {
    const realRename = fsp.rename.bind(fsp);
    const realRenameSync = fs.renameSync.bind(fs);
    const refuse = (): never => { throw Object.assign(new Error(code), { code }); };
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => (from === lock ? refuse() : realRename(from, to)));
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => (from === lock ? refuse() : realRenameSync(from, to)));
  }

  it('removes the lock in place when it cannot be renamed away', async () => {
    refuseRenameAway('EBUSY');
    await withFileLock(store, async () => undefined);
    expect(fs.existsSync(lock)).toBe(false);
    withFileLockSync(store, () => undefined);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('leaves the path alone when the lock is already gone at release', async () => {
    // A build from before this fix may remove a lock it wrongly finds stale; the path may then
    // hold someone else's lock, which a release must not delete.
    refuseRenameAway('ENOENT');
    await withFileLock(store, async () => undefined);
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock, { recursive: true });
    withFileLockSync(store, () => undefined);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('holds the lock when a claim landed but its reply was lost', async () => {
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
      await realRename(from, to);
      throw Object.assign(new Error('reply lost'), { code: 'ENOENT' });
    });
    const started = Date.now();
    expect(await withFileLock(store, async () => 'in')).toBe('in');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ['a file, like a Gemfile.lock beside a Gemfile', () => fs.writeFileSync(lock, 'GEM\n  specs:\n')],
    ['a folder with content', () => {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'keep.txt'), 'mine');
    }],
  ])('never deletes something else at the lock path: %s', async (_label, plant) => {
    plant();
    const then = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, then, then);
    const before = describePath(lock);
    await expect(withFileLock(store, async () => 'in')).rejects.toThrow(/taken by something else/);
    expect(() => withFileLockSync(store, () => 'in')).toThrow(/taken by something else/);
    expect(describePath(lock)).toEqual(before);
  });
});

describe('withFileLockSync', () => {
  it('runs fn under the lock and releases it', () => {
    expect(withFileLockSync(store, () => fs.existsSync(lock))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('breaks a lock left by a dead pid, and one with no pid older than the stale age', () => {
    plantLegacyLock(deadPid);
    expect(withFileLockSync(store, () => 'dead')).toBe('dead');
    plantLegacyLock(null, 60_000);
    expect(withFileLockSync(store, () => 'old')).toBe('old');
    plantClaimedLock(deadPid);
    expect(withFileLockSync(store, () => 'claimed')).toBe('claimed');
    expect(leftovers()).toEqual([]);
  });

  it('releases when fn throws', () => {
    expect(() => withFileLockSync(store, () => { throw new Error('boom'); })).toThrow('boom');
    expect(leftovers()).toEqual([]);
  });

  it('sleeps while it waits instead of spinning the CPU', () => {
    // The caller's thread is blocked for the whole wait (up to 10s), so a busy wait burns a
    // core all that time. The lock: an older build's with no pid, 29.4s old, so it turns stale
    // (and is taken over) about 0.6s into the wait.
    plantLegacyLock(null, 29_400);
    const cpuBefore = process.cpuUsage();
    const started = Date.now();
    expect(withFileLockSync(store, () => 'in')).toBe('in');
    const wallMs = Date.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    expect(wallMs).toBeGreaterThan(250);
    expect(cpuMs, `${cpuMs.toFixed(1)}ms of CPU in a ${wallMs}ms wait`).toBeLessThan(wallMs / 4);
  });
});
