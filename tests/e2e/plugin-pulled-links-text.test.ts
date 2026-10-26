/**
 * A real sync tick on a real server (src/web/server.ts, src/core/pulled-patch.ts): a pulled patch
 * never empties a local description and never shortens a parent link to the id prefix the remote
 * stores, and a row an older pull already wrote with a prefix is repaired. 2026-10-26: new To Do
 * tasks came back from their first pull with no description and a parent of "abcd1234" instead
 * of "abcd1234-…", and dropped out of their lead's team.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-pulled-links-text'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js';
import type { Task } from '../../src/core/types.js';

const control = { patches: [] as Array<{ id: string; updates: Partial<Task> }>, polls: 0 };
const key = '__walnutPulledLinksFixture';
const globals = globalThis as unknown as Record<string, unknown>;
const savedEnv = new Map<string, string | undefined>();

async function until(what: string, ok: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  for (const [k, v] of Object.entries({ WALNUT_SYNC_FIRST_TICK_MS: '200', WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1' })) {
    savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  }
  globals[key] = control;
  await fs.mkdir(path.join(WALNUT_HOME, 'plugins/linkfixture'), { recursive: true });
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), JSON.stringify({ plugins: { linkfixture: { enabled: true, sync_interval_ms: 100 } } }));
  await fs.writeFile(path.join(WALNUT_HOME, 'plugins/linkfixture/manifest.json'), JSON.stringify({
    id: 'linkfixture', name: 'Link fixture', version: '1.0.0', external: true,
  }));
  await fs.writeFile(path.join(WALNUT_HOME, 'plugins/linkfixture/index.mjs'), `
const noop = async () => {};
export default function register(api) {
  api.registerExtIndex({ source: 'linkfixture', paths: [{ key: 'id', json: '$."linkfixture".id', unique: true }] });
  api.registerSync({
    createTask: async () => null, deleteTask: noop,
    updateTitle: noop, updateDescription: noop, updateSummary: noop, updateNote: noop,
    updateConversationLog: noop, updatePriority: noop, updatePhase: noop, updateDueDate: noop,
    updateProject: noop, updateDependencies: noop, associateSubtask: noop, disassociateSubtask: noop,
    pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
    async syncPoll(ctx) {
      const c = globalThis.${key};
      c.polls += 1;
      for (const p of c.patches.splice(0)) await ctx.updateTask(p.id, p.updates);
    },
  });
}
`);
  await startServer({ port: 0, dev: true });
}, 90_000);

afterAll(async () => {
  await stopServer();
  delete globals[key];
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('a sync pull', () => {
  it('keeps a new task\'s description and full parent id through its first pull, and repairs a stored prefix', async () => {
    const lead = (await addTask({ title: 'Lead', project: 'LinkFixture', source: 'linkfixture', _skipPluginOps: true })).task;
    const description = 'The request this task starts its work from, several paragraphs long.';
    const child = (await addTask({ title: 'Worker', project: 'LinkFixture', source: 'linkfixture', description, _skipPluginOps: true })).task;
    await updateTaskRaw(child.id, { parent_task_id: lead.id, ext: { linkfixture: { id: 'remote-child' } } });

    // The first pull of a new task: the remote body had no description and an 8-char parent.
    control.patches.push({ id: child.id, updates: { title: 'Worker', description: '', parent_task_id: lead.id.slice(0, 8) } });
    await until('the pull to run', async () => control.patches.length === 0 && control.polls > 1);
    const after = await getTask(child.id);
    expect(after.description).toBe(description);
    expect(after.parent_task_id).toBe(lead.id);

    // A row an older pull already wrote with a prefix: the next tick repairs it.
    const old = (await addTask({ title: 'Older worker', project: 'LinkFixture', source: 'linkfixture', _skipPluginOps: true })).task;
    await updateTaskRaw(old.id, { parent_task_id: lead.id.slice(0, 8) });
    await until('the repair', async () => (await getTask(old.id)).parent_task_id === lead.id);

    // A real remote edit still lands.
    control.patches.push({ id: child.id, updates: { description: 'Edited in the remote app.' } });
    await until('the edit', async () => (await getTask(child.id)).description === 'Edited in the remote app.');
  }, 60_000);
});
