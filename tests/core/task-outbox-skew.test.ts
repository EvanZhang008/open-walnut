/**
 * Outbox version-skew tests (category removal).
 *
 * A cloud companion running pre-refactor code keeps emitting ops that carry the
 * retired `category` field. The primary must tolerate them:
 *   - `category` is NOT in UPDATE_WHITELIST → never written onto a primary row.
 *   - An op with a category but an EMPTY project leaves the task in Inbox — the
 *     category must never be resurrected as a project name (that would invent
 *     projects and, for a claimed name, silently hand the task to a provider).
 *   - An op with a real project registers that project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const constantsBase = createMockConstants('walnut-outbox-skew');

type Modules = {
  outbox: typeof import('../../src/core/task-outbox.js');
  tm: typeof import('../../src/core/task-manager.js');
  taskDb: typeof import('../../src/core/task-db.js');
};

/** Load the modules with CLOUD_MODE=false (primary box — the applier side). */
async function loadPrimary(): Promise<Modules> {
  vi.resetModules();
  vi.doMock('../../src/constants.js', () => ({ ...constantsBase, CLOUD_MODE: false }));
  return {
    outbox: await import('../../src/core/task-outbox.js'),
    tm: await import('../../src/core/task-manager.js'),
    taskDb: await import('../../src/core/task-db.js'),
  };
}

async function writeOp(dir: string, name: string, op: unknown): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), JSON.stringify(op));
}

let current: Modules | undefined;

async function wipeHome(mods?: Modules): Promise<void> {
  if (mods) {
    mods.taskDb.closeDb();
    mods.tm._resetForTesting();
  }
  await fsp.rm(constantsBase.WALNUT_HOME as string, { recursive: true, force: true });
  await fsp.mkdir(constantsBase.TASKS_DIR as string, { recursive: true });
}

beforeEach(async () => { await wipeHome(current); });
afterEach(async () => {
  await wipeHome(current);
  current = undefined;
  vi.resetModules();
});

describe('task-outbox version skew: legacy ops carrying `category`', () => {
  it('ignores `category` on an update op — it can never land on the primary row', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'primary row', project: 'Marina' });
    const freshAt = new Date(Date.parse(task.updated_at) + 60_000).toISOString();

    await writeOp(outbox.OUTBOX_DIR, '001.json', {
      opId: '001', type: 'update', at: freshAt,
      task: {
        ...task,
        title: 'phone rename',
        updated_at: freshAt,
        // Legacy field emitted by an old cloud box.
        category: 'Work',
      },
    });

    const applied = await outbox.applyOutboxOnPrimary();
    expect(applied).toBe(1);

    const after = await tm.getTask(task.id);
    expect(after.title).toBe('phone rename');
    expect(after.project).toBe('Marina');
    // The retired column is gone from the model; nothing smuggled it back in.
    expect((after as unknown as Record<string, unknown>).category).toBeUndefined();
  });

  it('keeps an empty project as Inbox even when the op names a category', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;

    const now = new Date().toISOString();
    await writeOp(outbox.OUTBOX_DIR, '001.json', {
      opId: '001', type: 'create', at: now,
      task: {
        id: 'legacy-cloud-1', title: 'phone capture', status: 'todo', phase: 'TODO',
        priority: 'none', category: 'Work', project: '', source: 'local',
        session_ids: [], description: '', summary: '', note: '',
        created_at: now, updated_at: now,
      },
    });

    expect(await outbox.applyOutboxOnPrimary()).toBe(1);

    const created = await tm.getTask('legacy-cloud-1');
    expect(created.project).toBe('');   // Inbox, NOT 'Work'
    expect(created.source).toBe('local');
    // The category must not have leaked into the project registry either.
    expect(await tm.getStoreProjects()).toEqual({});
  });

  it('does not resurrect a category even when a project of that name is claimed', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;

    // A project named like the legacy category exists AND is claimed by a provider.
    await tm.ensureProject('Work', 'ms-todo');

    const now = new Date().toISOString();
    await writeOp(outbox.OUTBOX_DIR, '001.json', {
      opId: '001', type: 'create', at: now,
      task: {
        id: 'legacy-cloud-2', title: 'phone capture', status: 'todo', phase: 'TODO',
        priority: 'none', category: 'Work', project: '', source: 'local',
        session_ids: [], description: '', summary: '', note: '',
        created_at: now, updated_at: now,
      },
    });

    expect(await outbox.applyOutboxOnPrimary()).toBe(1);
    const created = await tm.getTask('legacy-cloud-2');
    expect(created.project).toBe('');
    // Crucially it did NOT adopt the ms-todo claim of the same-named project.
    expect(created.source).toBe('local');
  });

  it('registers a real project from a create op and inherits its existing claim', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;

    await tm.ensureProject('Synced', 'ms-todo');
    const now = new Date().toISOString();
    await writeOp(outbox.OUTBOX_DIR, '001.json', {
      opId: '001', type: 'create', at: now,
      task: {
        id: 'cloud-proj-1', title: 'phone task', status: 'todo', phase: 'TODO',
        priority: 'none', project: 'Synced', source: 'local',
        session_ids: [], description: '', summary: '', note: '',
        created_at: now, updated_at: now,
      },
    });
    await writeOp(outbox.OUTBOX_DIR, '002.json', {
      opId: '002', type: 'create', at: now,
      task: {
        id: 'cloud-proj-2', title: 'new project task', status: 'todo', phase: 'TODO',
        priority: 'none', project: 'Fresh', source: 'local',
        session_ids: [], description: '', summary: '', note: '',
        created_at: now, updated_at: now,
      },
    });

    expect(await outbox.applyOutboxOnPrimary()).toBe(2);

    // Cloud always stamps 'local'; the primary recomputes from the registry.
    expect((await tm.getTask('cloud-proj-1')).source).toBe('ms-todo');
    const fresh = await tm.getTask('cloud-proj-2');
    expect(fresh.project).toBe('Fresh');
    expect(fresh.source).toBe('local');
    expect(Object.keys(await tm.getStoreProjects()).sort()).toEqual(['Fresh', 'Synced']);
  });
});
