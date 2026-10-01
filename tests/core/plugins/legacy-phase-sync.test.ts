/**
 * Phase projection for sync plugins built before WAITING existed
 * (src/core/plugins/legacy-phase-sync.ts).
 *
 * A plugin compiled against the older `TaskPhase` maps the phase set exhaustively
 * (`Record<TaskPhase, RemoteStep>`, `TASK_PHASE_GROUPS[step].includes(phase)`). Handed a
 * WAITING task as is, it pushes no step and, on its next pull, maps the remote step
 * back onto TODO or IN_PROGRESS: the wait ends behind the user's back. So a plugin
 * whose manifest does not declare the phase receives task copies with WAITING folded
 * onto TODO on every call that hands it a task, while a plugin that declares it gets
 * the real phase.
 *
 * Would these fail on reverted code? YES: without the wrapper the fake old plugin
 * below records `phase: 'WAITING'`, finds no remote step for it, and its pull writes
 * TODO back.
 */
import { describe, it, expect } from 'vitest';
import { legacyTaskView, manifestKnowsHeldPhases, registeredSyncOf, wrapSyncForLegacyPhases } from '../../../src/core/plugins/legacy-phase-sync.js';
import type { IntegrationSync, SyncPollContext } from '../../../src/core/integration-types.js';
import type { Task } from '../../../src/core/types.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', title: 'Parked on a review', status: 'todo', phase: 'WAITING', priority: 'none', source: 'old-plugin',
    project: 'p', description: '', summary: '', wait_until: '2026-10-06T10:00:00.000Z',
    created_at: '2026-09-30T00:00:00.000Z', updated_at: '2026-09-30T00:00:00.000Z',
    ...over,
  } as Task;
}

/** What a plugin compiled against the old 4-phase set looks like: an exhaustive map with a null fallback. */
function oldPlugin() {
  const OLD_STEPS: Record<string, string> = { TODO: 'Open', IN_PROGRESS: 'Doing', NEED_ACTION: 'Doing', COMPLETE: 'Closed' };
  const seen: Array<{ method: string; phase: string; step: string | null }> = [];
  const record = (method: string, t: Task) => seen.push({ method, phase: t.phase, step: OLD_STEPS[t.phase] ?? null });
  const sync: IntegrationSync = {
    createTask: async (t) => { record('createTask', t); return null; },
    deleteTask: async (t) => { record('deleteTask', t); },
    updateTitle: async (t) => { record('updateTitle', t); },
    updateDescription: async (t) => { record('updateDescription', t); },
    updateSummary: async (t) => { record('updateSummary', t); },
    updateNote: async (t) => { record('updateNote', t); },
    updateConversationLog: async (t) => { record('updateConversationLog', t); },
    updatePriority: async (t) => { record('updatePriority', t); },
    updatePhase: async (t, phase) => { seen.push({ method: 'updatePhase', phase, step: OLD_STEPS[phase] ?? null }); record('updatePhase.task', t); },
    updateDueDate: async (t) => { record('updateDueDate', t); },
    updateProject: async (t) => { record('updateProject', t); },
    updateDependencies: async (t) => { record('updateDependencies', t); },
    associateSubtask: async (p, c) => { record('associateSubtask.parent', p); record('associateSubtask.child', c); },
    disassociateSubtask: async (p, c) => { record('disassociateSubtask.parent', p); record('disassociateSubtask.child', c); },
    pushTask: async (t) => { record('pushTask', t); return { serverTimestamp: 'now' }; },
    validateContent: (t) => { record('validateContent', t); return null; },
    prepareNewTask: (t) => { record('prepareNewTask', t); return undefined; },
    syncPoll: async (ctx) => { for (const t of ctx.getTasks()) record('syncPoll.getTasks', t); },
  };
  return { sync, seen };
}

describe('manifestKnowsHeldPhases', () => {
  it('is true only when every held phase is declared', () => {
    expect(manifestKnowsHeldPhases({})).toBe(false);
    expect(manifestKnowsHeldPhases({ phases: [] })).toBe(false);
    expect(manifestKnowsHeldPhases({ phases: ['SOMETHING_ELSE'] })).toBe(false);
    expect(manifestKnowsHeldPhases({ phases: ['WAITING'] })).toBe(true);
    expect(manifestKnowsHeldPhases({ phases: 'WAITING' })).toBe(false);
  });
});

describe('legacyTaskView', () => {
  it('folds WAITING onto TODO (status todo, no wait_until) and leaves every other phase as the same object', () => {
    const waiting = task();
    const view = legacyTaskView(waiting);
    expect(view).not.toBe(waiting);
    expect(view).toMatchObject({ phase: 'TODO', status: 'todo' });
    expect(view.wait_until).toBeUndefined();
    expect(waiting.phase).toBe('WAITING'); // the original is untouched
    for (const phase of ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] as const) {
      const t = task({ phase });
      expect(legacyTaskView(t)).toBe(t);
    }
  });
});

describe('wrapSyncForLegacyPhases', () => {
  it('hands the old plugin TODO on every push-side call, so its exhaustive map still finds a step', async () => {
    const { sync, seen } = oldPlugin();
    const wrapped = wrapSyncForLegacyPhases(sync);
    const t = task();
    await wrapped.createTask(t);
    await wrapped.pushTask(t);
    await wrapped.updateTitle(t, 'x');
    await wrapped.updatePhase(t, 'WAITING');
    await wrapped.associateSubtask(t, task({ id: 'child', phase: 'WAITING' }));
    wrapped.validateContent!(t, 'title', 'x');
    await wrapped.prepareNewTask!(t, { reason: 'created' });
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.phase, call.method).toBe('TODO');
      expect(call.step, call.method).toBe('Open');
    }
  });

  it('projects the poll snapshot too, so the pull compares against TODO rather than an unknown phase', async () => {
    const { sync, seen } = oldPlugin();
    const wrapped = wrapSyncForLegacyPhases(sync);
    const writes: Array<Partial<Task>> = [];
    const ctx: SyncPollContext = {
      getTasks: () => [task(), task({ id: 't2', phase: 'IN_PROGRESS', status: 'in_progress', wait_until: undefined })],
      updateTask: async (_id, updates) => { writes.push(updates); return task(updates); },
      addTask: async (data) => task(data as Partial<Task>),
      deleteTask: async () => {},
      emit: () => {},
    };
    await wrapped.syncPoll(ctx);
    expect(seen.map((s) => s.phase)).toEqual(['TODO', 'IN_PROGRESS']);
    expect(writes).toEqual([]);
  });

  it('passes a plugin that declares the phase the real task (no wrapper is applied by the loader)', async () => {
    // The loader's decision is `manifestKnowsHeldPhases(manifest) ? sync : wrapSyncForLegacyPhases(sync)`;
    // this pins the unwrapped half: the raw sync sees WAITING as WAITING.
    const { sync, seen } = oldPlugin();
    await sync.pushTask(task());
    expect(seen).toEqual([{ method: 'pushTask', phase: 'WAITING', step: null }]);
  });

  it('still answers to the sync the plugin registered (a registration dispose compares identities)', () => {
    // server-api.ts: `registry.sync(adapter)` returns a disposable that clears the
    // loader's slot when it still holds THAT adapter. The slot holds the wrapper, so
    // the check goes through registeredSyncOf; without it a disposed sync stayed live.
    const { sync } = oldPlugin();
    const wrapped = wrapSyncForLegacyPhases(sync);
    expect(wrapped).not.toBe(sync);
    expect(registeredSyncOf(wrapped)).toBe(sync);
    expect(registeredSyncOf(sync)).toBe(sync);
    expect(registeredSyncOf(null)).toBeNull();
  });

  it('keeps optional methods optional and passes unknown extras through', () => {
    const { sync } = oldPlugin();
    const bare: IntegrationSync = { ...sync };
    delete bare.validateContent;
    delete bare.prepareNewTask;
    delete bare.contentRequirement;
    (bare as unknown as Record<string, unknown>).renameProject = async () => 'renamed';
    const wrapped = wrapSyncForLegacyPhases(bare);
    expect(wrapped.validateContent).toBeUndefined();
    expect(wrapped.prepareNewTask).toBeUndefined();
    expect(typeof (wrapped as unknown as Record<string, unknown>).renameProject).toBe('function');
  });
});
