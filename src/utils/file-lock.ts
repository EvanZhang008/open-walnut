/**
 * Cross-process file locking using mkdir (POSIX-atomic).
 *
 * Two variants:
 * - `withFileLockSync` — for synchronous hook processes (on-stop, on-compact)
 * - `withFileLock`     — for async server modules (task-manager, session-tracker)
 *
 * For Walnut's own stores. A file a person edits (a repo file, a note) is locked with
 * `withUserFileLock` (user-file-lock.ts), which keeps the lock under WALNUT_HOME/locks.
 *
 * The lock is a directory at `${filePath}.lock`. Making it starts a claim; who holds it is
 * decided by one atomic step: renaming a prepared directory to `owner` inside it (a rename
 * onto a directory that already has content fails), so exactly one claim wins. The winner's
 * token (`<pid>-<random>`) is the name of the one entry inside `owner`.
 *
 * A lock whose holder process died is taken over IN PLACE: a waiter claims
 * `owner-<dead token>` the same way, so the holder is found by following that chain from
 * `owner`. Nobody but the holder ever removes the directory. A waiter acting on what it read a
 * moment ago can therefore at worst add an entry no chain leads to; it can never delete a lock
 * that another live process just took. (2026-10-05: removing a lock that had "vanished", and
 * every waiter removing a lock left by a dead pid, let two processes hold it at once, and two
 * writers of auth.json lost device records.)
 *
 * Older builds: their locks (a `pid` file and no `owner`) are honoured while that pid lives,
 * and taken over when it is dead or, with no readable pid, once older than STALE_AGE_MS. A
 * holder also writes its pid to `pid`, so an older build sees it alive and waits.
 *
 * Never deleted: anything at the lock path that is not a lock (a `Gemfile.lock` file, a symlink,
 * a folder holding any name this protocol does not make) makes the lock throw instead. An empty
 * folder is what a locker killed right after mkdir leaves, so it is taken over once stale.
 *
 * A process that exits while it takes or holds a lock gives it back on 'exit' (see
 * releaseHeldLocksSync): its finally never runs when fn calls process.exit.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const STALE_AGE_MS = 30_000;  // Age-based fallback: an unclaimed lock older than 30s is stale
const TIMEOUT_MS = 10_000;    // Give up (throw) after 10s
const POLL_MS = 15;           // Poll interval
const OWNER = 'owner';
const PID = 'pid';
const FINDER = '.DS_Store';   // macOS Finder's metadata file, dropped into any folder it shows
const MAX_CHAIN = 64;         // Each link needs a holder that died holding it; real chains are 0-1 long
const TOKEN_SRC = '\\d+-[0-9a-f]{12}';
const TOKEN = new RegExp(`^${TOKEN_SRC}$`);
// Every name a lock dir holds: an older build's pid file, the owner and its takeover links, a
// claim being prepared, and Finder's metadata file.
const LOCK_ENTRY = new RegExp(`^(${PID}|${OWNER}|${OWNER}-${TOKEN_SRC}|\\.claim-${TOKEN_SRC}|\\.DS_Store)$`);
const NO_TOKEN = '\0none';    // `entry` reply: a file where the folder should be (never a lock)

/** The lock was not had within the wait; `fn` never ran. */
export class FileLockTimeoutError extends Error {
  constructor(lock: string, waitMs: number) {
    super(`File lock timeout after ${waitMs}ms: ${lock}`);
    this.name = 'FileLockTimeoutError';
  }
}

function lockDir(filePath: string): string {
  return filePath + '.lock';
}

/** Check if a PID is alive via kill(pid, 0). EPERM: it exists, it is just not ours. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── The protocol, written once ──
//
// A generator of filesystem steps; a sync driver and an async driver run the same steps, so the
// two variants cannot drift apart.

type Step =
  | { kind: 'mkdir'; path: string }                                 // → 'ok' | 'EEXIST'
  | { kind: 'claim'; lock: string; entry: string; token: string }   // → 'ok' | 'EEXIST' | 'ENOENT' | 'EAGAIN' | Error
  | { kind: 'entry'; path: string }                                 // → the token inside, null (none) or NO_TOKEN
  | { kind: 'list'; path: string }                                  // → names, null (gone) or 'ENOTDIR'
  | { kind: 'pid'; path: string }                                   // → pid, or 0 when unreadable
  | { kind: 'mtime'; path: string }                                 // → mtimeMs, or null when gone
  | { kind: 'type'; path: string }                                  // → 'dir' | 'file' | 'other' | null
  | { kind: 'rmdir'; path: string }                                 // → null (an empty folder only)
  | { kind: 'remove'; path: string };                               // → null (recursive)
type Reply = string | number | string[] | null | Error;
type Outcome = 'acquired' | 'wait' | 'retry';
interface Holder { entry: string; token: string | null; pid: number; mtimeMs: number }

/** Who holds the lock now, and the entry a waiter claims to replace them. null: no lock. */
function* findHolder(lock: string): Generator<Step, Holder | 'foreign' | null, Reply> {
  let token = (yield { kind: 'entry', path: path.join(lock, OWNER) }) as string | null;
  if (token === NO_TOKEN) return 'foreign';
  if (token === null) {
    // Unclaimed: just made (its maker is about to claim it), from an older build, or abandoned.
    const names = (yield { kind: 'list', path: lock }) as string[] | 'ENOTDIR' | null;
    if (names === null) return null;
    if (names === 'ENOTDIR' || !names.every((name) => LOCK_ENTRY.test(name))) return 'foreign';
    const pid = names.includes(PID) ? (yield { kind: 'pid', path: path.join(lock, PID) }) as number : 0;
    if (pid > 0) return { entry: OWNER, token: null, pid, mtimeMs: 0 };
    const mtimeMs = (yield { kind: 'mtime', path: lock }) as number | null;
    return mtimeMs === null ? null : { entry: OWNER, token: null, pid: 0, mtimeMs };
  }
  for (let i = 0; i < MAX_CHAIN; i++) {
    const next = (yield { kind: 'entry', path: path.join(lock, `${OWNER}-${token}`) }) as string | null;
    if (next === NO_TOKEN) return 'foreign';
    if (next === null) break;
    token = next;
  }
  return { entry: `${OWNER}-${token}`, token, pid: parseInt(token, 10) || 0, mtimeMs: 0 };
}

function isStale(holder: Holder): boolean {
  if (holder.pid > 0) return !isPidAlive(holder.pid);
  return Date.now() - holder.mtimeMs > STALE_AGE_MS;
}

/**
 * One attempt to take the lock. It never removes anything but the empty dir it just made, and
 * flags `mine.made` while that dir is its own and not claimed yet (for the exit release).
 */
function* attempt(lock: string, token: string, mine: { made: boolean }): Generator<Step, Outcome, Reply> {
  if ((yield { kind: 'mkdir', path: lock }) === 'ok') {
    mine.made = true;
    const claimed = yield { kind: 'claim', lock, entry: OWNER, token };
    if (claimed instanceof Error || claimed === 'EAGAIN') {
      // Our claim on the dir we just made failed and the dir is still here (a path too long for
      // the claim, a dir made unwritable by a umask, an error we do not know): take it back off
      // the path, or every later caller waits on an unclaimed dir until it is 30s old.
      yield { kind: 'rmdir', path: lock };
      if (claimed instanceof Error) throw claimed;
      return 'retry';
    }
    // EEXIST: a waiter that found the previous lock stale claimed this one first. It is theirs.
    return claimed === 'ok' ? 'acquired' : claimed === 'EEXIST' ? 'wait' : 'retry';
  }
  const holder = yield* findHolder(lock);
  // Vanished: its holder released it. Make it again; removing "it" could remove a newer lock.
  if (!holder) return 'retry';
  if (holder === 'foreign') throw new Error(`File lock path is taken by something else: ${lock}`);
  // Ours already: a claim that reported failure but landed (a lost reply on a network share).
  if (holder.token === token) return 'acquired';
  if (!isStale(holder)) return 'wait';
  const claimed = yield { kind: 'claim', lock, entry: holder.entry, token };
  if (claimed instanceof Error) throw claimed;
  if (claimed !== 'ok') return claimed === 'EEXIST' ? 'wait' : 'retry';
  if (holder.entry === OWNER) return 'acquired';
  // `owner-<dead token>` only joins the chain of the lock that token held. If that lock was
  // released and made again since we read it, our entry sits on no chain: check before holding.
  const now = yield* findHolder(lock);
  return now !== null && now !== 'foreign' && now.token === token ? 'acquired' : 'wait';
}

/** True only for a real folder holding nothing but what a lock of this protocol holds. */
function* isLockTree(dir: string): Generator<Step, boolean, Reply> {
  if ((yield { kind: 'type', path: dir }) !== 'dir') return false;
  const names = yield { kind: 'list', path: dir };
  if (!Array.isArray(names)) return false;
  for (const name of names) {
    if (!LOCK_ENTRY.test(name)) return false;
    const entry = path.join(dir, name);
    const type = yield { kind: 'type', path: entry };
    if (name === PID || name === FINDER) {
      if (type !== 'file') return false;
      continue;
    }
    // owner, owner-<token>, .claim-<token>: nothing inside but empty token-named folders.
    if (type !== 'dir') return false;
    const inner = yield { kind: 'list', path: entry };
    if (!Array.isArray(inner)) return false;
    for (const t of inner) {
      if (!TOKEN.test(t) || (yield { kind: 'type', path: path.join(entry, t) }) !== 'dir') return false;
      const deep = yield { kind: 'list', path: path.join(entry, t) };
      if (!Array.isArray(deep) || deep.length > 0) return false;
    }
  }
  return true;
}

/**
 * Remove released locks a process died while removing (`<lock>.<token>.lock` of a dead pid),
 * so they do not pile up beside the store. Only a folder that is provably one of ours goes.
 */
function* sweepGraves(lock: string): Generator<Step, void, Reply> {
  const parent = path.dirname(lock);
  const prefix = `${path.basename(lock)}.`;
  const names = yield { kind: 'list', path: parent };
  if (!Array.isArray(names)) return;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.lock')) continue;
    const token = name.slice(prefix.length, -'.lock'.length);
    if (!TOKEN.test(token) || isPidAlive(parseInt(token, 10))) continue;
    const grave = path.join(parent, name);
    if (yield* isLockTree(grave)) yield { kind: 'remove', path: grave };
  }
}

function newToken(): string {
  return `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
}

/** Claim errors that waiting cannot cure: a path too long, no permission, a full disk. */
const CLAIM_NEVER = new Set(['ENAMETOOLONG', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EMLINK', 'ELOOP']);

/**
 * A rename onto `entry` fails when it exists (it always has content), so one claim wins.
 * ENOENT/ENOTDIR/EINVAL: the lock left its path meanwhile, look again (macOS answers EINVAL
 * for an entry made in a folder that is being removed, which is how an older build releases).
 * An error in CLAIM_NEVER fails now. Any other error is tried again ('EAGAIN'), within the
 * timeout and backing off: an error we do not know is no proof that the lock can never be had.
 */
function claimResult(err: unknown, lock: string): 'EEXIST' | 'ENOENT' | 'EAGAIN' | Error {
  const code = errCode(err);
  if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EBUSY') return 'EEXIST';
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL') return 'ENOENT';
  if (!CLAIM_NEVER.has(code)) return 'EAGAIN';
  return Object.assign(new Error(`File lock cannot be claimed (${code}): ${lock}`), { code, cause: err });
}

/**
 * The token a holder folder names. Hidden names (a Finder .DS_Store) are not holders. A folder
 * naming none is read as no holder: a release empties `owner/` in its grave, and a waiter that
 * opened the folder just before the rename reads it empty.
 */
function entryOf(names: string[]): string | null {
  return names.filter((name) => TOKEN.test(name)).sort()[0] ?? null;
}

function typeOf(st: fs.Stats): 'dir' | 'file' | 'other' {
  return st.isSymbolicLink() ? 'other' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}

function prepFor(lock: string, token: string): string {
  return path.join(lock, `.claim-${token}`);
}

/** A released lock's new name: unique, and still ending in `.lock` so sync and backups skip it. */
function graveFor(lock: string, token: string): string {
  return `${lock}.${token}.lock`;
}

// ── Locks given back when the process exits ──
//
// fn calling process.exit (a hook, a server stopping mid-write) skips the finally. The lock then
// names a dead token, which waiters here take over at once, but two shapes still held others up:
// a dir made and not claimed yet (unclaimed, so judged by age: 30s), and for an older build a
// lock with no pid written (2026-10-08: a dead server's notifications.json lock cost the next
// boot its recovery write, twice). The 'exit' hook gives back what is provably this process's.

interface Taking { lock: string; token: string; made: boolean }
const taking = new Set<Taking>();
let exitHookInstalled = false;

function track(lock: string, token: string): Taking {
  const t = { lock, token, made: false };
  taking.add(t);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', releaseHeldLocksSync);
  }
  return t;
}

/**
 * Give back every lock this process is taking or holds (sync, for process 'exit'): our claim
 * folder, the empty dir we made for a claim not made yet, and a lock whose holder is our token.
 * Not one another live process has stamped its pid into: some other build believes it holds it.
 * A lock given back here is not released again by the call that took it.
 */
export function releaseHeldLocksSync(): void {
  for (const t of [...taking]) {
    taking.delete(t);
    try {
      fs.rmSync(prepFor(t.lock, t.token), { recursive: true, force: true });
      const holder = runSync(findHolder(t.lock));
      if (holder !== null && holder !== 'foreign' && holder.token === t.token) {
        const pid = runStepSync({ kind: 'pid', path: path.join(t.lock, PID) }) as number;
        if (!(pid > 0 && pid !== process.pid && isPidAlive(pid))) releaseSync(t.lock, t.token);
      } else if (t.made) {
        fs.rmdirSync(t.lock); // fails when not empty: a claim landed in it, theirs
      }
    } catch { /* exiting: what is left is judged by the next waiter */ }
  }
}

// ── Synchronous (for hooks) ──

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Sleep without spinning the CPU (nothing ever notifies `sleeper`, so this always times out). */
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function mkdirSyncTolerant(dir: string): void {
  try { fs.mkdirSync(dir); } catch (err) { if (errCode(err) !== 'EEXIST') throw err; }
}

function runStepSync(step: Step): Reply {
  switch (step.kind) {
    case 'mkdir':
      try { fs.mkdirSync(step.path); return 'ok'; } catch (err) {
        if (errCode(err) !== 'EEXIST') throw err;
        return 'EEXIST';
      }
    case 'claim': {
      const prep = prepFor(step.lock, step.token);
      try {
        mkdirSyncTolerant(prep);
        mkdirSyncTolerant(path.join(prep, step.token));
        fs.renameSync(prep, path.join(step.lock, step.entry));
        return 'ok';
      } catch (err) {
        try { fs.rmSync(prep, { recursive: true, force: true }); } catch { /* gone with its lock */ }
        return claimResult(err, step.lock);
      }
    }
    case 'entry':
      try { return entryOf(fs.readdirSync(step.path)); } catch (err) {
        return errCode(err) === 'ENOTDIR' ? NO_TOKEN : null;
      }
    case 'list':
      try { return fs.readdirSync(step.path); } catch (err) {
        if (errCode(err) !== 'ENOENT') return errCode(err) === 'ENOTDIR' ? 'ENOTDIR' : null;
        // Gone (maybe made again since: look again), or a symlink pointing nowhere (never a lock).
        try { return fs.lstatSync(step.path).isSymbolicLink() ? 'ENOTDIR' : null; } catch { return null; }
      }
    case 'pid':
      try { return parseInt(fs.readFileSync(step.path, 'utf-8').trim(), 10) || 0; } catch { return 0; }
    case 'mtime':
      try { return fs.statSync(step.path).mtimeMs; } catch { return null; }
    case 'type':
      try { return typeOf(fs.lstatSync(step.path)); } catch { return null; }
    case 'rmdir':
      try { fs.rmdirSync(step.path); } catch { /* not empty: someone else's now */ }
      return null;
    case 'remove':
      try { fs.rmSync(step.path, { recursive: true, force: true }); } catch { /* next sweep */ }
      return null;
  }
}

function runSync<T>(gen: Generator<Step, T, Reply>): T {
  let next = gen.next();
  while (!next.done) next = gen.next(runStepSync(next.value));
  return next.value;
}

/** Name the holder for older builds, which only know the pid file (best effort). */
function stampSync(lock: string): void {
  try { fs.writeFileSync(path.join(lock, PID), String(process.pid)); } catch { /* best effort */ }
}

/** Take the lock off its path in one rename, so an entry landing meanwhile cannot strand it. */
function releaseSync(lock: string, token: string): void {
  const grave = graveFor(lock, token);
  try {
    fs.renameSync(lock, grave);
  } catch (err) {
    // ENOENT: already gone, and anything at the path now is someone else's.
    if (errCode(err) !== 'ENOENT') {
      try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return;
  }
  try {
    // The usual shape is `owner/<token>` plus the pid file; anything else (a takeover, an entry
    // that landed late) goes through the recursive remove.
    fs.rmdirSync(path.join(grave, OWNER, token));
    fs.rmdirSync(path.join(grave, OWNER));
    fs.unlinkSync(path.join(grave, PID));
    fs.rmdirSync(grave);
  } catch {
    try { fs.rmSync(grave, { recursive: true, force: true }); } catch { /* no longer a lock */ }
  }
}

/**
 * Acquire a file lock synchronously, run fn, release.
 * Polls with a blocking sleep (no spinning), acceptable for short-lived hook processes.
 * Throws FileLockTimeoutError if the lock cannot be acquired within TIMEOUT_MS.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T): T {
  const lock = lockDir(filePath);
  const token = newToken();
  const deadline = Date.now() + TIMEOUT_MS;

  // Ensure parent directory exists (lock dir sits next to the data file)
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const mine = track(lock, token);
  let retries = 0;
  try {
    for (;;) {
      let outcome: Outcome;
      try { outcome = runSync(attempt(lock, token, mine)); } finally { mine.made = false; }
      if (!taking.has(mine)) { // given back at exit meanwhile: this call takes nothing more
        if (outcome === 'acquired') releaseSync(lock, token);
        throw new Error(`File lock given back at exit: ${lock}`);
      }
      if (outcome === 'acquired') break;
      if (Date.now() > deadline) {
        throw new FileLockTimeoutError(lock, TIMEOUT_MS);
      }
      // A lock that vanished is made again at once, but only once in a row: a path that keeps
      // vanishing backs off like a held lock instead of running hot until the timeout.
      if (outcome === 'wait') retries = 0;
      else if (retries++ === 0) continue;
      sleepSync(POLL_MS);
    }
  } catch (err) {
    taking.delete(mine);
    throw err;
  }
  stampSync(lock);

  try {
    return fn();
  } finally {
    if (taking.delete(mine)) {
      releaseSync(lock, token);
      try { runSync(sweepGraves(lock)); } catch { /* housekeeping only */ }
    }
  }
}

// ── Asynchronous (for server modules) ──

async function mkdirTolerant(dir: string): Promise<void> {
  try { await fsp.mkdir(dir); } catch (err) { if (errCode(err) !== 'EEXIST') throw err; }
}

async function runStep(step: Step): Promise<Reply> {
  switch (step.kind) {
    case 'mkdir':
      try { await fsp.mkdir(step.path); return 'ok'; } catch (err) {
        if (errCode(err) !== 'EEXIST') throw err;
        return 'EEXIST';
      }
    case 'claim': {
      const prep = prepFor(step.lock, step.token);
      try {
        await mkdirTolerant(prep);
        await mkdirTolerant(path.join(prep, step.token));
        await fsp.rename(prep, path.join(step.lock, step.entry));
        return 'ok';
      } catch (err) {
        await fsp.rm(prep, { recursive: true, force: true }).catch(() => { /* gone with its lock */ });
        return claimResult(err, step.lock);
      }
    }
    case 'entry':
      try { return entryOf(await fsp.readdir(step.path)); } catch (err) {
        return errCode(err) === 'ENOTDIR' ? NO_TOKEN : null;
      }
    case 'list':
      try { return await fsp.readdir(step.path); } catch (err) {
        if (errCode(err) !== 'ENOENT') return errCode(err) === 'ENOTDIR' ? 'ENOTDIR' : null;
        // Gone (maybe made again since: look again), or a symlink pointing nowhere (never a lock).
        try { return (await fsp.lstat(step.path)).isSymbolicLink() ? 'ENOTDIR' : null; } catch { return null; }
      }
    case 'pid':
      try { return parseInt((await fsp.readFile(step.path, 'utf-8')).trim(), 10) || 0; } catch { return 0; }
    case 'mtime':
      try { return (await fsp.stat(step.path)).mtimeMs; } catch { return null; }
    case 'type':
      try { return typeOf(await fsp.lstat(step.path)); } catch { return null; }
    case 'rmdir':
      await fsp.rmdir(step.path).catch(() => { /* not empty: someone else's now */ });
      return null;
    case 'remove':
      await fsp.rm(step.path, { recursive: true, force: true }).catch(() => { /* next sweep */ });
      return null;
  }
}

async function run<T>(gen: Generator<Step, T, Reply>): Promise<T> {
  let next = gen.next();
  while (!next.done) next = gen.next(await runStep(next.value));
  return next.value;
}

async function stamp(lock: string): Promise<void> {
  await fsp.writeFile(path.join(lock, PID), String(process.pid)).catch(() => { /* best effort */ });
}

async function release(lock: string, token: string): Promise<void> {
  const grave = graveFor(lock, token);
  try {
    await fsp.rename(lock, grave);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') await fsp.rm(lock, { recursive: true, force: true }).catch(() => { /* ignore */ });
    return;
  }
  try {
    await fsp.rmdir(path.join(grave, OWNER, token));
    await fsp.rmdir(path.join(grave, OWNER));
    await fsp.unlink(path.join(grave, PID));
    await fsp.rmdir(grave);
  } catch {
    await fsp.rm(grave, { recursive: true, force: true }).catch(() => { /* no longer a lock */ });
  }
}

/**
 * Acquire a file lock asynchronously, run fn, release.
 * Uses setTimeout polling — non-blocking for the event loop.
 * Throws FileLockTimeoutError if the lock cannot be acquired within `timeoutMs` (default
 * TIMEOUT_MS). A caller that can come back later passes a short one rather than wait on a holder
 * that may be waiting on it. At least one attempt is always made, however short the wait.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const lock = lockDir(filePath);
  const token = newToken();
  const waitMs = opts.timeoutMs ?? TIMEOUT_MS;
  const deadline = Date.now() + waitMs;

  // Ensure parent directory exists
  await fsp.mkdir(path.dirname(lock), { recursive: true });

  const mine = track(lock, token);
  let retries = 0;
  try {
    for (;;) {
      let outcome: Outcome;
      try { outcome = await run(attempt(lock, token, mine)); } finally { mine.made = false; }
      if (!taking.has(mine)) { // given back at exit meanwhile: this call takes nothing more
        if (outcome === 'acquired') await release(lock, token);
        throw new Error(`File lock given back at exit: ${lock}`);
      }
      if (outcome === 'acquired') break;
      if (Date.now() > deadline) {
        throw new FileLockTimeoutError(lock, waitMs);
      }
      // Same back-off as the sync variant: only the first retry in a row goes straight back.
      if (outcome === 'wait') retries = 0;
      else if (retries++ === 0) continue;
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  } catch (err) {
    taking.delete(mine);
    throw err;
  }
  await stamp(lock);

  try {
    return await fn();
  } finally {
    if (taking.delete(mine)) {
      await release(lock, token);
      await run(sweepGraves(lock)).catch(() => { /* housekeeping only */ });
    }
  }
}
