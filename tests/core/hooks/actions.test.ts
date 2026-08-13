/**
 * Unit tests for declarative hook actions (core/hooks/actions.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessageToSession = vi.fn(async () => ({ id: 'qm-1' }));
vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...args),
}));

const addNotification = vi.fn(async () => ({ id: 'n-1' }));
vi.mock('../../../src/core/notifications/store.js', () => ({
  addNotification: (...args: unknown[]) => addNotification(...args),
}));

import { executeHookAction, renderTemplate, describeAction, type HookAction } from '../../../src/core/hooks/actions.js';
import { bus } from '../../../src/core/event-bus.js';
import type { HookDefinition, TaskHookContext } from '../../../src/core/session-hooks/types.js';
import { makeTask } from '../../helpers/factories.js';

function taskCtx(overrides: Partial<TaskHookContext> = {}): TaskHookContext {
  const task = makeTask({ phase: 'HUMAN_VERIFIED', session_id: 'sess-9' });
  return {
    domain: 'task',
    taskId: task.id,
    task,
    sessionId: 'sess-9',
    oldPhase: 'AGENT_COMPLETE',
    newPhase: 'HUMAN_VERIFIED',
    eventSource: 'api',
    timestamp: new Date().toISOString(),
    traceId: 't-1',
    event: 'task:phase-changed',
    ...overrides,
  };
}

function makeHook(action: HookAction): HookDefinition {
  return {
    id: 'test-action-hook',
    name: 'Test Action Hook',
    hooks: ['onTaskPhaseChanged'],
    action,
    source: 'config',
  };
}

beforeEach(() => {
  sendMessageToSession.mockClear();
  addNotification.mockClear();
});

describe('renderTemplate', () => {
  it('substitutes whitelisted keys', () => {
    const ctx = taskCtx();
    expect(renderTemplate('Task {{task.title}} → {{newPhase}} (was {{oldPhase}}) in {{sessionId}}', ctx))
      .toBe('Task Test task → HUMAN_VERIFIED (was AGENT_COMPLETE) in sess-9');
  });

  it('unknown keys render empty — no expression evaluation', () => {
    const ctx = taskCtx();
    expect(renderTemplate('x{{nope}}y {{constructor}} {{task.__proto__}}', ctx)).toBe('xy  ');
  });
});

describe('executeHookAction', () => {
  it('send_message_to_session stamps source hook:<id> and renders the template', async () => {
    await executeHookAction(
      makeHook({ type: 'send_message_to_session', message: 'Verified: {{task.title}}' }),
      taskCtx(),
    );

    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    const [sid, message, opts] = sendMessageToSession.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(sid).toBe('sess-9');
    expect(message).toBe('Verified: Test task');
    expect(opts.source).toBe('hook:test-action-hook');
    expect(opts.taskId).toBe('test-1234');
  });

  it('send_message_to_session skips silently when no session attached', async () => {
    await executeHookAction(
      makeHook({ type: 'send_message_to_session', message: 'hi' }),
      taskCtx({ sessionId: undefined, task: makeTask({ session_id: undefined }) }),
    );
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('notify writes a hook-kind notification', async () => {
    await executeHookAction(
      makeHook({ type: 'notify', message: '{{task.title}} moved to {{newPhase}}', severity: 'warning' }),
      taskCtx(),
    );

    expect(addNotification).toHaveBeenCalledTimes(1);
    const [input] = addNotification.mock.calls[0] as [Record<string, unknown>];
    expect(input.kind).toBe('hook');
    expect(input.severity).toBe('warning');
    expect(input.body).toBe('Test task moved to HUMAN_VERIFIED');
  });

  it('run_agent emits subagent:start with hook source', async () => {
    const events: Array<{ name: string; data: unknown; source?: string }> = [];
    bus.subscribe('test-action-spy', (e) => {
      if (e.name === 'subagent:start') events.push({ name: e.name, data: e.data, source: e.source });
    }, { global: true, interest: ['subagent:'] });

    try {
      await executeHookAction(
        makeHook({ type: 'run_agent', agentId: 'triage', prompt: 'Check {{task.id}}' }),
        taskCtx(),
      );
      expect(events).toHaveLength(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.agentId).toBe('triage');
      expect(data.task).toBe('Check test-1234');
      expect(events[0].source).toBe('hook:test-action-hook');
    } finally {
      bus.unsubscribe('test-action-spy');
    }
  });

  it('unknown action type warns and skips (forward compat)', async () => {
    await expect(executeHookAction(
      makeHook({ type: 'launch_rocket' } as unknown as HookAction),
      taskCtx(),
    )).resolves.toBeUndefined();
    expect(sendMessageToSession).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalled();
  });
});

describe('describeAction', () => {
  it('summarizes each action type', () => {
    expect(describeAction({ type: 'send_message_to_session', message: 'hello' })).toMatch(/^Send message: "hello/);
    expect(describeAction({ type: 'notify', message: 'ping' })).toMatch(/^Notify:/);
    expect(describeAction({ type: 'run_agent', agentId: 'a1' })).toBe('Invoke agent: a1');
    expect(describeAction({ type: 'log' })).toBe('Write a log line');
  });
});
