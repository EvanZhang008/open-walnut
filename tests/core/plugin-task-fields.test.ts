/**
 * Plugin-declared task fields (manifest `taskFields`).
 *
 * Covers the three backend layers:
 * 1. Manifest validation — well-formed specs parse; malformed entries are
 *    dropped without unloading the plugin.
 * 2. setPluginTaskField — ext.<pluginId>.<key> writes (set/clear), the
 *    coreField:'sprint' binding, and rejection of undeclared fields (no
 *    arbitrary ext writes through this path).
 * 3. Registry exposure — RegisteredPlugin.taskFields feeds
 *    GET /api/integrations/task-fields.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  getTask,
  setPluginTaskField,
  _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { registry } from '../../src/core/integration-registry.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import { loadPlugins } from '../../src/core/integration-loader.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { createNoopSync } from './plugin-test-utils.js';
import type { TaskFieldSpec } from '../../src/core/integration-types.js';

/** rm with retries — WAL checkpoint files can reappear mid-delete (ENOTEMPTY). */
async function rmWalnutHome(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function registerFieldPlugin(id: string, taskFields: TaskFieldSpec[]): void {
  registry.register(id, {
    id,
    name: id,
    config: {},
    sync: createNoopSync(),
    migrations: [],
    httpRoutes: [],
    taskFields,
  });
}

beforeEach(async () => {
  await rmWalnutHome();
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetTaskManager();
  registry.clear();
});

afterEach(async () => {
  closeDb();
  registry.clear();
  await rmWalnutHome();
});

// ── setPluginTaskField ──

describe('setPluginTaskField', () => {
  it('writes and clears ext.<pluginId>.<key>', async () => {
    registerFieldPlugin('tracker', [
      { key: 'board', label: 'Board', type: 'enum', optionsRoute: '/boards' },
    ]);
    const { task: created } = await addTask({ title: 'field test' });
    const id = created.id;

    await setPluginTaskField(id, 'tracker', 'board', 'Q3 Board');
    let task = await getTask(id);
    expect((task.ext?.tracker as Record<string, unknown>)?.board).toBe('Q3 Board');

    await setPluginTaskField(id, 'tracker', 'board', null);
    task = await getTask(id);
    expect((task.ext?.tracker as Record<string, unknown> | undefined)?.board).toBeUndefined();
  });

  it('preserves sibling ext keys when writing a field', async () => {
    registerFieldPlugin('tracker', [
      { key: 'board', label: 'Board', type: 'enum', optionsRoute: '/boards' },
    ]);
    const { task: created } = await addTask({ title: 'sibling ext' });
    const id = created.id;
    const before = await getTask(id);
    // Simulate the plugin's own sync ext (remote id etc.) already present.
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    await updateTaskRaw(before.id, { ext: { tracker: { id: 'remote-1' }, other: { keep: true } } });

    await setPluginTaskField(id, 'tracker', 'board', 'Q3 Board');
    const task = await getTask(id);
    expect((task.ext?.tracker as Record<string, unknown>)?.id).toBe('remote-1');
    expect((task.ext?.tracker as Record<string, unknown>)?.board).toBe('Q3 Board');
    expect((task.ext?.other as Record<string, unknown>)?.keep).toBe(true);
  });

  it('routes coreField:sprint to the core sprint column', async () => {
    registerFieldPlugin('tracker', [
      { key: 'sprint', label: 'Sprint', type: 'enum', optionsRoute: '/sprints', coreField: 'sprint' },
    ]);
    const { task: created } = await addTask({ title: 'sprint binding' });
    const id = created.id;

    await setPluginTaskField(id, 'tracker', 'sprint', 'Aug 3 - Aug 14');
    let task = await getTask(id);
    expect(task.sprint).toBe('Aug 3 - Aug 14');
    expect(task.ext?.tracker).toBeUndefined(); // core column, not ext

    await setPluginTaskField(id, 'tracker', 'sprint', null);
    task = await getTask(id);
    expect(task.sprint).toBeUndefined();
  });

  it('rejects undeclared plugins and fields', async () => {
    registerFieldPlugin('tracker', [
      { key: 'board', label: 'Board', type: 'enum', optionsRoute: '/boards' },
    ]);
    const { task: created } = await addTask({ title: 'reject test' });
    const id = created.id;

    await expect(setPluginTaskField(id, 'nope', 'board', 'x')).rejects.toThrow(/does not declare/);
    await expect(setPluginTaskField(id, 'tracker', 'undeclared', 'x')).rejects.toThrow(/does not declare/);
  });

  it('rejects clearing a clearable:false field', async () => {
    registerFieldPlugin('tracker', [
      { key: 'board', label: 'Board', type: 'enum', optionsRoute: '/boards', clearable: false },
    ]);
    const { task: created } = await addTask({ title: 'clear guard' });
    const id = created.id;
    await expect(setPluginTaskField(id, 'tracker', 'board', null)).rejects.toThrow(/not clearable/);
  });
});

// ── Manifest validation (via a real external plugin load) ──

describe('manifest taskFields validation', () => {
  const NOOP_SYNC_SOURCE = `{
    createTask: async () => null,
    deleteTask: async () => {},
    updateTitle: async () => {},
    updateDescription: async () => {},
    updateSummary: async () => {},
    updateNote: async () => {},
    updateConversationLog: async () => {},
    updatePriority: async () => {},
    updatePhase: async () => {},
    updateDueDate: async () => {},
      updateProject: async () => {},
    updateDependencies: async () => {},
    associateSubtask: async () => {},
    disassociateSubtask: async () => {},
    pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
    syncPoll: async () => {},
  }`;

  async function loadWithManifest(taskFields: unknown): Promise<IntegrationRegistry> {
    const pluginDir = path.join(WALNUT_HOME, 'plugins', 'field-plugin');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify({
      id: 'field-plugin',
      name: 'Field Plugin',
      version: '1.0.0',
      taskFields,
    }));
    await fs.writeFile(path.join(pluginDir, 'plugin.ts'), `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);
    const reg = new IntegrationRegistry();
    await loadPlugins(reg);
    return reg;
  }

  it('parses well-formed specs and defaults optional fields', async () => {
    const reg = await loadWithManifest([
      { key: 'sprint', label: 'Sprint', type: 'enum', optionsRoute: '/sprints', coreField: 'sprint' },
      { key: 'board', label: 'Board', type: 'enum', optionsRoute: '/boards', clearable: false },
    ]);
    const fields = reg.get('field-plugin')?.taskFields;
    expect(fields).toHaveLength(2);
    expect(fields?.[0]).toMatchObject({ key: 'sprint', coreField: 'sprint' });
    expect(fields?.[1]).toMatchObject({ key: 'board', clearable: false });
  });

  it('drops malformed entries but keeps the plugin and valid siblings', async () => {
    const reg = await loadWithManifest([
      { key: 'ok_field', label: 'OK', type: 'enum', optionsRoute: '/ok' },
      { key: 'Bad Key!', label: 'X', type: 'enum', optionsRoute: '/x' },   // bad key charset
      { key: 'notype', label: 'X', type: 'text', optionsRoute: '/x' },     // unsupported type
      { key: 'noroute', label: 'X', type: 'enum', optionsRoute: 'rel' },   // route must start with /
      { key: 'ok_field', label: 'Dup', type: 'enum', optionsRoute: '/d' }, // duplicate key
      { key: 'badcore', label: 'X', type: 'enum', optionsRoute: '/x', coreField: 'title' }, // unhonored coreField
      'not-an-object',
    ]);
    expect(reg.has('field-plugin')).toBe(true);
    const fields = reg.get('field-plugin')?.taskFields;
    expect(fields).toHaveLength(1);
    expect(fields?.[0].key).toBe('ok_field');
  });

  it('omits taskFields entirely when every entry is invalid', async () => {
    const reg = await loadWithManifest([{ key: 'BAD', label: 'X', type: 'enum', optionsRoute: '/x' }]);
    expect(reg.has('field-plugin')).toBe(true);
    expect(reg.get('field-plugin')?.taskFields).toBeUndefined();
  });
});
