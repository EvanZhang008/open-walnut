/**
 * The cross-process half of the remote-id race — real OS processes, real file
 * lock, real SQLITE_BUSY.
 *
 * WHY A SEPARATE TIER: tests/integrations/ms-todo-fork-concurrency.test.ts covers
 * the await-interleaving half faithfully, because that bug lives inside one event
 * loop. It cannot cover this half. Walnut serializes writes with an in-process
 * promise chain AND a cross-process file lock, and a single vitest worker only
 * ever exercises the first. The 2026-09-01 report specifically described
 * `task_update` calls failing with "database is locked" and being retried, which
 * is a SECOND PROCESS contending — so the guarantee has to be proven with more
 * than one process or it is not proven at all.
 *
 * What it pins:
 *   X1  N processes racing to own ONE remote id → exactly one row exists, and
 *       exactly one process reports a create. The partial UNIQUE index is the
 *       only thing that can hold here; no amount of reading can.
 *   X2  the losers fail with a UNIQUE conflict (or lose the lock race outright),
 *       never by overwriting the winner — the old INSERT OR REPLACE would have
 *       deleted it.
 *   X3  concurrent rapid project moves under that contention never leave a row
 *       with a half-written identity (an id with no list, or the reverse).
 *
 * The parent deliberately does NOT import task-manager: it verifies through a
 * read-only sqlite handle, so the only writers are the child processes and the
 * assertions cannot be satisfied by the parent's own in-process cache.
 *
 * Run:
 *   WALNUT_LIVE_TEST=1 WALNUT_LIVE_CROSS_PROCESS=1 \
 *     npx vitest run --config vitest.live.config.ts \
 *     tests/live/remote-id-cross-process.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const GATED = !!process.env.WALNUT_LIVE_CROSS_PROCESS;
const describeMaybe = GATED ? describe : describe.skip;

const REMOTE_ID = 'cross-process-contested-id';
const ANCHOR_ID = 'anchor-row-0001';
const WORKER = path.resolve(__dirname, 'remote-id-cross-process-worker.ts');
// A real devDependency — `npx tsx` alone measured 88s of resolution on this
// machine, which is why CLAUDE.md forbids it in a test hot path.
const TSX = path.resolve(__dirname, '../../node_modules/.bin/tsx');

let home = '';

interface WorkerTally {
  pid: number; mode: string; created: number; conflict: number; busy: number;
  other: number; errors: string[];
}

function runWorker(mode: string, iterations: number): Promise<WorkerTally> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      TSX,
      [WORKER, home, mode, REMOTE_ID, String(iterations), ANCHOR_ID],
      {
        // NODE_ENV=test is LOAD-BEARING, not hygiene: without it constants.ts
        // treats an explicit /tmp home as a leaked env var and redirects to
        // ~/.open-walnut. The worker asserts the resolved home and exits 2
        // rather than writing to real data, so a regression here fails loudly.
        env: { ...process.env, NODE_ENV: 'test', OPEN_WALNUT_HOME: home, VITEST: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${mode} exited ${code}\nstderr: ${err.slice(0, 2000)}`));
        return;
      }
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (!line) { reject(new Error(`worker ${mode} printed no RESULT\nstdout: ${out.slice(0, 2000)}`)); return; }
      resolve(JSON.parse(line.slice('RESULT '.length)) as WorkerTally);
    });
  });
}

function readDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(home, 'tasks', 'tasks.sqlite'), { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

beforeAll(async () => {
  if (!GATED) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-xproc-'));
  expect(fs.existsSync(TSX), `tsx must be installed at ${TSX}`).toBe(true);
  const setup = await runWorker('setup', 1);
  expect(setup.created).toBe(1);
}, 180_000);

afterAll(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describeMaybe('remote-id uniqueness across PROCESSES', () => {
  it('X1/X2: 4 processes race for one remote id — exactly one row, no overwrite', async () => {
    // Two movers run at the same time purely to create write-lock contention,
    // so the inserts are not racing in a quiet database.
    const tallies = await Promise.all([
      runWorker('insert', 6),
      runWorker('insert', 6),
      runWorker('insert', 6),
      runWorker('insert', 6),
      runWorker('move', 12),
      runWorker('move', 12),
    ]);

    const inserters = tallies.filter((t) => t.mode === 'insert');
    const totalCreated = inserters.reduce((n, t) => n + t.created, 0);
    const totalConflict = inserters.reduce((n, t) => n + t.conflict, 0);

    // Distinct PIDs — proof these really were separate processes.
    expect(new Set(tallies.map((t) => t.pid)).size).toBe(tallies.length);
    for (const t of tallies) expect(t.errors, `unexpected errors in ${t.mode}`).toEqual([]);

    // X1: the row exists exactly once, whoever won.
    const rows = readDb((db) => db.prepare(
      `SELECT id FROM tasks WHERE source = 'ms-todo'
         AND json_extract(ext, '$."ms-todo".id') = ?`,
    ).all(REMOTE_ID));
    expect(rows).toHaveLength(1);

    // X1: and only one process believes it created it.
    expect(totalCreated).toBe(1);
    // X2: the other 23 attempts were refused, not silently swallowed as
    // successes and not applied by replacing the winner.
    expect(totalConflict).toBeGreaterThan(0);
    expect(totalCreated + totalConflict).toBe(24);
  }, 240_000);

  it('X3: no row is left with a half-written identity under lock contention', async () => {
    const bad = readDb((db) => db.prepare(
      `SELECT id, json_extract(ext, '$."ms-todo".id') AS rid,
              json_extract(ext, '$."ms-todo".list_id') AS lid
         FROM tasks WHERE source = 'ms-todo'
          AND (json_extract(ext, '$."ms-todo".id') IS NULL)
              <> (json_extract(ext, '$."ms-todo".list_id') IS NULL)`,
    ).all());
    expect(bad, 'id and list_id must be written together or not at all').toEqual([]);
  });

  it('X3: the index really is UNIQUE in the file the children wrote', async () => {
    // Guards against the whole suite passing because the constraint was never
    // created in this temp DB — then X1 would be proving nothing.
    const idx = readDb((db) => (db.pragma('index_list(tasks)') as Array<{ name: string; unique: number }>)
      .find((r) => r.name === 'idx_tasks_ext_ms_todo_id'));
    expect(idx, 'ext-id index should exist').toBeTruthy();
    expect(idx!.unique).toBe(1);
  });
});
