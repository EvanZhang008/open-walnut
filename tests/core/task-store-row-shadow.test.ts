/**
 * Tests for writeStore()'s row shadow — the "session panel opens instantly" fix.
 *
 * Background: every exported task-manager helper is read-whole-store → mutate →
 * writeStore(), and writeStore used to re-INSERT EVERY task row on any edit. With
 * ~4k tasks that's ~600ms of SQLite per call, and one quick-start runs ~5 such
 * helpers (addTask → updateTask → togglePin → setFocusTier → linkSession), so a
 * single "start session" click burned seconds before the CLI was even spawned.
 *
 * The shadow makes the steady-state write O(changed rows). These tests pin the
 * INVARIANTS that make that safe — a stale shadow must never silently drop a
 * write:
 *   1. an edit through writeStore still persists (the diff finds the change)
 *   2. a write from ANOTHER connection is not clobbered (data_version sentinel)
 *   3. the per-row fast paths (which bypass writeStore on our own connection)
 *      invalidate the shadow, so a later whole-store write re-writes their rows
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-row-shadow'));

import {
  addTask,
  updateTask,
  updateTaskRaw,
  getTask,
  listTasks,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { TASK_DB_PATH } from '../../src/core/task-db.js';

// NOTE: no per-test rm of WALNUT_HOME. task-db holds a module-level singleton
// connection, so deleting the file underneath it leaves the handle pointing at an
// unlinked inode — a second connection would then open a fresh, EMPTY db ("no such
// table: tasks"). Every test creates its own tasks and asserts only on those ids,
// so a shared store is sufficient and keeps the real connection semantics that the
// data_version sentinel depends on.
describe('writeStore row shadow', () => {
  // Ensure the module-level init flag is set once; the shared db stays open.
  _resetForTesting();

  it('persists repeated edits through the whole-store path', async () => {
    const { task } = await addTask({ title: 'first', category: 'Local', source: 'local' });

    // Several sequential edits: each one is a writeStore() whose diff must catch
    // the single changed row. A broken diff shows up as a lost update.
    await updateTask(task.id, { title: 'second' });
    expect((await getTask(task.id)).title).toBe('second');

    await updateTask(task.id, { title: 'third' });
    expect((await getTask(task.id)).title).toBe('third');

    // Unrelated rows must survive the skip-unchanged path.
    const { task: other } = await addTask({ title: 'sibling', category: 'Local', source: 'local' });
    await updateTask(task.id, { title: 'fourth' });
    expect((await getTask(task.id)).title).toBe('fourth');
    expect((await getTask(other.id)).title).toBe('sibling');
  });

  it('re-writes rows changed by another connection (data_version sentinel)', async () => {
    // Two tasks: we edit `other`, while `victim` is untouched in our snapshot.
    const { task: victim } = await addTask({ title: 'victim', category: 'Local', source: 'local' });
    const { task: other } = await addTask({ title: 'other', category: 'Local', source: 'local' });
    // Seed the shadow: it now records victim's fingerprint as title='victim'.
    await updateTask(victim.id, { title: 'seeded' });
    // Warm the whole-store read cache so the next writeStore's snapshot comes from
    // memory (holding title='seeded') rather than re-reading the foreign value.
    await listTasks();

    // Simulate the on-stop hook (src/hooks/shared.ts): a DIFFERENT connection
    // writes victim behind our back. Our shadow now disagrees with the DB.
    const foreign = new Database(TASK_DB_PATH);
    foreign.pragma('journal_mode = WAL');
    foreign.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('changed-externally', victim.id);
    foreign.close();

    // Whole-store write that does NOT touch victim. The data_version sentinel
    // must notice the foreign commit BEFORE the read-modify-write: the stale
    // whole-store cache is dropped, the snapshot re-reads the DB and adopts the
    // foreign value, and writeStore persists a state that includes it.
    //
    // (Historical note: this test used to assert the OPPOSITE — that our stale
    // in-memory 'seeded' value was restored over the foreign write. That "our
    // snapshot wins" semantics is exactly what caused the 2026-08-04 task-loss
    // incident: a second server process's stale snapshot deleted rows the first
    // process had just created. External commits are now authoritative.)
    await updateTask(other.id, { title: 'other-2' });

    expect((await getTask(victim.id)).title).toBe('changed-externally');
    expect((await getTask(other.id)).title).toBe('other-2');
  });

  // Regression guard for the fast-path/whole-store interleaving. updateTaskRaw
  // issues a targeted UPDATE on OUR connection, so data_version does NOT move and
  // the shadow keeps the pre-patch fingerprint. Today this is still safe because
  // withWriteLock invalidates the whole-store read cache after every mutation, so
  // the next writeStore re-reads the patched row and its fingerprint no longer
  // matches the stale shadow. That makes writeStore's invalidateRowShadow() call
  // defense-in-depth rather than load-bearing — this test pins the OBSERVABLE
  // contract (a raw write is never resurrected by a later whole-store write) so
  // the pairing keeps holding if that cache behavior is ever changed.
  it('does not resurrect a per-row fast-path write on the next whole-store write', async () => {
    const { task } = await addTask({ title: 'raw-base', category: 'Local', source: 'local' });
    await updateTask(task.id, { title: 'via-writestore' });

    const res = await updateTaskRaw(task.id, { title: 'via-raw' });
    expect(res.changed).toBe(true);
    expect((await getTask(task.id)).title).toBe('via-raw');

    // A later whole-store write must not roll the title back to 'via-writestore'.
    await updateTask(task.id, { priority: 'backlog' });
    const after = await getTask(task.id);
    expect(after.title).toBe('via-raw');
    expect(after.priority).toBe('backlog');
  });

  // Order is persisted as SQLite rowid order, so reorderTasks() permutes array slots
  // WITHOUT changing any field. A content-only diff sees zero changed rows and would
  // silently drop the reorder — this pins the order-aware skip decision.
  it('persists a pure reorder (no field changes)', async () => {
    const cat = 'ReorderCat';
    const proj = 'ReorderProj';
    const { task: a } = await addTask({ title: 'a', category: cat, project: proj, source: 'local' });
    const { task: b } = await addTask({ title: 'b', category: cat, project: proj, source: 'local' });
    const { task: c } = await addTask({ title: 'c', category: cat, project: proj, source: 'local' });

    // Seed the shadow so the reorder runs against a populated shadow.
    await listTasks();

    const { reorderTasks } = await import('../../src/core/task-manager.js');
    await reorderTasks(cat, proj, [c.id, a.id, b.id]);

    const inGroup = (await listTasks())
      .filter((t) => t.category === cat && t.project === proj)
      .map((t) => t.id);
    expect(inGroup).toEqual([c.id, a.id, b.id]);
  });

  it('still deletes rows dropped from the store snapshot', async () => {
    const { task: keep } = await addTask({ title: 'keep', category: 'Local', source: 'local' });
    const { task: drop } = await addTask({ title: 'drop', category: 'Local', source: 'local' });
    // Seed the shadow so the delete path runs with a populated shadow.
    await updateTask(keep.id, { title: 'keep-2' });

    const { deleteTask } = await import('../../src/core/task-manager.js');
    await deleteTask(drop.id);

    const ids = (await listTasks()).map((t) => t.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(drop.id);
  });
});
