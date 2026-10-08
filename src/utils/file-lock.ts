/**
 * Cross-process file locking using mkdir (POSIX-atomic).
 *
 * Two variants:
 * - `withFileLockSync` — for synchronous hook processes (on-stop, on-compact)
 * - `withFileLock`     — for async server modules (task-manager, session-tracker)
 *
 * The lock is a directory at `${filePath}.lock`. mkdir is atomic on POSIX,
 * so only one process can create it. Stale locks are detected by checking
 * whether the holding process (PID written inside the lock dir) is still alive.
 * Falls back to age-based detection if PID cannot be read/checked.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const STALE_AGE_MS = 30_000;  // Age-based fallback: lock older than 30s is stale
const TIMEOUT_MS = 10_000;    // Give up (throw) after 10s
const POLL_MS = 15;           // Poll interval

function lockDir(filePath: string): string {
  return filePath + '.lock';
}

function pidFile(lock: string): string {
  return path.join(lock, 'pid');
}

/** Check if a PID is alive via kill(pid, 0). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Synchronous (for hooks) ──

/**
 * Acquire a file lock synchronously, run fn, release.
 * Uses busy-wait polling — acceptable for short-lived hook processes.
 * Throws if the lock cannot be acquired within TIMEOUT_MS.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T): T {
  const lock = lockDir(filePath);
  const deadline = Date.now() + TIMEOUT_MS;

  // Ensure parent directory exists (lock dir sits next to the data file)
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lock);
      // Write PID for liveness-based stale detection
      try { fs.writeFileSync(pidFile(lock), String(process.pid)); } catch { /* best effort */ }
      break; // Acquired
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Check if the lock is stale (holder process dead or lock too old)
      if (isLockStaleSync(lock)) {
        // Remove stale lock and immediately try to acquire in the same iteration.
        // Another waiter might also detect staleness — only one mkdir will succeed.
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already removed */ }
        continue; // Back to mkdirSync — atomic, so at most one succeeds
      }

      if (Date.now() > deadline) {
        throw new Error(`File lock timeout after ${TIMEOUT_MS}ms: ${lock}`);
      }

      // Busy-wait (acceptable for short-lived hook processes)
      const start = Date.now();
      while (Date.now() - start < POLL_MS) { /* spin */ }
    }
  }

  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function isLockStaleSync(lock: string): boolean {
  try {
    // Primary: check if holder PID is alive
    const raw = fs.readFileSync(pidFile(lock), 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && pid > 0) {
      return !isPidAlive(pid);
    }
  } catch { /* PID file unreadable — fall through to age check */ }

  // Fallback: age-based detection
  try {
    const stat = fs.statSync(lock);
    return Date.now() - stat.mtimeMs > STALE_AGE_MS;
  } catch {
    return true; // Lock vanished — treat as stale
  }
}

// ── Asynchronous (for server modules) ──

// The async locks this process holds right now. A process that exits while it
// holds one (a server stopping while a card is being written) used to leave the
// lock dir behind, often with the pid file still empty: the dir is made first and
// the pid written after. With no pid to check, waiters treat such a lock as live
// until it is STALE_AGE_MS old, and each gives up at TIMEOUT_MS before then: on
// 2026-10-08 the next server's boot lost its recovery write to the dead one's
// notifications.json lock that way, twice, and the card it would have retired
// stayed up. The exit hook gives every held lock back.
const heldLocks = new Set<string>();
let exitReleaseInstalled = false;

/**
 * Remove the locks this process holds. Sync, for process 'exit'. A lock whose pid
 * file names another process is not ours any more and is left alone; an empty
 * or missing pid file is ours (we made the dir and had not written the pid yet).
 */
export function releaseHeldLocksSync(): void {
  for (const lock of heldLocks) {
    let pid = '';
    try { pid = fs.readFileSync(pidFile(lock), 'utf-8').trim(); } catch { /* empty or gone */ }
    if (pid !== '' && pid !== String(process.pid)) continue;
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  heldLocks.clear();
}

function trackHeldLock(lock: string): void {
  heldLocks.add(lock);
  if (exitReleaseInstalled) return;
  exitReleaseInstalled = true;
  process.on('exit', releaseHeldLocksSync);
}

/**
 * Acquire a file lock asynchronously, run fn, release.
 * Uses setTimeout polling — non-blocking for the event loop.
 * Throws if the lock cannot be acquired within TIMEOUT_MS.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockDir(filePath);
  const deadline = Date.now() + TIMEOUT_MS;

  // Ensure parent directory exists
  await fsp.mkdir(path.dirname(lock), { recursive: true });

  while (true) {
    try {
      await fsp.mkdir(lock);
      // Tracked before the pid write: an exit in between is the case it is for.
      trackHeldLock(lock);
      // Write PID for liveness-based stale detection
      try { await fsp.writeFile(pidFile(lock), String(process.pid)); } catch { /* best effort */ }
      break; // Acquired
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      if (await isLockStaleAsync(lock)) {
        try { await fsp.rm(lock, { recursive: true, force: true }); } catch { /* already removed */ }
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`File lock timeout after ${TIMEOUT_MS}ms: ${lock}`);
      }

      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    // Untracked first: by now the pid file names this process, so a lock the rm
    // has not removed when the process exits reads as a dead holder's.
    heldLocks.delete(lock);
    try { await fsp.rm(lock, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function isLockStaleAsync(lock: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(pidFile(lock), 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    if (!isNaN(pid) && pid > 0) {
      return !isPidAlive(pid);
    }
  } catch { /* fall through */ }

  try {
    const stat = await fsp.stat(lock);
    return Date.now() - stat.mtimeMs > STALE_AGE_MS;
  } catch {
    return true;
  }
}
