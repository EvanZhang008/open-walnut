/**
 * Ratchet for the sync guard (src/core/private-tasks/sync-guard.ts): every IntegrationSync method
 * that takes a task, read from the interface's source, is either checked before it runs or listed
 * as sending nothing, with why. A new plugin method that carries a task fails here until it is
 * placed, so a local task can never reach a plugin through a path the guard does not know.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { guardSync, TASK_ARG_METHODS, TASK_LIST_METHODS, LOCAL_ONLY_TASK_METHODS, isPrivateTaskBlocked, setSyncGuardHooksForTest } from '../../../src/core/private-tasks/sync-guard.js';
import type { IntegrationSync } from '../../../src/core/integration-types.js';
import type { Task } from '../../../src/core/types.js';

function interfaceBody(): string {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/core/integration-types.ts'), 'utf8');
  const start = src.indexOf('export interface IntegrationSync');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i);
  }
  throw new Error('IntegrationSync body not found');
}

describe('sync guard ratchet', () => {
  it('every IntegrationSync method that takes a task is guarded or listed as sending nothing', () => {
    const methods = [...interfaceBody().matchAll(/^\s+(\w+)\??\(([^)]*)\)/gm)];
    expect(methods.length).toBeGreaterThan(15);
    const taking = methods.filter(([, , params]) => /:\s*(Readonly<)?Task\b/.test(params)).map(([, name]) => name);
    expect(taking).toContain('createTask');
    const unplaced = taking.filter((m) => !TASK_ARG_METHODS.has(m) && !TASK_LIST_METHODS.has(m) && !(m in LOCAL_ONLY_TASK_METHODS));
    expect(unplaced, `place these in TASK_ARG_METHODS, TASK_LIST_METHODS or LOCAL_ONLY_TASK_METHODS: ${unplaced.join(', ')}`).toEqual([]);
    // Listed names still exist (a renamed method must not leave a dead entry behind).
    const all = new Set(methods.map(([, name]) => name));
    for (const m of [...TASK_ARG_METHODS, ...TASK_LIST_METHODS, ...Object.keys(LOCAL_ONLY_TASK_METHODS)]) expect(all.has(m), m).toBe(true);
  });

  it('refuses every guarded method for a local task and leaves kept tasks out of a project deletion', async () => {
    setSyncGuardHooksForTest({ readWords: async () => [], onStop: () => {}, modelCheck: false });
    const calls: string[] = [];
    const raw = new Proxy({}, { get: (_t, prop) => typeof prop === 'symbol' ? undefined : async (...args: unknown[]) => { calls.push(String(prop)); return args; } }) as IntegrationSync;
    const guarded = guardSync('svc', raw);
    const local = { id: 't-local', source: 'local', title: 'x' } as Task;
    const synced = { id: 't-sync', source: 'svc', title: 'y' } as Task;
    for (const m of TASK_ARG_METHODS) {
      const err = await (guarded as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m](local, local).catch((e: unknown) => e);
      expect(isPrivateTaskBlocked(err), m).toBe(true);
    }
    expect(calls).toEqual([]);
    const out = await guarded.deleteProjectRemote!({ project: 'P', tasks: [local, synced, { ...synced, id: 't-held', sync_hold: { target: 'svc', state: 'chosen', at: '' } }] });
    expect((out as unknown as [{ tasks: Task[] }])[0].tasks.map((t) => t.id)).toEqual(['t-sync']);
    setSyncGuardHooksForTest(null);
  });
});

describe('registering a guarded plugin', () => {
  it('a frozen plugin record is guarded through a copy, a plain one keeps its identity', async () => {
    const { registry } = await import('../../../src/core/integration-registry.js');
    const { createSpySync, createMockPlugin } = await import('../plugin-test-utils.js');
    const plain = createMockPlugin({ id: 'guard-plain', sync: createSpySync() });
    const frozen = Object.freeze(createMockPlugin({ id: 'guard-frozen', sync: createSpySync() }));
    registry.register('guard-plain', plain);
    registry.register('guard-frozen', frozen);
    try {
      expect(registry.get('guard-plain')).toBe(plain);
      expect(registry.get('guard-plain')!.sync).toBe(registry.get('guard-plain')!.sync);
      const local = { id: 't', source: 'local', title: 'x' } as Task;
      for (const id of ['guard-plain', 'guard-frozen']) {
        const err = await registry.get(id)!.sync.createTask(local).catch((e: unknown) => e);
        expect(isPrivateTaskBlocked(err), id).toBe(true);
      }
    } finally {
      registry.unregister('guard-plain');
      registry.unregister('guard-frozen');
    }
  });
});

describe('a loaded plugin record (live getters)', () => {
  it('keeps its identity and its live sync getter, and is guarded', async () => {
    const { registry } = await import('../../../src/core/integration-registry.js');
    const { createSpySync, createMockPlugin } = await import('../plugin-test-utils.js');
    const collected: { sync?: IntegrationSync } = {};
    const base = createMockPlugin({ id: 'guard-live' });
    const record = { ...base, get sync() { return collected.sync ?? base.sync; }, get hasSync() { return !!collected.sync; } };
    registry.register('guard-live', record as never);
    setSyncGuardHooksForTest({ readWords: async () => [], modelCheck: false });
    try {
      expect(registry.get('guard-live')).toBe(record);
      const late = createSpySync();
      collected.sync = late; // registered after activate: the getter must follow
      expect(registry.get('guard-live')!.hasSync).toBe(true);
      const err = await registry.get('guard-live')!.sync.createTask({ id: 't', source: 'local', title: 'x' } as Task).catch((e: unknown) => e);
      expect(isPrivateTaskBlocked(err)).toBe(true);
      await registry.get('guard-live')!.sync.createTask({ id: 't2', source: 'guard-live', title: 'ok' } as Task);
      expect(late.createTask).toHaveBeenCalledTimes(1);
    } finally {
      setSyncGuardHooksForTest(null);
      registry.unregister('guard-live');
    }
  });
});
