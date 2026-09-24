/**
 * One REAL process in the cross-process remote-id race (see
 * remote-id-cross-process.live.test.ts). Spawned, never imported.
 *
 * Exists because the in-process suite cannot reach the failure it covers: Walnut
 * serializes writes with an in-process promise chain PLUS a cross-process file
 * lock, and only separate OS processes exercise the second one — including the
 * `SQLITE_BUSY` / "database is locked" retries the 2026-09-01 report described.
 *
 * SAFETY: the parent must spawn this with NODE_ENV=test AND an explicit temp
 * OPEN_WALNUT_HOME. Without NODE_ENV=test, constants.ts treats a /tmp home as a
 * "leaked ephemeral env var" and silently REDIRECTS to ~/.open-walnut, i.e. the
 * user's real data. The assertion below refuses to write if that happened,
 * because a wrong answer here would be destructive rather than merely red.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../src/constants.js';

type Mode = 'setup' | 'insert' | 'move';

const [expectedHome, mode, remoteId, itersRaw, anchorId] = process.argv.slice(2) as [
  string, Mode, string, string, string,
];
const iterations = Number(itersRaw) || 1;

if (path.resolve(WALNUT_HOME) !== path.resolve(expectedHome)) {
  process.stderr.write(
    `REFUSING: resolved WALNUT_HOME=${WALNUT_HOME} but parent asked for ${expectedHome}. ` +
    `Spawn with NODE_ENV=test so constants.ts trusts an explicit temp home.\n`,
  );
  process.exit(2);
}

const SPEC = { source: 'ms-todo', paths: [{ key: 'id', json: '$."ms-todo".id' }] };

function classify(err: unknown): 'conflict' | 'busy' | 'other' {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(msg)) return 'conflict';
  if (/SQLITE_BUSY|database is locked/i.test(msg)) return 'busy';
  return 'other';
}

async function main(): Promise<void> {
  const { setExtIndexes } = await import('../../src/core/ext-index-registry.js');
  setExtIndexes([SPEC]);
  const { addTasksBulk, updateTasksBulk, listTasks } = await import('../../src/core/task-manager.js');
  const { ensureExtIndexes } = await import('../../src/core/task-db.js');

  // Touch the store so the schema exists before any raw index work.
  await listTasks();
  ensureExtIndexes([SPEC]);

  const tally = { created: 0, conflict: 0, busy: 0, other: 0, errors: [] as string[] };

  if (mode === 'setup') {
    // An anchor row the `move` workers can hammer, distinct from the contested id.
    await addTasksBulk([{
      id: anchorId,
      title: 'anchor', status: 'todo', phase: 'TODO', priority: 'none',
      project: 'Alpha', source: 'ms-todo', session_ids: [],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      description: '', summary: '', note: '',
      ext: { 'ms-todo': { id: `${remoteId}-anchor`, list_id: 'list-A' } },
    } as never]);
    tally.created++;
  }

  for (let i = 0; mode !== 'setup' && i < iterations; i++) {
    try {
      if (mode === 'insert') {
        // Every process races to own the SAME remote id.
        const made = await addTasksBulk([{
          title: `racer ${process.pid}#${i}`,
          status: 'todo', phase: 'TODO', priority: 'none',
          project: 'Alpha', source: 'ms-todo', session_ids: [],
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          description: '', summary: '', note: '',
          ext: { 'ms-todo': { id: remoteId, list_id: 'list-A' } },
        } as never]);
        tally.created += made.length;
      } else {
        // Rapid project moves — the write-lock pressure from the original report.
        await updateTasksBulk([{ id: anchorId, patch: { project: i % 2 ? 'Alpha' : 'Beta' } }]);
      }
    } catch (err) {
      const kind = classify(err);
      tally[kind]++;
      if (kind === 'other' && tally.errors.length < 5) {
        tally.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  process.stdout.write(`RESULT ${JSON.stringify({ pid: process.pid, mode, ...tally })}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`WORKER FAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
