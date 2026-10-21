import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../../src/core/types.js';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-pulled-tags'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, getTask, updateTaskRaw, settleBackgroundPushes } from '../../src/core/task-manager.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const control = {
  id: '',
  entered: deferred<void>(),
  release: deferred<void>(),
  done: deferred<Task>(),
  incoming: ['urgent'],
  active: false,
};
const key = '__walnutPulledTagsFixture';
const globals = globalThis as unknown as Record<string, unknown>;
const savedEnv = new Map<string, string | undefined>();
let port = 0;

beforeAll(async () => {
  for (const [key, value] of Object.entries({ WALNUT_SYNC_FIRST_TICK_MS: '200', WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1' })) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  globals[key] = control;
  await fs.mkdir(path.join(WALNUT_HOME, 'plugins/tagfixture'), { recursive: true });
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), JSON.stringify({ plugins: { tagfixture: { enabled: true, sync_interval_ms: 100 } } }));
  await fs.writeFile(path.join(WALNUT_HOME, 'plugins/tagfixture/manifest.json'), JSON.stringify({
    id: 'tagfixture', name: 'Tag fixture', version: '1.0.0', external: true,
  }));
  await fs.writeFile(path.join(WALNUT_HOME, 'plugins/tagfixture/index.mjs'), `
const noop = async () => {};
export default function register(api) {
  api.registerExtIndex({ source: 'tagfixture', paths: [{ key: 'id', json: '$."tagfixture".id', unique: true }] });
  api.registerSync({
    createTask: async () => null, deleteTask: noop,
    updateTitle: noop, updateDescription: noop, updateSummary: noop, updateNote: noop,
    updateConversationLog: noop, updatePriority: noop, updatePhase: noop, updateDueDate: noop,
    updateProject: noop, updateDependencies: noop, associateSubtask: noop, disassociateSubtask: noop,
    pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
    mergePulledTags(current, incoming) {
      return [...incoming, ...(current.tags ?? []).filter(tag => tag.startsWith('pr:'))];
    },
    async syncPoll(ctx) {
      const c = globalThis.${key};
      if (!c.active) return;
      c.active = false;
      const before = ctx.getTasks().find(task => task.id === c.id);
      if (!before) throw new Error('Fixture task missing');
      c.entered.resolve();
      await c.release.promise;
      const saved = await ctx.updateTask(c.id, { tags: c.incoming });
      const cached = ctx.getTasks().find(task => task.id === c.id);
      if (JSON.stringify(saved.tags) !== JSON.stringify(cached.tags)) throw new Error('Poll cache differs from saved row');
      c.done.resolve(saved);
    },
  });
}
`);
  const server = await startServer({ port: 0, dev: true });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address missing');
  port = address.port;
}, 90_000);

afterAll(async () => {
  control.release.resolve();
  bus.unsubscribe('pulled-tags-test');
  await stopServer();
  delete globals[key];
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('plugin delta pulls', () => {
  it('returns and publishes the current tag merge, not the pre-pull snapshot', async () => {
    const oldLink = 'pr:https://github.com/acme/app/pull/1';
    const newLink = 'pr:https://github.com/acme/app/pull/2';
    const { task } = await addTask({ title: 'Pull race', project: 'TagFixture', source: 'tagfixture', tags: [oldLink], _skipPluginOps: true });
    control.id = task.id;
    await updateTaskRaw(task.id, { ext: { tagfixture: { id: 'remote-1' } } });
    for (const tags of [[newLink], []]) {
      control.entered = deferred<void>();
      control.release = deferred<void>();
      control.done = deferred<Task>();
      const published = deferred<Task>();
      bus.subscribe('pulled-tags-test', event => {
        const task = (event.data as { task?: Task }).task;
        if (event.name === EventNames.TASK_UPDATED && event.source === 'tagfixture-sync' && task?.id === control.id) published.resolve(task);
      }, { global: true, interest: [EventNames.TASK_UPDATED] });
      control.active = true;
      await control.entered.promise;
      const edit = await fetch(`http://localhost:${port}/api/tasks/${task.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set_tags: tags }),
      });
      expect(edit.status).toBe(200);
      await settleBackgroundPushes();
      control.release.resolve();
      const saved = await control.done.promise;
      expect(saved.tags).toEqual(['label:urgent', ...tags]);
      expect((await published.promise).tags).toEqual(saved.tags);
      bus.unsubscribe('pulled-tags-test');
      expect((await getTask(task.id)).tags).toEqual(saved.tags);
      const read = await fetch(`http://localhost:${port}/api/tasks/${task.id}`);
      expect(read.status).toBe(200);
      expect(((await read.json()) as { task: Task }).task.tags).toEqual(saved.tags);
    }
  }, 30_000);
});
