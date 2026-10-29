/**
 * A task store that cannot open fails each task write; it never wedges the write lock.
 *
 * getDb() rethrows a failed open, and the write lock read the connection's change
 * counter through it while taking and releasing the lock. The throw skipped the
 * release, so every later task write (and the first read, which seeds projects under
 * the lock) waited forever, even after the store could open again. 2026-10-28: a
 * test teardown removed the data dir under an open, and a later session attach hung.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-task-db-open-failure'));

import { addTask, getTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb, TASK_DB_PATH } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

/** Where a promise stands after `ms`: settled one way or the other, or still pending. */
function within(p: Promise<unknown>, ms = 3_000): Promise<string> {
  return Promise.race([
    p.then(() => 'resolved', (err) => `rejected: ${String(err)}`),
    new Promise<string>((r) => setTimeout(() => r('pending'), ms)),
  ]);
}

describe('task writes while the task store cannot open', () => {
  beforeEach(async () => {
    closeDb();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    // A directory where the database file belongs: every open fails.
    await fs.mkdir(TASK_DB_PATH, { recursive: true });
  });

  afterEach(async () => {
    closeDb();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
  });

  it('each write fails on its own, and the store works again once it can open', async () => {
    const first = await within(addTask({ title: 'Acme first', project: 'Acme' }));
    expect(first).toMatch(/^rejected: /);
    // The second write waits on the first one's release; before the fix it never came.
    const second = await within(addTask({ title: 'Acme second', project: 'Acme' }));
    expect(second).toMatch(/^rejected: /);

    await fs.rm(TASK_DB_PATH, { recursive: true, force: true });
    closeDb();
    _resetForTesting();
    // The first read after a fresh open seeds the projects under the same lock, so it
    // waited forever too. Plain awaits: the test's own timeout bounds a hang here.
    await expect(getTask('no-such-task')).rejects.toThrow(/No task found/);
    await expect(addTask({ title: 'Acme third', project: 'Acme' })).resolves.toBeTruthy();
  });
});
