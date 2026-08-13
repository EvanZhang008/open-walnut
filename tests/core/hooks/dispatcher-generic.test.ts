/**
 * Unit tests for the generalized (domain-agnostic) hook dispatcher.
 *
 * Covers what the legacy session-hooks tests don't: task-domain routing,
 * the O(1) domain gate, generic filter dimensions (phases/fromPhases/
 * sources/requiresSession), the hook:<id> re-entrancy guard, reload()
 * without resubscribe, and the literal bus interest set.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { SessionHookDispatcher } from '../../../src/core/session-hooks/dispatcher.js';
import type { SessionHookDefinition } from '../../../src/core/session-hooks/types.js';
import { makeTask } from '../../helpers/factories.js';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function makeHook(overrides: Partial<SessionHookDefinition> = {}): SessionHookDefinition {
  return {
    id: `test-hook-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Hook',
    hooks: ['onTaskPhaseChanged'],
    handler: vi.fn(),
    source: 'builtin',
    enabled: true,
    ...overrides,
  };
}

function emitPhaseChanged(overrides: Record<string, unknown> = {}, source = 'api'): void {
  const task = makeTask({ phase: 'HUMAN_VERIFIED', session_id: 'sess-1' });
  bus.emit(EventNames.TASK_PHASE_CHANGED, {
    task,
    oldPhase: 'AGENT_COMPLETE',
    newPhase: 'HUMAN_VERIFIED',
    source,
    sessionId: 'sess-1',
    ...overrides,
  }, ['web-ui'], { source });
}

describe('HookDispatcher task domain', () => {
  let dispatcher: SessionHookDispatcher;

  beforeEach(() => {
    dispatcher = new SessionHookDispatcher();
  });

  afterEach(() => {
    dispatcher.destroy();
    bus.unsubscribe('session-hooks');
  });

  it('routes task:phase-changed to onTaskPhaseChanged with old/new phase', async () => {
    const handler = vi.fn();
    dispatcher.init([makeHook({ handler })]);

    emitPhaseChanged();
    await tick();

    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0][0];
    expect(payload.domain).toBe('task');
    expect(payload.oldPhase).toBe('AGENT_COMPLETE');
    expect(payload.newPhase).toBe('HUMAN_VERIFIED');
    expect(payload.taskId).toBe('test-1234');
    expect(payload.task.title).toBe('Test task');
  });

  it('routes task:created / task:completed / task:updated to their points', async () => {
    const created = vi.fn(); const completed = vi.fn(); const updated = vi.fn();
    dispatcher.init([
      makeHook({ hooks: ['onTaskCreated'], handler: created }),
      makeHook({ hooks: ['onTaskCompleted'], handler: completed }),
      makeHook({ hooks: ['onTaskUpdated'], handler: updated }),
    ]);

    const task = makeTask();
    bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'api' });
    bus.emit(EventNames.TASK_COMPLETED, { task }, ['web-ui'], { source: 'api' });
    bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'api' });
    await tick();

    expect(created).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it('bulk task:updated (task: null) fires nothing', async () => {
    const handler = vi.fn();
    dispatcher.init([makeHook({ hooks: ['onTaskUpdated'], handler })]);

    bus.emit(EventNames.TASK_UPDATED, { task: null, taskIds: ['a', 'b'], count: 2 }, ['web-ui'], { source: 'api' });
    await tick();

    expect(handler).not.toHaveBeenCalled();
  });

  it('drops task events whose source starts with hook: (re-entrancy guard)', async () => {
    const handler = vi.fn();
    dispatcher.init([makeHook({ handler })]);

    emitPhaseChanged({}, 'hook:some-other-hook');
    await tick();

    expect(handler).not.toHaveBeenCalled();
  });

  it('excluded task events (starred/deleted/reordered) never reach handlers', async () => {
    const handler = vi.fn();
    dispatcher.init([
      makeHook({ hooks: ['onTaskCreated', 'onTaskUpdated', 'onTaskCompleted', 'onTaskPhaseChanged'], handler }),
    ]);

    const task = makeTask();
    bus.emit(EventNames.TASK_STARRED, { task, starred: true }, ['web-ui'], { source: 'api' });
    bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'api' });
    bus.emit(EventNames.TASK_REORDERED, { project: 'p', taskIds: [] }, ['web-ui'], { source: 'api' });
    await tick();

    expect(handler).not.toHaveBeenCalled();
  });

  it('task enrichment is zero-IO — no payloadBuilder.build call', async () => {
    const handler = vi.fn();
    dispatcher.init([makeHook({ handler })]);
    const buildSpy = vi.spyOn(dispatcher['payloadBuilder'], 'build');

    emitPhaseChanged();
    await tick();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('domain gate: session-only hook set never enters task handling', async () => {
    const sessionHandler = vi.fn();
    dispatcher.init([makeHook({ hooks: ['onTurnComplete'], handler: sessionHandler })]);
    const buildSpy = vi.spyOn(dispatcher['payloadBuilder'], 'build');

    emitPhaseChanged();
    await tick();

    expect(sessionHandler).not.toHaveBeenCalled();
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('enabledDomains gate (cloud mode) drops task events entirely', async () => {
    const handler = vi.fn();
    dispatcher.init([makeHook({ handler })], undefined, { domains: ['session'] });

    emitPhaseChanged();
    await tick();

    expect(handler).not.toHaveBeenCalled();
  });

  describe('generic filter dimensions', () => {
    it('phases allows matching new phase, denies others', async () => {
      const match = vi.fn(); const noMatch = vi.fn();
      dispatcher.init([
        makeHook({ handler: match, filter: { phases: ['HUMAN_VERIFIED'] } }),
        makeHook({ handler: noMatch, filter: { phases: ['COMPLETE'] } }),
      ]);

      emitPhaseChanged();
      await tick();

      expect(match).toHaveBeenCalledTimes(1);
      expect(noMatch).not.toHaveBeenCalled();
    });

    it('fromPhases denies when oldPhase not in list', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ handler, filter: { fromPhases: ['TODO'] } })]);

      emitPhaseChanged(); // oldPhase AGENT_COMPLETE
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('sources allowlist: api passes, agent denied', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ handler, filter: { sources: ['api', 'user'] } })]);

      emitPhaseChanged({}, 'agent');
      await tick();
      expect(handler).not.toHaveBeenCalled();

      emitPhaseChanged({}, 'api');
      await tick();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('requiresSession denies a task with no session', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ handler, filter: { requiresSession: true } })]);

      const task = makeTask({ session_id: undefined });
      bus.emit(EventNames.TASK_PHASE_CHANGED, {
        task, oldPhase: 'TODO', newPhase: 'HUMAN_VERIFIED', source: 'api',
      }, ['web-ui'], { source: 'api' });
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('strict-deny: sources filter with missing event source denies', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ handler, filter: { sources: ['api'] } })]);

      const task = makeTask();
      bus.emit(EventNames.TASK_PHASE_CHANGED, {
        task, oldPhase: 'TODO', newPhase: 'IN_PROGRESS', source: 'api',
      }, ['web-ui']); // no bus-level source
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('reload()', () => {
    it('swaps hook set without resubscribing', async () => {
      const first = vi.fn(); const second = vi.fn();
      dispatcher.init([makeHook({ id: 'first', handler: first })]);
      expect(bus.has('session-hooks')).toBe(true);

      dispatcher.reload([makeHook({ id: 'second', handler: second })]);
      expect(bus.has('session-hooks')).toBe(true);

      emitPhaseChanged();
      await tick();

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('reload applies config overrides (disable)', async () => {
      const handler = vi.fn();
      const def = makeHook({ id: 'toggleable', handler });
      dispatcher.init([def]);

      dispatcher.reload([def], { overrides: { toggleable: { enabled: false } } });

      emitPhaseChanged();
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  it('declarative action hooks execute via executeHookAction', async () => {
    // A config-style hook with action (no handler) — use 'log' to avoid IO.
    dispatcher.init([makeHook({
      id: 'action-hook',
      handler: undefined,
      action: { type: 'log', message: 'phase {{newPhase}}' },
    })]);

    emitPhaseChanged();
    await tick();
    await tick(); // action executes behind a dynamic import — one extra tick

    // No throw + still subscribed is the observable behavior; the action module
    // has its own unit tests. This locks that action-only hooks don't crash
    // the dispatch loop.
    expect(bus.has('session-hooks')).toBe(true);
  });
});
