/**
 * Tests for task-outbox.ts — two-way cloud⇄primary task sync over git-sync.
 *
 * CLOUD_MODE is a compile-time constant read at import, so the two sides are
 * exercised in separate describe blocks via vi.resetModules() + doMock with a
 * different CLOUD_MODE override, against the same tmp WALNUT_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../helpers/mock-constants.js';

const tmpBase = path.join(os.tmpdir(), `walnut-outbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const constantsBase = createMockConstants('walnut-outbox');
// Pin all paths to ONE tmp home for both mode variants.
for (const [k, v] of Object.entries(constantsBase)) {
  if (typeof v === 'string' && v.includes('walnut-outbox')) {
    (constantsBase as Record<string, unknown>)[k] = v; // keep
  }
}

type Modules = {
  outbox: typeof import('../../src/core/task-outbox.js');
  tm: typeof import('../../src/core/task-manager.js');
  taskDb: typeof import('../../src/core/task-db.js');
  projection: typeof import('../../src/core/task-projection.js');
};

async function loadWithCloudMode(cloud: boolean): Promise<Modules> {
  vi.resetModules();
  vi.doMock('../../src/constants.js', () => ({ ...constantsBase, CLOUD_MODE: cloud }));
  const outbox = await import('../../src/core/task-outbox.js');
  const tm = await import('../../src/core/task-manager.js');
  const taskDb = await import('../../src/core/task-db.js');
  const projection = await import('../../src/core/task-projection.js');
  return { outbox, tm, taskDb, projection };
}

async function wipeHome(mods?: Modules): Promise<void> {
  if (mods) {
    mods.taskDb.closeDb();
    mods.tm._resetForTesting();
  }
  await fsp.rm(constantsBase.WALNUT_HOME as string, { recursive: true, force: true });
  await fsp.mkdir(constantsBase.TASKS_DIR as string, { recursive: true });
}

let current: Modules | undefined;

beforeEach(async () => {
  await wipeHome(current);
});

afterEach(async () => {
  await wipeHome(current);
  current = undefined;
  vi.resetModules();
});

// ── Cloud side: recordTaskOp + importProjectionOnCloud ─────────────────────

describe('task-outbox: cloud side', () => {
  it('recordTaskOp drops one op file per mutation; primary-mode recordTaskOp is a no-op', async () => {
    current = await loadWithCloudMode(true);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'born on cloud', source: 'local' });
    await outbox.recordTaskOp({ type: 'create', task });
    await outbox.recordTaskOp({ type: 'update', task: { ...task, title: 'renamed' } });
    await outbox.recordTaskOp({ type: 'delete', id: task.id });

    const files = (await fsp.readdir(outbox.OUTBOX_DIR)).filter((f) => f.endsWith('.json')).sort();
    expect(files.length).toBe(3);
    const ops = await Promise.all(files.map(async (f) =>
      JSON.parse(await fsp.readFile(path.join(outbox.OUTBOX_DIR, f), 'utf-8'))));
    expect(ops.map((o) => o.type)).toEqual(['create', 'update', 'delete']);

    // Primary mode: no-op
    current = await loadWithCloudMode(false);
    await current.outbox.recordTaskOp({ type: 'delete', id: 'nope' });
    const after = (await fsp.readdir(current.outbox.OUTBOX_DIR)).filter((f) => f.endsWith('.json'));
    expect(after.length).toBe(3); // unchanged
  });

  it('importProjectionOnCloud upserts projection rows, never deletes, skips ids with pending ops', async () => {
    current = await loadWithCloudMode(true);
    const { outbox, tm, projection } = current;

    // A cloud-born task with a pending op — must NOT be clobbered by import.
    const { task: cloudTask } = await tm.addTask({ title: 'cloud pending', source: 'local' });
    await outbox.recordTaskOp({ type: 'update', task: cloudTask });

    const now = new Date().toISOString();
    await fsp.mkdir(path.dirname(projection.PROJECTION_FILE), { recursive: true });
    await fsp.writeFile(projection.PROJECTION_FILE, JSON.stringify({
      version: projection.PROJECTION_VERSION,
      exportedAt: now,
      tasks: [
        { id: 'mac-task-1', title: 'from mac', status: 'todo', phase: 'TODO', priority: 'none',
          project: 'Walnut', created_at: now, updated_at: now },
        // Same id as the cloud task but "newer" — must be skipped (pending op).
        { id: cloudTask.id, title: 'MAC CLOBBER', status: 'todo', phase: 'TODO', priority: 'none',
          project: '', created_at: now,
          updated_at: new Date(Date.now() + 60_000).toISOString() },
      ],
    }));

    const changed = await outbox.importProjectionOnCloud();
    expect(changed).toBe(1); // only mac-task-1

    const all = await tm.listTasks();
    expect(all.find((t) => t.id === 'mac-task-1')?.title).toBe('from mac');
    expect(all.find((t) => t.id === cloudTask.id)?.title).toBe('cloud pending'); // not clobbered

    // Unchanged mtime → cheap skip (returns 0 without re-reading).
    expect(await outbox.importProjectionOnCloud()).toBe(0);
  });

  // The delete-reconcile pass infers "the primary deleted it" from ABSENCE, so
  // it is only sound against a complete list. These two cases are a pair: the
  // same absent row must be deleted by a complete projection and survive a
  // truncated one, otherwise the exporter's byte budget would silently delete
  // live tasks on the replica instead of merely omitting them.
  async function seedAbsentRowAndImport(truncated: boolean): Promise<{ mods: Modules; id: string }> {
    const mods = await loadWithCloudMode(true);
    const { outbox, tm, projection } = mods;
    const { task: local } = await tm.addTask({ title: 'only on the replica', source: 'local' });
    // exportedAt comfortably past the row's write → clears IMPORT_DELETE_SAFETY_MS.
    await fsp.mkdir(path.dirname(projection.PROJECTION_FILE), { recursive: true });
    await fsp.writeFile(projection.PROJECTION_FILE, JSON.stringify({
      version: projection.PROJECTION_VERSION,
      exportedAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      ...(truncated ? { truncated: true } : {}),
      tasks: [],
    }));
    await outbox.importProjectionOnCloud();
    return { mods, id: local.id };
  }

  it('a COMPLETE projection reconciles a primary-side delete (row absent → removed locally)', async () => {
    const { mods, id } = await seedAbsentRowAndImport(false);
    current = mods;
    expect((await mods.tm.listTasks()).some((t) => t.id === id)).toBe(false);
  });

  it('a TRUNCATED projection must NOT delete the rows its budget dropped', async () => {
    const { mods, id } = await seedAbsentRowAndImport(true);
    current = mods;
    expect((await mods.tm.listTasks()).some((t) => t.id === id)).toBe(true);
  });
});

// ── Primary side: applyOutboxOnPrimary ──────────────────────────────────────

describe('task-outbox: primary side', () => {
  async function writeOp(dir: string, name: string, op: unknown): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, name), JSON.stringify(op));
  }

  it('create op inserts with the SAME id, ensures the project registry row, deletes the op file', async () => {
    current = await loadWithCloudMode(false);
    const { outbox, tm } = current;

    const now = new Date().toISOString();
    const snapshot = {
      id: 'cloud-born-1', title: 'phone task', status: 'todo', phase: 'TODO', priority: 'none',
      project: 'Walnut', source: 'local', session_ids: [],
      description: 'from the phone', summary: '', note: '', created_at: now, updated_at: now,
    };
    await writeOp(outbox.OUTBOX_DIR, '001.json', { opId: '001', type: 'create', at: now, task: snapshot });

    const applied = await outbox.applyOutboxOnPrimary();
    expect(applied).toBe(1);

    const created = await tm.getTask('cloud-born-1');
    expect(created.title).toBe('phone task');
    expect(created.description).toBe('from the phone');
    expect(created.project).toBe('Walnut');
    // The create path registers the project (ensureProject) so the group exists.
    expect(await tm.getProjectRecord('walnut')).toMatchObject({ name: 'Walnut', source: 'local' });
    // Op file consumed.
    const left = (await fsp.readdir(outbox.OUTBOX_DIR)).filter((f) => f.endsWith('.json'));
    expect(left.length).toBe(0);
    // Idempotent second pass.
    expect(await outbox.applyOutboxOnPrimary()).toBe(0);
  });

  it('update op applies whitelisted fields via LWW; a STALE snapshot never clobbers a newer local edit', async () => {
    current = await loadWithCloudMode(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'local truth', source: 'local' });
    // Local edit happens AFTER the phone snapshot was taken.
    await new Promise((r) => setTimeout(r, 5));
    await tm.updateTask(task.id, { title: 'local newer edit' });
    const localNow = (await tm.getTask(task.id)).updated_at;

    // Stale phone snapshot (older updated_at) — must be skipped.
    const staleAt = new Date(Date.parse(localNow) - 60_000).toISOString();
    await writeOp(outbox.OUTBOX_DIR, '001.json', {
      opId: '001', type: 'update', at: staleAt,
      task: { ...task, title: 'STALE PHONE TITLE', updated_at: staleAt },
    });
    await outbox.applyOutboxOnPrimary();
    expect((await tm.getTask(task.id)).title).toBe('local newer edit');

    // Fresh phone snapshot — applies, but only whitelisted fields.
    const freshAt = new Date(Date.parse(localNow) + 60_000).toISOString();
    await writeOp(outbox.OUTBOX_DIR, '002.json', {
      opId: '002', type: 'update', at: freshAt,
      task: {
        ...task, title: 'phone rename', updated_at: freshAt,
        // NOT whitelisted — must never land on the primary row:
        source: 'ms-todo', external_url: 'https://evil.example', session_id: 'hijack',
      },
    });
    await outbox.applyOutboxOnPrimary();
    const after = await tm.getTask(task.id);
    expect(after.title).toBe('phone rename');
    expect(after.source).toBe('local');
    expect(after.external_url).toBeUndefined();
    expect(after.session_id).toBeUndefined();
  });

  it('delete op removes the task; deleting a missing task is a clean no-op', async () => {
    current = await loadWithCloudMode(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'to delete', source: 'local' });
    const now = new Date().toISOString();
    await writeOp(outbox.OUTBOX_DIR, '001.json', { opId: '001', type: 'delete', at: now, id: task.id });
    await writeOp(outbox.OUTBOX_DIR, '002.json', { opId: '002', type: 'delete', at: now, id: 'never-existed' });

    const applied = await outbox.applyOutboxOnPrimary();
    expect(applied).toBe(2);
    await expect(tm.getTask(task.id)).rejects.toThrow(/No task found/);
    const left = (await fsp.readdir(outbox.OUTBOX_DIR)).filter((f) => f.endsWith('.json'));
    expect(left.length).toBe(0);
  });

  it('malformed op files are dropped without wedging the queue', async () => {
    current = await loadWithCloudMode(false);
    const { outbox, tm } = current;

    const now = new Date().toISOString();
    await writeOp(outbox.OUTBOX_DIR, '000-bad.json', 'not json at all');
    await fsp.writeFile(path.join(outbox.OUTBOX_DIR, '000-bad.json'), '{{{ not json');
    const snapshot = {
      id: 'ok-1', title: 'good op', status: 'todo', phase: 'TODO', priority: 'none',
      project: '', source: 'local', session_ids: [],
      description: '', summary: '', note: '', created_at: now, updated_at: now,
    };
    await writeOp(outbox.OUTBOX_DIR, '001.json', { opId: '001', type: 'create', at: now, task: snapshot });

    const applied = await outbox.applyOutboxOnPrimary();
    expect(applied).toBe(1);
    expect((await tm.getTask('ok-1')).title).toBe('good op');
    const left = (await fsp.readdir(outbox.OUTBOX_DIR)).filter((f) => f.endsWith('.json'));
    expect(left.length).toBe(0); // bad file dropped too
  });
});
