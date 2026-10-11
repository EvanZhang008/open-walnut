/**
 * withFileLock / withFileLockSync (src/utils/file-lock.ts): what a lock path can hold besides a
 * clean lock, and what a process can leave behind when it dies.
 *
 * Each block pins one finding of the 2026-10-05 review of the claim/rename protocol:
 *   - a hidden name in `owner/` (Finder's .DS_Store) is not a holder;
 *   - a release killed half done leaves `<lock>.<token>.lock`, which the next release removes, and
 *     only when it is provably a lock of a dead process;
 *   - a claim that can never succeed (a path too long, no permission) fails at once and takes
 *     the empty dir it made back off the path, while one that can pass (EINVAL from a lock folder
 *     being removed, an error it does not know) is tried again;
 *   - a symlink at the lock path is not a lock, and a lock that keeps vanishing backs off;
 *   - a stale folder holding a name the protocol never makes (.gitkeep) is never taken over;
 *   - the holder writes its pid, so an older build sees it alive and waits.
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
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  if (!pid) throw new Error('could not spawn a short-lived process');
  deadPid = pid;
});

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-lock-hard-'));
  store = path.join(dir, 'store.json');
  lock = `${store}.lock`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

const age = (p: string, ms = 60_000): void => {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(p, then, then);
};

/** Every entry under `p`, recursively, relative to it. */
function tree(p: string): string[] {
  return (fs.readdirSync(p, { recursive: true }) as string[]).sort();
}

/** The old build's stale rule (a live pid in `pid` holds the lock; else the age decides). */
function olderBuildSeesStale(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(path.join(lock, 'pid'), 'utf-8').trim(), 10);
    if (!isNaN(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }
  } catch { /* no pid file: the age decides */ }
  return Date.now() - fs.statSync(lock).mtimeMs > 30_000;
}

async function stillWaiting(waiter: { entered: boolean }, ms = 120): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !waiter.entered;
}

describe('a hidden name in owner/ is not a holder', () => {
  it('waits for a live holder whose owner/ also holds a .DS_Store', async () => {
    fs.mkdirSync(path.join(lock, 'owner', `${process.pid}-0123456789ab`), { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner', '.DS_Store'), '');
    const waiter = { entered: false };
    const done = withFileLock(store, async () => { waiter.entered = true; });
    expect(await stillWaiting(waiter)).toBe(true);
    fs.rmSync(lock, { recursive: true }); // the live holder releases
    await done;
    expect(waiter.entered).toBe(true);
  });
});

describe('a release killed half done', () => {
  /** Plant `<lock>.<token>.lock` holding `entries` (a path ending in / is a folder). */
  function plantGrave(token: string, entries: string[]): string {
    const grave = `${lock}.${token}.lock`;
    fs.mkdirSync(grave);
    for (const rel of entries) {
      const p = path.join(grave, rel);
      if (rel.endsWith('/')) fs.mkdirSync(p, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, rel === 'pid' ? token.split('-')[0] : 'mine');
      }
    }
    return path.basename(grave);
  }

  it.each(['async', 'sync'] as const)('is removed by the next %s release, and nothing that is not provably ours', async (mode) => {
    const t = (pid: number, n: number) => `${pid}-${String(n).padStart(12, '0')}`;
    // What a release killed after each of its steps leaves, by a process now dead.
    const dead = [
      plantGrave(t(deadPid, 1), [`owner/${t(deadPid, 1)}/`, 'pid']),
      plantGrave(t(deadPid, 2), ['owner/', 'pid']),
      plantGrave(t(deadPid, 3), ['pid']),
      plantGrave(t(deadPid, 4), [`owner/${t(deadPid, 9)}/`, `owner-${t(deadPid, 9)}/${t(deadPid, 4)}/`, 'pid', '.DS_Store']),
    ];
    const keep = [
      plantGrave(t(process.pid, 5), [`owner/${t(process.pid, 5)}/`, 'pid']), // alive: maybe mid-release
      plantGrave(t(deadPid, 6), ['owner/', 'notes.txt']),                     // holds a user file
      plantGrave(t(deadPid, 7), ['owner/stuff/']),                            // owner/ holds a non-token
      plantGrave(t(deadPid, 8), [`owner/${t(deadPid, 8)}/deeper.txt`]),        // a token dir with content
      plantGrave('backup', []),                                               // no token in the name
    ];
    const asFile = `${path.basename(lock)}.${t(deadPid, 10)}.lock`;
    fs.writeFileSync(path.join(dir, asFile), 'a file');
    const asLink = `${path.basename(lock)}.${t(deadPid, 11)}.lock`;
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, asLink));
    const before = Object.fromEntries(keep.map((n) => [n, tree(path.join(dir, n))]));

    if (mode === 'async') await withFileLock(store, async () => undefined);
    else withFileLockSync(store, () => undefined);

    for (const name of dead) expect(fs.existsSync(path.join(dir, name)), name).toBe(false);
    for (const name of keep) expect(tree(path.join(dir, name)), name).toEqual(before[name]);
    expect(fs.readFileSync(path.join(dir, asFile), 'utf-8')).toBe('a file');
    expect(fs.lstatSync(path.join(dir, asLink)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('a claim that can never succeed', () => {
  /** Make every mkdir of a claim (`<lock>/.claim-*`) fail with `code`. */
  function refuseClaims(code: string): void {
    const realMkdir = fsp.mkdir.bind(fsp);
    const realMkdirSync = fs.mkdirSync.bind(fs);
    const refused = (p: unknown) => String(p).startsWith(path.join(lock, '.claim-'));
    const fail = (): never => { throw Object.assign(new Error(code), { code }); };
    vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (refused(p) ? fail() : realMkdir(p, o))) as never);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (refused(p) ? fail() : realMkdirSync(p, o))) as never);
  }

  it.each(['ENAMETOOLONG', 'EACCES'])('fails at once on %s and takes its empty dir back off the path', async (code) => {
    refuseClaims(code);
    const started = Date.now();
    await expect(withFileLock(store, async () => 'in')).rejects.toMatchObject({ code });
    expect(() => withFileLockSync(store, () => 'in')).toThrow(code);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fs.existsSync(lock)).toBe(false);
    vi.restoreAllMocks();
    // The next caller is not stuck behind a dir nobody can claim.
    const next = Date.now();
    expect(await withFileLock(store, async () => 'in')).toBe('in');
    expect(Date.now() - next).toBeLessThan(2_000);
  });
});

describe('a claim error that can pass', () => {
  /** Fail the next `times` mkdirs of a claim with `code`, running `alsoDo` first each time. */
  function failClaims(code: string, times: number, alsoDo: () => void = () => undefined): { left: () => number } {
    let n = times;
    const realMkdir = fsp.mkdir.bind(fsp);
    const realMkdirSync = fs.mkdirSync.bind(fs);
    const hit = (p: unknown): boolean => {
      if (n === 0 || !String(p).startsWith(path.join(lock, '.claim-'))) return false;
      n--;
      return true;
    };
    const fail = (): never => { alsoDo(); throw Object.assign(new Error(code), { code }); };
    vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (hit(p) ? fail() : realMkdir(p, o))) as never);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => (hit(p) ? fail() : realMkdirSync(p, o))) as never);
    return { left: () => n };
  }

  it.each(['async', 'sync'] as const)('looks again (%s) when its lock folder is removed under the claim (EINVAL)', async (mode) => {
    // macOS answers EINVAL for a folder made inside a folder that is being removed, which is what
    // an older build does when it releases or breaks a lock: the lock is leaving, so look again.
    const claims = failClaims('EINVAL', 1, () => fs.rmSync(lock, { recursive: true, force: true }));
    const started = Date.now();
    const result = mode === 'async'
      ? await withFileLock(store, async () => 'in')
      : withFileLockSync(store, () => 'in');
    expect(result).toBe('in');
    expect(claims.left()).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('leaves the lock folder an older build made again in its place (EINVAL)', async () => {
    // An older build breaks a lock by removing it and making it again, then writes its pid. A
    // claim that fails with EINVAL in between must not take back the folder that build just made.
    let remade = false;
    failClaims('EINVAL', 1, () => {
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock); // the older build's lock, its pid not written yet
      remade = true;
    });
    const waiter = { entered: false };
    const done = withFileLock(store, async () => { waiter.entered = true; return 'in'; });
    expect(await stillWaiting(waiter, 60)).toBe(true);
    expect(remade).toBe(true);
    expect(fs.readdirSync(lock)).toEqual([]);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    expect(await stillWaiting(waiter, 60)).toBe(true);
    fs.rmSync(lock, { recursive: true }); // the older build releases
    expect(await done).toBe('in');
    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each(['async', 'sync'] as const)('tries again (%s) after an error it does not know, without leaving its empty dir', async (mode) => {
    // EIO is not proof that the lock can never be had: try again. The dir made for the failed
    // claim is taken back first, or the next look finds an unclaimed dir and waits 30s on it.
    const claims = failClaims('EIO', 2);
    const started = Date.now();
    const result = mode === 'async'
      ? await withFileLock(store, async () => 'in')
      : withFileLockSync(store, () => 'in');
    expect(result).toBe('in');
    expect(claims.left()).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('a lock path that does not hold still', () => {
  it('treats a symlink pointing nowhere as not a lock: fails fast and leaves it', async () => {
    const target = path.join(dir, 'nowhere');
    fs.symlinkSync(target, lock);
    const cpu = process.cpuUsage();
    const started = Date.now();
    await expect(withFileLock(store, async () => 'in')).rejects.toThrow(/taken by something else/);
    expect(() => withFileLockSync(store, () => 'in')).toThrow(/taken by something else/);
    expect(Date.now() - started).toBeLessThan(2_000);
    const used = process.cpuUsage(cpu);
    expect((used.user + used.system) / 1000).toBeLessThan(1_000);
    expect(fs.readlinkSync(lock)).toBe(target);
  });

  it.each(['async', 'sync'] as const)('looks again (%s) when a new lock is made between finding the old one gone and checking for a symlink', async (mode) => {
    // A dead holder's lock, which the waiter's first two looks miss as if it had just been
    // released and made again: both readdirs say ENOENT, the lstat after them finds a folder.
    // That folder is a lock: look again (and take it over), never refuse the path.
    fs.mkdirSync(path.join(lock, 'owner', `${deadPid}-0123456789ab`), { recursive: true });
    let misses = 2;
    const gone = (p: unknown) => (String(p) === lock || String(p) === path.join(lock, 'owner')) && misses-- > 0;
    const enoent = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const realReaddir = fsp.readdir.bind(fsp);
    const realReaddirSync = fs.readdirSync.bind(fs);
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: fs.PathLike, o?: unknown) => (gone(p) ? enoent() : realReaddir(p, o as never))) as never);
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => (gone(p) ? enoent() : realReaddirSync(p, o as never))) as never);
    const result = mode === 'async'
      ? await withFileLock(store, async () => 'in')
      : withFileLockSync(store, () => 'in');
    expect(result).toBe('in');
    expect(misses).toBeLessThanOrEqual(0);
    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each(['async', 'sync'] as const)('looks again (%s) when it reads owner/ just as a release empties it', async (mode) => {
    // A release renames the lock away and then empties `owner/` in its grave; a waiter that
    // opened `owner/` just before the rename reads it empty. That is a lock being released,
    // never "something else": the waiter looks again and gets in.
    fs.mkdirSync(path.join(lock, 'owner', `${deadPid}-0123456789ab`), { recursive: true });
    let emptyReads = 1;
    const owner = path.join(lock, 'owner');
    const realReaddir = fsp.readdir.bind(fsp);
    const realReaddirSync = fs.readdirSync.bind(fs);
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: fs.PathLike, o?: unknown) => (String(p) === owner && emptyReads-- > 0 ? [] : realReaddir(p, o as never))) as never);
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => (String(p) === owner && emptyReads-- > 0 ? [] : realReaddirSync(p, o as never))) as never);
    const result = mode === 'async'
      ? await withFileLock(store, async () => 'in')
      : withFileLockSync(store, () => 'in');
    expect(result).toBe('in');
    expect(emptyReads).toBeLessThanOrEqual(0);
    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('backs off when the lock keeps vanishing between two looks', async () => {
    // mkdir says the lock exists, every look finds it gone: the pathological "retry" loop.
    const realMkdir = fsp.mkdir.bind(fsp);
    let attempts = 0;
    let vanishing = true;
    vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
      if (vanishing && p === lock) {
        attempts++;
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      return realMkdir(p, o);
    }) as never);
    const done = withFileLock(store, async () => 'in');
    await new Promise((resolve) => setTimeout(resolve, 300));
    vanishing = false;
    expect(await done).toBe('in');
    // Polling every 15 ms gives about 20 looks in 300 ms; a hot loop makes thousands.
    expect(attempts).toBeLessThan(60);
  });
});

describe('a stale folder that is not a lock', () => {
  it.each([
    ['only a .gitkeep', ['.gitkeep']],
    ['a hidden file beside a pid', ['pid', '.keep']],
    ['a claim-shaped name that no claim makes', ['.claim-mine']],
  ])('is never taken over or deleted: %s', async (_label, names) => {
    fs.mkdirSync(lock);
    for (const name of names) fs.writeFileSync(path.join(lock, name), name === 'pid' ? String(deadPid) : 'x');
    age(lock);
    await expect(withFileLock(store, async () => 'in')).rejects.toThrow(/taken by something else/);
    expect(() => withFileLockSync(store, () => 'in')).toThrow(/taken by something else/);
    expect(fs.readdirSync(lock).sort()).toEqual([...names].sort());
  });

  it("still takes over an abandoned lock: an empty folder (a locker killed after mkdir), or one Finder visited", async () => {
    fs.mkdirSync(lock);
    age(lock);
    expect(await withFileLock(store, async () => 'in')).toBe('in');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, '.DS_Store'), '');
    age(lock);
    expect(withFileLockSync(store, () => 'in')).toBe('in');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('an older build beside this one', () => {
  it.each(['async', 'sync'] as const)('sees a %s holder alive through its pid file, however old the lock', async (mode) => {
    let seen: { pid: string; stale: boolean } | null = null;
    const inside = () => {
      age(lock);
      seen = { pid: fs.readFileSync(path.join(lock, 'pid'), 'utf-8'), stale: olderBuildSeesStale() };
    };
    if (mode === 'async') await withFileLock(store, async () => inside());
    else withFileLockSync(store, inside);
    expect(seen).toEqual({ pid: String(process.pid), stale: false });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('names the new holder after taking over a dead holder in place', async () => {
    fs.mkdirSync(path.join(lock, 'owner', `${deadPid}-0123456789ab`), { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(deadPid));
    let pid = '';
    await withFileLock(store, async () => { pid = fs.readFileSync(path.join(lock, 'pid'), 'utf-8'); });
    expect(pid).toBe(String(process.pid));
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
