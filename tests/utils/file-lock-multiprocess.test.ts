/**
 * withFileLock across real processes (src/utils/file-lock.ts).
 *
 * 2026-10-05: two processes writing auth.json through withFileLock lost device records. A waiter
 * that saw the lock vanish (its holder had just released it) treated it as stale and removed
 * it, which deleted the next holder's fresh lock, so two processes held it at once. This runs
 * async and sync lockers in separate processes against one counter store; every update must be
 * kept and no two holders may ever be inside together. tests/utils/file-lock.test.ts covers the
 * stale-lock rules in one process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKER = path.join(ROOT, 'tests/fixtures/file-lock/worker.ts');
const ITERATIONS = 40;
const LOCKERS: Array<{ mode: 'async' | 'sync'; workers: number }> = [
  { mode: 'async', workers: 3 },
  { mode: 'async', workers: 3 },
  { mode: 'async', workers: 3 },
  { mode: 'sync', workers: 1 },
];

interface Result { overlaps: number; done: number; errors: string[] }

let dir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-lock-mp-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  await fsp.rm(dir, { recursive: true, force: true });
});

/** Start one locker; resolves `ready` once it waits on the start file, `result` when it exits. */
function startLocker(args: string[]): { ready: Promise<void>; result: Promise<Result> } {
  // `node --import tsx`, not the tsx CLI: no watcher process, and no IPC socket in TMPDIR.
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => { onReady = resolve; });
  child.stdout!.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes('ready\n')) onReady();
  });
  child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const result = new Promise<Result>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (code !== 0 || !line) reject(new Error(`locker exited ${code}: ${err.slice(0, 500)}`));
      else resolve(JSON.parse(line) as Result);
    });
  });
  // A locker that dies before printing `ready` must fail the test, not hang it.
  result.catch(() => onReady());
  return { ready, result };
}

describe('withFileLock across processes', () => {
  it('keeps every update and never lets two processes hold the lock at once', async () => {
    const store = path.join(dir, 'store.json');
    const startFile = path.join(dir, 'start');
    fs.writeFileSync(store, '0');
    const lockers = LOCKERS.map(({ mode, workers }) =>
      startLocker([mode, store, String(workers), String(ITERATIONS), startFile]));
    await Promise.all(lockers.map((l) => l.ready));
    fs.writeFileSync(startFile, '');
    const results = await Promise.all(lockers.map((l) => l.result));

    const expected = LOCKERS.reduce((sum, l) => sum + l.workers * ITERATIONS, 0);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(results.reduce((sum, r) => sum + r.overlaps, 0)).toBe(0);
    expect(results.reduce((sum, r) => sum + r.done, 0)).toBe(expected);
    expect(Number(fs.readFileSync(store, 'utf-8'))).toBe(expected);
    expect(fs.readdirSync(dir).filter((n) => n !== 'store.json' && n !== 'start')).toEqual([]);
  }, 60_000);
});
