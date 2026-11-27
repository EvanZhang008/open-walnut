/**
 * A strip pass of the prompt split in a process of its own, for a parent that kills it
 * (tests/core/session-prompts-crash.test.ts). OPEN_WALNUT_HOME is the parent's temp home; it prints
 * `batch <n>` after each batch commits and spins 20 ms, so a SIGKILL after n lines lands in the
 * pass with later batches still to run. Prints `done` at the end. STRIP_HOLD_AT_UPDATE=n: the n-th
 * row write of the pass prints `in-tx` and spins before it runs, inside its batch's open transaction
 * (the rows before it in that batch already written), for a kill there.
 */
const home = process.env.OPEN_WALNUT_HOME;
if (!home || !(process.env.VITEST || process.env.NODE_ENV === 'test')) throw new Error('prompt-strip-child: run only from a test, with OPEN_WALNUT_HOME set');
const { WALNUT_HOME } = await import('../../src/constants.ts');
if (WALNUT_HOME !== home) throw new Error(`prompt-strip-child: home ${WALNUT_HOME} is not ${home}`);
const tracker = await import('../../src/core/session-tracker.ts');
const { runPromptPass } = await import('../../src/core/session-prompt-jobs.ts');
await tracker.listSessions();
const holdAt = Number(process.env.STRIP_HOLD_AT_UPDATE ?? 0);
if (holdAt > 0) {
  const { getDb } = await import('../../src/core/session-db.ts');
  const db = getDb()!;
  const prepare = db.prepare.bind(db);
  let writes = 0;
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string, ...rest: unknown[]) => {
    const stmt = (prepare as (...a: unknown[]) => any)(sql, ...rest);
    if (!sql.startsWith('UPDATE sessions SET payload = ?')) return stmt;
    const run = stmt.run.bind(stmt);
    stmt.run = (...a: unknown[]) => {
      if (++writes === holdAt) {
        if (!db.inTransaction) throw new Error('prompt-strip-child: the row write is not in a transaction');
        process.stdout.write('in-tx\n');
        for (;;) { /* spin until the parent kills this process */ }
      }
      return run(...a);
    };
    return stmt;
  }) as typeof db.prepare;
}
let n = 0;
await runPromptPass('strip', {
  batchRows: Number(process.env.STRIP_BATCH_ROWS ?? 2),
  onBatch: () => {
    process.stdout.write(`batch ${++n}\n`);
    for (const until = Date.now() + 20; Date.now() < until;) { /* spin: the parent's kill lands here or in the next batch */ }
  },
});
process.stdout.write('done\n');
process.exit(0);
