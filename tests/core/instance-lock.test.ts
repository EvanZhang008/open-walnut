/**
 * Tests for the single-instance server lock (instance-lock.ts): at most one
 * server process may own a WALNUT_HOME. Guards the 2026-08-04 incident where a
 * second production-mode server on another port shared the same data dir and
 * silently deleted the first server's newly created tasks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-instance-lock'));

import {
  acquireInstanceLock,
  releaseInstanceLock,
  updateInstanceLockPort,
  listForeignDbHolders,
  listPersistentForeignDbHolders,
  InstanceLockError,
  stepForeignWriterWatch,
  initialForeignWriterWatchState,
  registerManagedDbHolder,
  TASK_DB_WRITERS_RECOVERY_KEY,
} from '../../src/core/instance-lock.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

const LOCK_FILE = path.join(WALNUT_HOME, 'server.lock.json');

beforeEach(async () => {
  releaseInstanceLock();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  releaseInstanceLock();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('instance lock', () => {
  it('acquires and records pid + port', () => {
    acquireInstanceLock(3456);
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(3456);
  });

  it('refuses a second acquisition while a LIVE holder exists', () => {
    // A live FOREIGN holder: the parent process (vitest runner) is alive and
    // is not us — exactly the shape of a real second server's lock.
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.ppid, port: 3467, startedAt: 'earlier' }),
    );
    expect(() => acquireInstanceLock(3456)).toThrow(InstanceLockError);
  });

  it('takes over a STALE lock whose holder is dead', () => {
    // Pid 1 is launchd/systemd — kill(1, 0) from an unprivileged test yields
    // EPERM (alive), so use an absurd pid that cannot exist.
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: 2 ** 30, port: 3467, startedAt: 'crashed-earlier' }),
    );
    expect(() => acquireInstanceLock(3456)).not.toThrow();
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('takes over a corrupt lock file', () => {
    fs.writeFileSync(LOCK_FILE, 'not json at all');
    expect(() => acquireInstanceLock(3456)).not.toThrow();
  });

  it('release removes the file; re-acquire then succeeds', () => {
    acquireInstanceLock(3456);
    releaseInstanceLock();
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
    expect(() => acquireInstanceLock(3457)).not.toThrow();
  });

  it('updateInstanceLockPort rewrites the recorded port only for our own lock', () => {
    acquireInstanceLock(0);
    updateInstanceLockPort(54321);
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    expect(lock.port).toBe(54321);
  });

  it('release does NOT remove a lock now owned by someone else', () => {
    acquireInstanceLock(3456);
    // Another process crashed us and took over (simulated foreign rewrite).
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: 2 ** 30, port: 9999, startedAt: 'takeover' }),
    );
    releaseInstanceLock();
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
  });
});

describe('foreign DB-holder detection (lsof layer)', () => {
  const DB_FILE = path.join(TASKS_DIR, 'tasks.sqlite');

  it('reports no holders when nothing has the DB open', async () => {
    await fsp.mkdir(TASKS_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, '');
    expect(await listForeignDbHolders()).toEqual([]);
  });

  it('detects a resident foreign holder and excludes our own pid', async () => {
    await fsp.mkdir(TASKS_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, '');
    // A real foreign process holding the file open: tail -f keeps an fd on it.
    const { spawn } = await import('node:child_process');
    const holder = spawn('tail', ['-f', DB_FILE], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300)); // let tail open the fd
      const holders = await listForeignDbHolders();
      expect(holders.some((h) => h.pid === holder.pid)).toBe(true);
      expect(holders.some((h) => h.pid === process.pid)).toBe(false);

      const unregister = registerManagedDbHolder(holder.pid!);
      expect(
        (await listForeignDbHolders()).some((h) => h.pid === holder.pid),
      ).toBe(false);
      unregister();
      expect(
        (await listForeignDbHolders()).some((h) => h.pid === holder.pid),
      ).toBe(true);

      // Persistence check (short gap): same pid across both probes survives.
      const persistent = await listPersistentForeignDbHolders(200);
      expect(persistent.some((h) => h.pid === holder.pid)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('a transient holder does not count as persistent', async () => {
    await fsp.mkdir(TASKS_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, '');
    const { spawn } = await import('node:child_process');
    const holder = spawn('tail', ['-f', DB_FILE], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    // Dies between the two probes — like an on-stop hook child.
    setTimeout(() => holder.kill('SIGKILL'), 100);
    const persistent = await listPersistentForeignDbHolders(600);
    expect(persistent.some((h) => h.pid === holder.pid)).toBe(false);
  });
});

/**
 * The watchdog's two edges, without lsof or a real second writer.
 *
 * The alert edge was already the point of the persistence rule (one rogue writer
 * must alert once, not every minute). The all-clear edge is new: the SECOND
 * WRITER card is keyed 'task-db-writers', and the user killing the rogue process
 * is what retires it — otherwise the scariest card in the feed stays red after the
 * danger is gone, and starts being ignored.
 */
describe('foreign-writer watchdog edges (stepForeignWriterWatch)', () => {
  const rogue = { pid: 999, command: 'open-walnut' };
  const other = { pid: 1000, command: 'open-walnut' };

  /** Feed a sequence of per-tick holder lists; collect what each tick reported. */
  function run(ticks: Array<Array<{ pid: number; command: string }>>) {
    let state = initialForeignWriterWatchState();
    return ticks.map((holders) => {
      const out = stepForeignWriterWatch(holders, state);
      state = out.next;
      return { alert: out.alert.map(h => h.pid), allClear: out.allClear };
    });
  }

  it('has a stable condition key', () => {
    expect(TASK_DB_WRITERS_RECOVERY_KEY).toBe('task-db-writers');
  });

  it('alerts only on the SECOND consecutive tick (the transient-hook filter)', () => {
    const out = run([[rogue], [rogue]]);
    expect(out[0]).toEqual({ alert: [], allClear: false }); // first sighting
    expect(out[1]).toEqual({ alert: [999], allClear: false });
  });

  it('a transient holder (one tick only) never alerts, and never "recovers"', () => {
    // An on-stop hook child holds the DB for milliseconds. It was never a
    // condition, so its disappearance must not fire a recovery either.
    const out = run([[rogue], [], []]);
    expect(out.every(o => o.alert.length === 0)).toBe(true);
    expect(out.every(o => !o.allClear)).toBe(true);
  });

  it('does not re-alert for the same pid tick after tick', () => {
    const out = run([[rogue], [rogue], [rogue], [rogue]]);
    expect(out.map(o => o.alert.length)).toEqual([0, 1, 0, 0]);
  });

  it('THE RECOVERY EDGE: all-clear fires once, on the tick the rogue is gone', () => {
    const out = run([[rogue], [rogue], [], []]);
    expect(out[1].alert).toEqual([999]);
    expect(out[2]).toEqual({ alert: [], allClear: true });
    // …and exactly once: a healthy box must not signal recovery every minute.
    expect(out[3]).toEqual({ alert: [], allClear: false });
  });

  it('does NOT announce all-clear while the writer is still there', () => {
    // The trap this pins: on the tick AFTER an alert, `fresh` is empty (the pid is
    // already in alertedPids), so an implementation keyed off `fresh`/`persistent`
    // would report recovery with the rogue writer still holding the database.
    const out = run([[rogue], [rogue], [rogue]]);
    expect(out.every(o => !o.allClear)).toBe(true);
  });

  it('waits for EVERY holder to leave, not just the alerted one', () => {
    const out = run([[rogue], [rogue], [other], [other], []]);
    expect(out[1].alert).toEqual([999]);   // rogue alerted
    expect(out[2].allClear).toBe(false);   // `other` still holding
    expect(out[3].alert).toEqual([1000]);  // `other` becomes persistent → alerts
    expect(out[4].allClear).toBe(true);    // now genuinely nobody
  });

  it('re-arms across episodes', () => {
    const out = run([[rogue], [rogue], [], [rogue], [rogue], []]);
    expect(out.map(o => o.alert.length)).toEqual([0, 1, 0, 0, 1, 0]);
    expect(out.map(o => o.allClear)).toEqual([false, false, true, false, false, true]);
  });

  it('never fires all-clear on a box that has never seen a foreign writer', () => {
    const out = run([[], [], [], []]);
    expect(out.every(o => !o.allClear && o.alert.length === 0)).toBe(true);
  });
});
