/**
 * One installer per component across processes (two servers on one data home,
 * the CLI next to the server). The lock is a file created with O_EXCL; its
 * holder touches it every few seconds, and a lock nobody touched for `staleMs`
 * belonged to a process that died, so the next installer takes it over. No pid
 * is ever signalled to find that out.
 *
 * Correctness never rests on the lock alone: every installer unpacks into its
 * own staging dir and the last step is one rename, and the bytes are checked
 * against the pinned hash. A holder that was only paused (a sleeping Mac) and
 * lost the lock finds out before it publishes anything (stillHeld), so it costs
 * a second download at worst, never a write over the install that took over.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { link, mkdir, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ComponentError } from './types.js';

export interface LockOptions {
  /** How long to wait for another holder (default 30 min: an install may take that long). */
  waitMs?: number;
  /** A lock untouched for this long is taken over (default 60 s). */
  staleMs?: number;
  /** How often the holder touches it (default 5 s). */
  heartbeatMs?: number;
  /** How often a waiter looks again (default 500 ms). */
  pollMs?: number;
  signal?: AbortSignal;
  /** Called once when this process starts waiting for another holder. */
  onWait?: () => void;
}

export interface HeldLock {
  readonly token: string;
  /** Another installer took the lock over (this one was paused past staleMs), as the last heartbeat saw. */
  lost(): boolean;
  /** Still this holder's, read from the lock file now: asked right before each step that publishes. */
  stillHeld(): Promise<boolean>;
  release(): Promise<void>;
}

async function tryCreate(file: string, token: string): Promise<boolean> {
  try {
    const fh = await open(file, 'wx');
    try {
      await fh.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') return false;
    throw err;
  }
}

async function readToken(file: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(file, 'utf8')) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

export async function acquireLock(file: string, opts: LockOptions = {}): Promise<HeldLock> {
  const waitMs = opts.waitMs ?? 30 * 60_000;
  const staleMs = opts.staleMs ?? 60_000;
  const heartbeatMs = opts.heartbeatMs ?? 5_000;
  const pollMs = opts.pollMs ?? 500;
  const token = randomBytes(8).toString('hex');
  const until = Date.now() + waitMs;
  let waited = false;
  await mkdir(dirname(file), { recursive: true });
  for (;;) {
    if (opts.signal?.aborted) throw new ComponentError('Install stopped', 'aborted');
    if (await tryCreate(file, token)) break;
    const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => null);
    if (age !== null && age > staleMs) {
      // Move the dead holder's file aside; whoever moved it retries the create,
      // and only one create can win.
      const aside = `${file}.stale-${token}`;
      if (await rename(file, aside).then(() => true, () => false)) {
        // Between the look and the move another waiter may have taken it over
        // and made a fresh one: that one goes back (link fails if a third exists).
        const movedAge = await stat(aside).then((s) => Date.now() - s.mtimeMs, () => null);
        if (movedAge !== null && movedAge <= staleMs) await link(aside, file).catch(() => {});
        await rm(aside, { force: true });
      }
      continue;
    }
    if (Date.now() >= until) throw new ComponentError('Another Walnut process is installing this component', 'locked');
    if (!waited) { waited = true; opts.onWait?.(); }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  let lost = false;
  let released = false;
  const beat = setInterval(() => {
    void (async () => {
      if (released) return;
      if ((await readToken(file)) !== token) { lost = true; clearInterval(beat); return; }
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
    })();
  }, heartbeatMs);
  beat.unref?.();

  return {
    token,
    lost: () => lost,
    async stillHeld() {
      if (lost || released) return false;
      if ((await readToken(file)) !== token) { lost = true; clearInterval(beat); return false; }
      return true;
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      if ((await readToken(file)) === token) await rm(file, { force: true });
    },
  };
}
