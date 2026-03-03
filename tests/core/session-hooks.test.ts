/**
 * Unit tests for the Session Hooks system.
 *
 * Tests the dispatcher (event→hook mapping, filtering, priority, timeout,
 * dedup, lifecycle), PayloadBuilder caching, and subagent event filtering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { SessionHookDispatcher } from '../../src/core/session-hooks/dispatcher.js';
import type { SessionHookDefinition, SessionHookContext } from '../../src/core/session-hooks/types.js';
import { makeTask, makeSession } from '../helpers/factories.js';

// ── Helpers ──

/**
 * Wait for the async handleEvent chain to drain.
 * The handler is an async function called from a sync bus subscriber,
 * so we need to flush the microtask queue. A single tick (setTimeout 0)
 * is sufficient when the PayloadBuilder is mocked (no real dynamic imports).
 */
const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** Default mock context returned by the PayloadBuilder stub. */
function defaultContext(sessionId = 's1'): SessionHookContext {
  return {
    sessionId,
    taskId: undefined,
    task: undefined,
    session: undefined,
    timestamp: new Date().toISOString(),
    traceId: 'test-trace',
  };
}

/** Create a minimal test hook definition. */
function makeHook(overrides: Partial<SessionHookDefinition> = {}): SessionHookDefinition {
  return {
    id: `test-hook-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Hook',
    hooks: ['onTurnComplete'],
    handler: vi.fn(),
    source: 'builtin',
    enabled: true,
    ...overrides,
  };
}

// ── Test suite ──

describe('SessionHookDispatcher', () => {
  let dispatcher: SessionHookDispatcher;

  beforeEach(() => {
    dispatcher = new SessionHookDispatcher();
    // Mock the PayloadBuilder for all dispatcher tests so that
    // handleEvent's async chain resolves immediately (no dynamic imports).
    vi.spyOn(dispatcher['payloadBuilder'], 'build').mockImplementation(
      async (sessionId: string, taskId: string | undefined, traceId: string) => ({
        sessionId,
        taskId,
        task: undefined,
        session: undefined,
        timestamp: new Date().toISOString(),
        traceId,
      }),
    );
    vi.spyOn(dispatcher['payloadBuilder'], 'clearSession').mockImplementation(() => {});
  });

  afterEach(() => {
    dispatcher.destroy();
    // Safety: ensure bus subscriber is cleaned up even if destroy() was already called
    bus.unsubscribe('session-hooks');
  });

  // ────────────────────────────────────────────
  // 1. Event → Hook Point Mapping
  // ────────────────────────────────────────────

  describe('Event → Hook Point Mapping', () => {
    it('session:started → onSessionStart', async () => {
      const handler = vi.fn();
      const hook = makeHook({ hooks: ['onSessionStart'], handler });
      dispatcher.init([hook]);

      bus.emit(EventNames.SESSION_STARTED, {
        sessionId: 's1', mode: 'bypass', host: 'localhost', project: 'walnut',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.sessionId).toBe('s1');
      expect(payload.mode).toBe('bypass');
      expect(payload.host).toBe('localhost');
      expect(payload.project).toBe('walnut');
    });

    it('session:send → onMessageSend', async () => {
      const handler = vi.fn();
      const hook = makeHook({ hooks: ['onMessageSend'], handler });
      dispatcher.init([hook]);

      bus.emit(EventNames.SESSION_SEND, {
        sessionId: 's1', message: 'hello', taskId: 'task-1',
      }, ['*'], { source: 'web-ui' });

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.message).toBe('hello');
    });

    it('session:text-delta triggers onTurnStart on first delta after send', async () => {
      const turnStartHandler = vi.fn();
      const hook = makeHook({ hooks: ['onTurnStart'], handler: turnStartHandler });
      dispatcher.init([hook]);

      // First: send a message to set awaitingFirstResponse = true
      bus.emit(EventNames.SESSION_SEND, {
        sessionId: 's1', message: 'go',
      }, ['*']);
      await tick();

      // Now text-delta should trigger onTurnStart
      bus.emit(EventNames.SESSION_TEXT_DELTA, {
        sessionId: 's1', text: 'thinking...',
      }, ['*']);
      await tick();

      expect(turnStartHandler).toHaveBeenCalledTimes(1);
      expect(turnStartHandler.mock.calls[0][0].turnIndex).toBe(1);

      // Second text-delta should NOT trigger onTurnStart again
      turnStartHandler.mockClear();
      bus.emit(EventNames.SESSION_TEXT_DELTA, {
        sessionId: 's1', text: 'more text',
      }, ['*']);
      await tick();

      expect(turnStartHandler).not.toHaveBeenCalled();
    });

    it('session:result → onTurnComplete (non-error)', async () => {
      const handler = vi.fn();
      const hook = makeHook({ hooks: ['onTurnComplete'], handler });
      dispatcher.init([hook]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done', totalCost: 0.05, duration: 1234,
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.result).toBe('done');
      expect(payload.totalCost).toBe(0.05);
      expect(payload.duration).toBe(1234);
    });

    it('session:result with isError → onTurnError', async () => {
      const turnCompleteHandler = vi.fn();
      const turnErrorHandler = vi.fn();
      dispatcher.init([
        makeHook({ hooks: ['onTurnComplete'], handler: turnCompleteHandler }),
        makeHook({ hooks: ['onTurnError'], handler: turnErrorHandler }),
      ]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'something failed', isError: true,
      }, ['*']);

      await tick();

      expect(turnCompleteHandler).not.toHaveBeenCalled();
      expect(turnErrorHandler).toHaveBeenCalledTimes(1);
      expect(turnErrorHandler.mock.calls[0][0].error).toBe('something failed');
      expect(turnErrorHandler.mock.calls[0][0].isSessionError).toBe(false);
    });

    it('session:error → onTurnError with isSessionError=true', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnError'], handler })]);

      bus.emit(EventNames.SESSION_ERROR, {
        sessionId: 's1', error: 'process crashed',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.error).toBe('process crashed');
      expect(payload.isSessionError).toBe(true);
    });

    it('session:ended → onSessionEnd', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onSessionEnd'], handler })]);

      bus.emit(EventNames.SESSION_ENDED, {
        sessionId: 's1',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].sessionId).toBe('s1');
    });

    it('non-session events are ignored', async () => {
      const handler = vi.fn();
      dispatcher.init([
        makeHook({ hooks: ['onSessionStart', 'onTurnComplete', 'onSessionEnd'], handler }),
      ]);

      bus.emit(EventNames.TASK_CREATED, { id: 't1' }, ['*']);
      bus.emit(EventNames.TASK_UPDATED, { id: 't2' }, ['*']);
      bus.emit(EventNames.AGENT_TEXT_DELTA, { text: 'hi' }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('session:tool-use → onToolUse', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onToolUse'], handler })]);

      bus.emit(EventNames.SESSION_TOOL_USE, {
        sessionId: 's1', toolName: 'read_file', toolUseId: 'tu-1', input: { path: '/foo' },
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.toolName).toBe('read_file');
      expect(payload.toolUseId).toBe('tu-1');
    });

    it('session:tool-result → onToolResult', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onToolResult'], handler })]);

      bus.emit(EventNames.SESSION_TOOL_RESULT, {
        sessionId: 's1', toolUseId: 'tu-1', result: 'file contents',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].result).toBe('file contents');
    });

    it('session:tool-use with ExitPlanMode → onPlanComplete', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onPlanComplete'], handler })]);

      bus.emit(EventNames.SESSION_TOOL_USE, {
        sessionId: 's1', toolName: 'ExitPlanMode', toolUseId: 'tu-2',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('turnIndex increments across multiple send→response cycles', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnStart'], handler })]);

      // First turn
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'turn 1' }, ['*']);
      await tick();
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: 's1', text: 'resp 1' }, ['*']);
      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].turnIndex).toBe(1);

      // Second turn
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'turn 2' }, ['*']);
      await tick();
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: 's1', text: 'resp 2' }, ['*']);
      await tick();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1][0].turnIndex).toBe(2);
    });

    it('session:send sets isResume=false on first send', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onMessageSend'], handler })]);

      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'first' }, ['*'], { source: 'web-ui' });
      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].isResume).toBe(false);
    });

    it('session:send sets isResume=true after first turn', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onMessageSend'], handler })]);

      // First send (source: 'web-ui' to trigger onMessageSend)
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'first' }, ['*'], { source: 'web-ui' });
      await tick();
      // Simulate response to complete the first turn
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: 's1', text: 'resp' }, ['*']);
      await tick();
      bus.emit(EventNames.SESSION_RESULT, { sessionId: 's1', result: 'done' }, ['*']);
      await tick();

      // Second send — should be a resume
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'follow up' }, ['*'], { source: 'web-ui' });
      await tick();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1][0].isResume).toBe(true);
    });

    it('session:send with source=agent does NOT trigger onMessageSend', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onMessageSend'], handler })]);

      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'triage continue' }, ['*'], { source: 'agent' });
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('session:send with source=agent still sets awaitingFirstResponse', async () => {
      const turnStartHandler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnStart'], handler: turnStartHandler })]);

      // Agent-source send: no onMessageSend, but should still track state
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'continue' }, ['*'], { source: 'agent' });
      await tick();

      // Text delta should trigger onTurnStart (proves awaitingFirstResponse was set)
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: 's1', text: 'working...' }, ['*']);
      await tick();

      expect(turnStartHandler).toHaveBeenCalledTimes(1);
    });

    it('session:tool-use triggers onTurnStart if awaiting first response', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnStart'], handler })]);

      // Send to set awaitingFirstResponse
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'go' }, ['*']);
      await tick();

      // Tool use instead of text-delta should also trigger onTurnStart
      bus.emit(EventNames.SESSION_TOOL_USE, {
        sessionId: 's1', toolName: 'read_file', toolUseId: 'tu-1',
      }, ['*']);
      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].turnIndex).toBe(1);
    });

    it('session:result with isPlanSession reflects lastMode', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnComplete'], handler })]);

      // Start session with mode=plan
      bus.emit(EventNames.SESSION_STARTED, {
        sessionId: 's1', mode: 'plan',
      }, ['*']);
      await tick();

      // Result should show isPlanSession=true
      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'plan generated',
      }, ['*']);
      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].isPlanSession).toBe(true);
    });
  });

  // ────────────────────────────────────────────
  // 2. Filter Logic
  // ────────────────────────────────────────────

  describe('Filter Logic', () => {
    it('hook with modes filter fires for matching session mode', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { modes: ['plan'] },
      });
      dispatcher.init([hook]);

      // Override default mock to return plan-mode session context
      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: 'task-1',
        task: makeTask({ project: 'walnut', category: 'Work' }),
        session: makeSession({ claudeSessionId: 's1', mode: 'plan' }),
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'plan done',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('hook with modes filter does NOT fire for non-matching mode', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { modes: ['plan'] },
      });
      dispatcher.init([hook]);

      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: 'task-1',
        task: makeTask(),
        session: makeSession({ claudeSessionId: 's1', mode: 'bypass' }),
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('hook with projects filter fires when task.project matches', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { projects: ['walnut'] },
      });
      dispatcher.init([hook]);

      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: 'task-1',
        task: makeTask({ project: 'walnut' }),
        session: makeSession({ claudeSessionId: 's1' }),
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('hook with projects filter does NOT fire when project does not match', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { projects: ['walnut'] },
      });
      dispatcher.init([hook]);

      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: 'task-1',
        task: makeTask({ project: 'other-project' }),
        session: makeSession({ claudeSessionId: 's1' }),
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('hook with categories filter fires when task.category matches', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { categories: ['Work'] },
      });
      dispatcher.init([hook]);

      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: 'task-1',
        task: makeTask({ category: 'Work' }),
        session: makeSession({ claudeSessionId: 's1' }),
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('hook with categories filter does NOT fire when category does not match', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { categories: ['Work'] },
      });
      dispatcher.init([hook]);

      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: 'task-1',
        task: makeTask({ category: 'Life' }),
        session: makeSession({ claudeSessionId: 's1' }),
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('strict mode: filter specified but context missing → hook does NOT fire', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { modes: ['plan'] },
      });
      dispatcher.init([hook]);

      // No session in context → mode filter can't match
      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: undefined,
        task: undefined,
        session: undefined,
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('strict mode: projects filter but no task → hook does NOT fire', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        filter: { projects: ['walnut'] },
      });
      dispatcher.init([hook]);

      (dispatcher['payloadBuilder'].build as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessionId: 's1',
        taskId: undefined,
        task: undefined,
        session: makeSession({ claudeSessionId: 's1' }),
        timestamp: new Date().toISOString(),
        traceId: 'test-trace',
      });

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('hook with no filter fires for any session', async () => {
      const handler = vi.fn();
      const hook = makeHook({
        hooks: ['onTurnComplete'],
        handler,
        // no filter
      });
      dispatcher.init([hook]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────
  // 3. Subagent Event Filtering
  // ────────────────────────────────────────────

  describe('Subagent Event Filtering', () => {
    it('session:result with source=subagent-runner is skipped', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnComplete'], handler })]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'triage done',
      }, ['*'], { source: 'subagent-runner' });

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('session:error with source=subagent-runner is skipped', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnError'], handler })]);

      bus.emit(EventNames.SESSION_ERROR, {
        sessionId: 's1', error: 'subagent failed',
      }, ['*'], { source: 'subagent-runner' });

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('session:result without subagent source dispatches normally', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnComplete'], handler })]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*'], { source: 'session-runner' });

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('session:started with source=subagent-runner still dispatches (only result/error are guarded)', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onSessionStart'], handler })]);

      bus.emit(EventNames.SESSION_STARTED, {
        sessionId: 's1', mode: 'bypass',
      }, ['*'], { source: 'subagent-runner' });

      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────
  // 4. Timeout & Error Isolation
  // ────────────────────────────────────────────

  describe('Timeout & Error Isolation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('handler that throws → caught, other hooks still run', async () => {
      const throwingHandler = vi.fn().mockRejectedValue(new Error('kaboom'));
      const healthyHandler = vi.fn();

      dispatcher.init([
        makeHook({ id: 'throwing', hooks: ['onTurnComplete'], handler: throwingHandler, priority: 10 }),
        makeHook({ id: 'healthy', hooks: ['onTurnComplete'], handler: healthyHandler, priority: 20 }),
      ]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      // Drain microtasks (advanceTimersByTimeAsync also flushes microtask queue)
      await vi.advanceTimersByTimeAsync(0);

      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(healthyHandler).toHaveBeenCalledTimes(1);
    });

    it('handler that takes longer than timeout → gets killed, other hooks still run', async () => {
      const slowHandler = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 60_000)),
      );
      const fastHandler = vi.fn().mockResolvedValue(undefined);

      dispatcher.init([
        makeHook({
          id: 'slow',
          hooks: ['onTurnComplete'],
          handler: slowHandler,
          timeoutMs: 100,
          priority: 10,
        }),
        makeHook({
          id: 'fast',
          hooks: ['onTurnComplete'],
          handler: fastHandler,
          priority: 20,
        }),
      ]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      // Let the timeout fire
      await vi.advanceTimersByTimeAsync(200);

      expect(slowHandler).toHaveBeenCalledTimes(1);
      expect(fastHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────
  // 5. Priority Ordering
  // ────────────────────────────────────────────

  describe('Priority Ordering', () => {
    it('hooks execute in priority order (lower number = first)', async () => {
      const callOrder: string[] = [];

      const hookA = makeHook({
        id: 'hook-50',
        hooks: ['onTurnComplete'],
        priority: 50,
        handler: vi.fn(async () => { callOrder.push('50'); }),
      });
      const hookB = makeHook({
        id: 'hook-10',
        hooks: ['onTurnComplete'],
        priority: 10,
        handler: vi.fn(async () => { callOrder.push('10'); }),
      });
      const hookC = makeHook({
        id: 'hook-90',
        hooks: ['onTurnComplete'],
        priority: 90,
        handler: vi.fn(async () => { callOrder.push('90'); }),
      });

      // Pass in non-sorted order to verify sort happens
      dispatcher.init([hookA, hookB, hookC]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      // All three hooks should have been called
      expect(hookA.handler).toHaveBeenCalledTimes(1);
      expect(hookB.handler).toHaveBeenCalledTimes(1);
      expect(hookC.handler).toHaveBeenCalledTimes(1);

      // Promise.allSettled fires handlers in array order (priority-sorted).
      // Since all handlers resolve within the same microtask, the start order
      // (= array iteration order) determines the call order.
      expect(callOrder).toEqual(['10', '50', '90']);
    });

    it('addHook maintains sort order', () => {
      dispatcher.init([
        makeHook({ id: 'a', priority: 50, hooks: ['onTurnComplete'] }),
      ]);

      dispatcher.addHook(makeHook({ id: 'b', priority: 10, hooks: ['onTurnComplete'] }));
      dispatcher.addHook(makeHook({ id: 'c', priority: 90, hooks: ['onTurnComplete'] }));

      // Access private hooks array to verify sort order
      const hookIds = (dispatcher as any).hooks.map((h: SessionHookDefinition) => h.id);
      expect(hookIds).toEqual(['b', 'a', 'c']);
    });
  });

  // ────────────────────────────────────────────
  // 6. Hook Deduplication
  // ────────────────────────────────────────────

  describe('Hook Deduplication', () => {
    it('file hook overrides builtin hook with same ID (last wins)', async () => {
      const builtinHandler = vi.fn();
      const fileHandler = vi.fn();

      const builtinHook = makeHook({
        id: 'my-hook',
        hooks: ['onTurnComplete'],
        handler: builtinHandler,
        source: 'builtin',
      });
      const fileHook = makeHook({
        id: 'my-hook',
        hooks: ['onTurnComplete'],
        handler: fileHandler,
        source: 'file',
      });

      // Builtin first, then file — file wins because it's last
      dispatcher.init([builtinHook, fileHook]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(builtinHandler).not.toHaveBeenCalled();
      expect(fileHandler).toHaveBeenCalledTimes(1);
    });

    it('builtin hook with same ID but registered AFTER file → builtin wins', async () => {
      const fileHandler = vi.fn();
      const builtinHandler = vi.fn();

      // File first, then builtin — builtin wins (last wins in Map)
      dispatcher.init([
        makeHook({ id: 'dupe', hooks: ['onTurnComplete'], handler: fileHandler, source: 'file' }),
        makeHook({ id: 'dupe', hooks: ['onTurnComplete'], handler: builtinHandler, source: 'builtin' }),
      ]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(fileHandler).not.toHaveBeenCalled();
      expect(builtinHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────
  // 7. Init/Destroy Lifecycle
  // ────────────────────────────────────────────

  describe('Init/Destroy Lifecycle', () => {
    it('init() subscribes to bus and registers hooks', () => {
      const hook = makeHook({ hooks: ['onTurnComplete'] });
      dispatcher.init([hook]);

      expect(bus.has('session-hooks')).toBe(true);
    });

    it('destroy() unsubscribes from bus', () => {
      dispatcher.init([]);
      expect(bus.has('session-hooks')).toBe(true);

      dispatcher.destroy();
      expect(bus.has('session-hooks')).toBe(false);
    });

    it('destroy() stops delivering events', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnComplete'], handler })]);

      dispatcher.destroy();

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('calling init() twice clears old pruneTimer (no leak)', () => {
      vi.useFakeTimers();
      try {
        dispatcher.init([]);

        // Access private pruneTimer to verify it exists
        const firstTimer = (dispatcher as any).pruneTimer;
        expect(firstTimer).not.toBeNull();

        // Second init should clear the first timer
        dispatcher.init([]);

        const secondTimer = (dispatcher as any).pruneTimer;
        expect(secondTimer).not.toBeNull();
        // The timer references should differ (old one was cleared, new one created)
        expect(secondTimer).not.toBe(firstTimer);
      } finally {
        vi.useRealTimers();
      }
    });

    it('disabled hooks are filtered out during init', async () => {
      const enabledHandler = vi.fn();
      const disabledHandler = vi.fn();

      dispatcher.init([
        makeHook({ id: 'enabled', hooks: ['onTurnComplete'], handler: enabledHandler, enabled: true }),
        makeHook({ id: 'disabled', hooks: ['onTurnComplete'], handler: disabledHandler, enabled: false }),
      ]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(enabledHandler).toHaveBeenCalledTimes(1);
      expect(disabledHandler).not.toHaveBeenCalled();
    });

    it('addHook ignores disabled hooks', async () => {
      dispatcher.init([]);

      const handler = vi.fn();
      dispatcher.addHook(makeHook({ hooks: ['onTurnComplete'], handler, enabled: false }));

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('removeHook removes a hook by ID', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ id: 'to-remove', hooks: ['onTurnComplete'], handler })]);

      dispatcher.removeHook('to-remove');

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('config overrides are applied during init', () => {
      const handler = vi.fn();
      dispatcher.init(
        [makeHook({ id: 'overridden', hooks: ['onTurnComplete'], handler, priority: 100 })],
        { overrides: { overridden: { priority: 5 } } },
      );

      // Check that the hook's priority was overridden
      const hooks = (dispatcher as any).hooks;
      const hook = hooks.find((h: SessionHookDefinition) => h.id === 'overridden');
      expect(hook.priority).toBe(5);
    });

    it('config overrides can disable a hook', async () => {
      const handler = vi.fn();
      dispatcher.init(
        [makeHook({ id: 'to-disable', hooks: ['onTurnComplete'], handler, enabled: true })],
        { overrides: { 'to-disable': { enabled: false } } },
      );

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // Session state cleanup
  // ────────────────────────────────────────────

  describe('Session state cleanup', () => {
    it('session:ended fires onSessionEnd and clears payload cache', async () => {
      const endHandler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onSessionEnd'], handler: endHandler })]);

      // Start a session
      bus.emit(EventNames.SESSION_STARTED, { sessionId: 's1' }, ['*']);
      await tick();

      // End session → onSessionEnd should fire
      bus.emit(EventNames.SESSION_ENDED, { sessionId: 's1' }, ['*']);
      await tick();

      expect(endHandler).toHaveBeenCalledTimes(1);
      expect(endHandler.mock.calls[0][0].sessionId).toBe('s1');
      // Verify payload cache was cleared for this session
      expect(dispatcher['payloadBuilder'].clearSession).toHaveBeenCalledWith('s1');
    });

    it('session:ended resets turn state for new session with same id', async () => {
      const turnStartHandler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnStart'], handler: turnStartHandler })]);

      // First session lifecycle
      bus.emit(EventNames.SESSION_STARTED, { sessionId: 's1' }, ['*']);
      await tick();
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'msg1' }, ['*']);
      await tick();
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: 's1', text: 'resp' }, ['*']);
      await tick();

      expect(turnStartHandler).toHaveBeenCalledTimes(1);
      expect(turnStartHandler.mock.calls[0][0].turnIndex).toBe(1);

      // End and restart with same sessionId
      bus.emit(EventNames.SESSION_ENDED, { sessionId: 's1' }, ['*']);
      await tick();

      bus.emit(EventNames.SESSION_STARTED, { sessionId: 's1' }, ['*']);
      await tick();
      bus.emit(EventNames.SESSION_SEND, { sessionId: 's1', message: 'msg2' }, ['*']);
      await tick();
      bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: 's1', text: 'resp2' }, ['*']);
      await tick();

      // turnIndex should restart from 1 (new session state)
      expect(turnStartHandler).toHaveBeenCalledTimes(2);
      expect(turnStartHandler.mock.calls[1][0].turnIndex).toBe(1);
    });
  });

  // ────────────────────────────────────────────
  // Agent dispatch (subagent)
  // ────────────────────────────────────────────

  describe('Agent dispatch', () => {
    it('hook with agentId emits subagent:start instead of calling handler', async () => {
      const busEvents: Array<{ name: string; data: unknown }> = [];
      bus.subscribe('test-spy', (event) => {
        if (event.name === 'subagent:start') {
          busEvents.push({ name: event.name, data: event.data });
        }
      }, { global: true });

      dispatcher.init([makeHook({
        id: 'agent-hook',
        hooks: ['onTurnComplete'],
        handler: undefined,
        agentId: 'custom-triage',
        agentModel: 'claude-sonnet-4-20250514',
      })]);

      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: 's1', result: 'done', taskId: 'task-1',
      }, ['*']);

      await tick();

      expect(busEvents).toHaveLength(1);
      const data = busEvents[0].data as Record<string, unknown>;
      expect(data.agentId).toBe('custom-triage');
      expect(data.model).toBe('claude-sonnet-4-20250514');

      bus.unsubscribe('test-spy');
    });
  });

  // ────────────────────────────────────────────
  // Mode change detection
  // ────────────────────────────────────────────

  describe('Mode change detection', () => {
    it('session:status-changed with different mode → onModeChange', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onModeChange'], handler })]);

      // First, establish a session with initial mode
      bus.emit(EventNames.SESSION_STARTED, {
        sessionId: 's1', mode: 'default',
      }, ['*']);
      await tick();

      // Now change the mode
      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: 's1', mode: 'plan',
      }, ['*']);
      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.previousMode).toBe('default');
      expect(payload.newMode).toBe('plan');
    });

    it('session:status-changed with same mode → no onModeChange', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onModeChange'], handler })]);

      bus.emit(EventNames.SESSION_STARTED, {
        sessionId: 's1', mode: 'default',
      }, ['*']);
      await tick();

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: 's1', mode: 'default',
      }, ['*']);
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // Events with missing sessionId
  // ────────────────────────────────────────────

  describe('Missing sessionId', () => {
    it('events without sessionId are silently ignored', async () => {
      const handler = vi.fn();
      dispatcher.init([makeHook({ hooks: ['onTurnComplete'], handler })]);

      bus.emit(EventNames.SESSION_RESULT, {
        /* no sessionId */ result: 'done',
      }, ['*']);

      await tick();

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

// ────────────────────────────────────────────────
// 8. PayloadBuilder Cache
// ────────────────────────────────────────────────

describe('PayloadBuilder', () => {
  // We need to mock the dynamic imports used by PayloadBuilder
  const mockGetTask = vi.fn();
  const mockGetSessionByClaudeId = vi.fn();

  beforeEach(() => {
    mockGetTask.mockReset();
    mockGetSessionByClaudeId.mockReset();

    // Mock the dynamic imports
    vi.doMock('../../src/core/task-manager.js', () => ({
      getTask: mockGetTask,
    }));
    vi.doMock('../../src/core/session-tracker.js', () => ({
      getSessionByClaudeId: mockGetSessionByClaudeId,
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../src/core/task-manager.js');
    vi.doUnmock('../../src/core/session-tracker.js');
  });

  it('first call resolves task and session', async () => {
    const task = makeTask({ id: 'task-1' });
    const session = makeSession({ claudeSessionId: 's1' });
    mockGetTask.mockResolvedValue(task);
    mockGetSessionByClaudeId.mockResolvedValue(session);

    // Need fresh module to pick up mocks
    const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
    const builder = new FreshPayloadBuilder();

    const result = await builder.build('s1', 'task-1', 'trace-1');

    expect(result.sessionId).toBe('s1');
    expect(result.taskId).toBe('task-1');
    expect(result.task).toEqual(task);
    expect(result.session).toEqual(session);
    expect(result.traceId).toBe('trace-1');
    expect(result.timestamp).toBeDefined();
  });

  it('second call within TTL returns cached data (no re-resolve)', async () => {
    const task = makeTask({ id: 'task-1' });
    const session = makeSession({ claudeSessionId: 's1' });
    mockGetTask.mockResolvedValue(task);
    mockGetSessionByClaudeId.mockResolvedValue(session);

    const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
    const builder = new FreshPayloadBuilder();

    // First call
    await builder.build('s1', 'task-1', 'trace-1');
    expect(mockGetTask).toHaveBeenCalledTimes(1);
    expect(mockGetSessionByClaudeId).toHaveBeenCalledTimes(1);

    // Second call — should be cached
    const result2 = await builder.build('s1', 'task-1', 'trace-2');
    expect(mockGetTask).toHaveBeenCalledTimes(1); // NOT called again
    expect(mockGetSessionByClaudeId).toHaveBeenCalledTimes(1); // NOT called again
    expect(result2.task).toEqual(task);
    // traceId should be updated even when cached
    expect(result2.traceId).toBe('trace-2');
  });

  it('call after TTL expires re-resolves', async () => {
    vi.useFakeTimers();
    try {
      const task1 = makeTask({ id: 'task-1', title: 'v1' });
      const task2 = makeTask({ id: 'task-1', title: 'v2' });
      const session = makeSession({ claudeSessionId: 's1' });
      mockGetTask.mockResolvedValueOnce(task1).mockResolvedValueOnce(task2);
      mockGetSessionByClaudeId.mockResolvedValue(session);

      const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
      const builder = new FreshPayloadBuilder();

      // First call
      const r1 = await builder.build('s1', 'task-1', 'trace-1');
      expect(r1.task?.title).toBe('v1');

      // Advance past TTL (10s)
      vi.advanceTimersByTime(11_000);

      // Second call after TTL — should re-resolve
      const r2 = await builder.build('s1', 'task-1', 'trace-2');
      expect(r2.task?.title).toBe('v2');
      expect(mockGetTask).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearSession removes cache for specific session', async () => {
    const task = makeTask({ id: 'task-1' });
    const session = makeSession({ claudeSessionId: 's1' });
    mockGetTask.mockResolvedValue(task);
    mockGetSessionByClaudeId.mockResolvedValue(session);

    const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
    const builder = new FreshPayloadBuilder();

    // Populate cache
    await builder.build('s1', 'task-1', 'trace-1');
    expect(mockGetTask).toHaveBeenCalledTimes(1);

    // Clear cache for s1
    builder.clearSession('s1');

    // Next call should re-resolve
    await builder.build('s1', 'task-1', 'trace-2');
    expect(mockGetTask).toHaveBeenCalledTimes(2);
  });

  it('clearAll removes all cached entries', async () => {
    const task = makeTask({ id: 'task-1' });
    const session = makeSession({ claudeSessionId: 's1' });
    mockGetTask.mockResolvedValue(task);
    mockGetSessionByClaudeId.mockResolvedValue(session);

    const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
    const builder = new FreshPayloadBuilder();

    // Populate cache for two sessions
    await builder.build('s1', 'task-1', 'trace-1');
    await builder.build('s2', 'task-1', 'trace-2');
    expect(mockGetTask).toHaveBeenCalledTimes(2);

    // Clear all
    builder.clearAll();

    // Next calls should re-resolve
    await builder.build('s1', 'task-1', 'trace-3');
    await builder.build('s2', 'task-1', 'trace-4');
    expect(mockGetTask).toHaveBeenCalledTimes(4);
  });

  it('prune removes expired entries', async () => {
    vi.useFakeTimers();
    try {
      const task = makeTask({ id: 'task-1' });
      const session = makeSession({ claudeSessionId: 's1' });
      mockGetTask.mockResolvedValue(task);
      mockGetSessionByClaudeId.mockResolvedValue(session);

      const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
      const builder = new FreshPayloadBuilder();

      // Populate cache
      await builder.build('s1', 'task-1', 'trace-1');
      expect(mockGetTask).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.advanceTimersByTime(11_000);

      // Prune expired
      builder.prune();

      // Next call should re-resolve (cache was pruned)
      await builder.build('s1', 'task-1', 'trace-2');
      expect(mockGetTask).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles task lookup failure gracefully', async () => {
    mockGetTask.mockRejectedValue(new Error('task not found'));
    mockGetSessionByClaudeId.mockResolvedValue(makeSession({ claudeSessionId: 's1' }));

    const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
    const builder = new FreshPayloadBuilder();

    const result = await builder.build('s1', 'task-1', 'trace-1');

    expect(result.task).toBeUndefined();
    expect(result.session).toBeDefined();
  });

  it('handles session lookup failure gracefully', async () => {
    mockGetTask.mockResolvedValue(makeTask({ id: 'task-1' }));
    mockGetSessionByClaudeId.mockRejectedValue(new Error('session not found'));

    const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
    const builder = new FreshPayloadBuilder();

    const result = await builder.build('s1', 'task-1', 'trace-1');

    expect(result.task).toBeDefined();
    expect(result.session).toBeUndefined();
  });

  it('no taskId → skips task resolution entirely', async () => {
    mockGetSessionByClaudeId.mockResolvedValue(makeSession({ claudeSessionId: 's1' }));

    const { PayloadBuilder: FreshPayloadBuilder } = await import('../../src/core/session-hooks/payload.js');
    const builder = new FreshPayloadBuilder();

    const result = await builder.build('s1', undefined, 'trace-1');

    expect(mockGetTask).not.toHaveBeenCalled();
    expect(result.task).toBeUndefined();
    expect(result.session).toBeDefined();
  });
});
