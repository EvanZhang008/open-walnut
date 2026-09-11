/**
 * SubagentRunner contract.
 *
 * A `subagent:start` is a REAL session launch wearing the named agent's persona
 * (quickStartSession with walnutAgent + agentId), and a `subagent:send` is an
 * ordinary session send to the session that run owns. quickStartSession and
 * performSessionSend are stubbed — this pins the CALL the runner makes and the
 * bus events it emits, not their internals (those have their own tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// ── Stubs for the collaborators (hoisted: vi.mock factories run first) ──

const stub = vi.hoisted(() => {
  class FakeQuickStartError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'QuickStartError';
    }
  }
  class FakeSendError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'SendError';
    }
  }
  return {
    FakeQuickStartError,
    FakeSendError,
    quickStartSession: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'task-created' })),
    performSessionSend: vi.fn(async (input: { to?: string }) => ({
      delivery: 'queued' as const,
      targetSessionId: input.to ?? '',
      targetTitle: null,
      target: { handle: `[${input.to}]`, sessionId: input.to ?? '' },
    })),
    getTask: vi.fn(async (id: string) => ({ id, title: 'Trigger', project: 'Marina' })),
    // Registry input: one console agent, one background-only agent.
    config: {
      agent: {
        agents: [
          { id: 'helper', name: 'Helper', description: 'a console agent', console: true },
          // No `console` flag: exactly what a hook's run_agent action targets.
          { id: 'tracker', name: 'Tracker', description: 'a background agent' },
        ],
      },
    },
  };
});

vi.mock('../../src/core/sessions/quick-start.js', () => ({
  quickStartSession: stub.quickStartSession,
  QuickStartError: stub.FakeQuickStartError,
}));

vi.mock('../../src/core/sessions/session-send-core.js', () => ({
  performSessionSend: stub.performSessionSend,
  SendError: stub.FakeSendError,
}));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => stub.config),
  updateConfig: vi.fn(async () => {}),
  _resetWriteLockForTest: vi.fn(),
}));

vi.mock('../../src/core/task-manager.js', () => ({ getTask: stub.getTask }));

const { quickStartSession, performSessionSend, FakeQuickStartError, FakeSendError } = stub;

// ── Imports (after mocks) ──

import { SubagentRunner } from '../../src/providers/subagent-runner.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

const LISTENER = 'subagent-runner-contract-test';

interface Seen { name: string; data: Record<string, unknown> }

let runner: SubagentRunner;
let seen: Seen[];

function emitStart(data: { agentId?: string; task: string; taskId?: string; model?: string; context?: string }): void {
  bus.emit(EventNames.SUBAGENT_START, data as { agentId: string; task: string }, ['subagent-runner'], { source: 'test' });
}

function emitSend(runId: string, message: string): void {
  bus.emit(EventNames.SUBAGENT_SEND, { runId, message }, ['subagent-runner'], { source: 'test' });
}

const seenOf = (name: string): Seen | undefined => seen.find((e) => e.name === name);

/** This machine runs several agent sessions at once; the default 1s window is
 *  too tight for a first module load under that load. */
const waitFor = (assertion: () => void): Promise<void> =>
  vi.waitFor(assertion, { timeout: 15_000, interval: 25 });

beforeEach(() => {
  quickStartSession.mockClear();
  performSessionSend.mockClear();
  seen = [];
  bus.subscribe(LISTENER, (event) => {
    if (event.name.startsWith('subagent:')) {
      seen.push({ name: event.name, data: event.data as Record<string, unknown> });
    }
  }, { global: true });
  runner = new SubagentRunner();
  runner.init();
});

afterEach(() => {
  runner.destroy();
  bus.unsubscribe(LISTENER);
});

describe('subagent:start launches a session', () => {
  it('starts an Ask-style session for the Personal AI and reports it as started', async () => {
    emitStart({ agentId: 'general', task: 'Summarize today' });

    await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());
    expect(quickStartSession).toHaveBeenCalledTimes(1);
    const params = quickStartSession.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({
      walnutAgent: true,
      agentId: 'general',
      cwd: WALNUT_HOME,
      source: 'subagent',
      taskMeta: { pinTier: null },
      project: 'Ask Walnut',
    });
    expect(params.message).toBe('Summarize today');
    expect(params.taskTitle).toBe('Walnut: Summarize today');

    // The run id IS the session id the CLI adopts.
    const started = seenOf('subagent:started')!.data;
    expect(started.runId).toBe(params.preassignedSessionId);
    expect(started.agentId).toBe('general');
    expect(started.agentName).toBe('Walnut');

    const run = runner.getRun(started.runId as string)!;
    expect(run.runner).toBe('cli');
    expect(run.status).toBe('running');
    expect(run.sessionId).toBe(started.runId);
    expect(seenOf('subagent:error')).toBeUndefined();
  });

  it('accepts a config-defined agent that is not a console agent', async () => {
    emitStart({ agentId: 'tracker', task: 'Check the screenshots' });

    await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());
    const params = quickStartSession.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({ walnutAgent: true, agentId: 'tracker', project: 'Ask Tracker' });
    expect(seenOf('subagent:started')!.data.agentName).toBe('Tracker');
  });

  it('files the run under the triggering task project and names that task', async () => {
    emitStart({ agentId: 'helper', task: 'Look at this', taskId: 'task-7', context: 'Extra background' });

    await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());
    const params = quickStartSession.mock.calls[0][0] as Record<string, unknown>;
    expect(params.project).toBe('Marina');
    expect(params.message).toContain('task-7');
    expect(params.message).toContain('Extra background');
    expect(params.message).toContain('Look at this');
    expect(seenOf('subagent:started')!.data.taskId).toBe('task-7');
  });

  it('forwards an explicitly requested model and omits it otherwise', async () => {
    emitStart({ agentId: 'general', task: 'a', model: 'some-model' });
    await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());
    expect((quickStartSession.mock.calls[0][0] as Record<string, unknown>).model).toBe('some-model');

    quickStartSession.mockClear();
    seen = [];
    emitStart({ agentId: 'general', task: 'b' });
    await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());
    expect(quickStartSession.mock.calls[0][0] as Record<string, unknown>).not.toHaveProperty('model');
  });

  it('rejects an unknown agent id without launching anything', async () => {
    emitStart({ agentId: 'nope', task: 'Do a thing' });

    await waitFor(() => expect(seenOf('subagent:error')).toBeDefined());
    const error = seenOf('subagent:error')!.data;
    expect(error.agentId).toBe('nope');
    expect(String(error.error)).toContain('not found');
    expect(quickStartSession).not.toHaveBeenCalled();
    expect(seenOf('subagent:started')).toBeUndefined();
  });

  it('reports a rejected launch as subagent:error and marks the run failed', async () => {
    quickStartSession.mockRejectedValueOnce(new FakeQuickStartError('Unknown console agent "x"', 400));
    emitStart({ agentId: 'general', task: 'Do a thing', taskId: 'task-9' });

    await waitFor(() => expect(seenOf('subagent:error')).toBeDefined());
    const error = seenOf('subagent:error')!.data;
    expect(error.error).toBe('Unknown console agent "x"');
    expect(error.taskId).toBe('task-9');
    expect(runner.getRun(error.runId as string)!.status).toBe('error');
    expect(seenOf('subagent:started')).toBeUndefined();
  });
});

describe('subagent:send messages the run session', () => {
  async function startRun(): Promise<string> {
    emitStart({ agentId: 'general', task: 'Start something' });
    await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());
    return seenOf('subagent:started')!.data.runId as string;
  }

  it('sends to the session the run owns', async () => {
    const runId = await startRun();
    performSessionSend.mockClear();

    emitSend(runId, 'Keep going');

    await waitFor(() => expect(performSessionSend).toHaveBeenCalledTimes(1));
    expect(performSessionSend.mock.calls[0][0]).toMatchObject({
      to: runId,
      text: 'Keep going',
      expectReply: false,
    });
    expect(seenOf('subagent:error')).toBeUndefined();
  });

  it('still resolves a run id the ledger has never seen (post-restart send)', async () => {
    emitSend('11111111-2222-3333-4444-555555555555', 'Hello again');

    await waitFor(() => expect(performSessionSend).toHaveBeenCalledTimes(1));
    expect((performSessionSend.mock.calls[0][0] as { to?: string }).to)
      .toBe('11111111-2222-3333-4444-555555555555');
  });

  it('reports a failed send as subagent:error', async () => {
    const runId = await startRun();
    seen = [];
    performSessionSend.mockRejectedValueOnce(new FakeSendError('unknown_target', 'nothing matches'));

    emitSend(runId, 'Anyone there?');

    await waitFor(() => expect(seenOf('subagent:error')).toBeDefined());
    const error = seenOf('subagent:error')!.data;
    expect(error.runId).toBe(runId);
    expect(error.error).toBe('nothing matches');
  });
});

describe('run bookkeeping', () => {
  it('lists runs without the internal session/task mapping', async () => {
    emitStart({ agentId: 'general', task: 'Something' });
    await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());

    const runs = runner.getAllRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toHaveProperty('sessionId');
    expect(runs[0]).not.toHaveProperty('createdTaskId');
    expect(runs[0].agentId).toBe('general');
  });

  it('cancelRunsForTask interrupts a live run for that task only', async () => {
    const interrupts: string[] = [];
    bus.subscribe('subagent-runner-interrupt-test', (event) => {
      if (event.name === EventNames.SESSION_INTERRUPT) {
        interrupts.push((event.data as { sessionId: string }).sessionId);
      }
    }, { global: true });
    try {
      emitStart({ agentId: 'general', task: 'For the task', taskId: 'task-1' });
      await waitFor(() => expect(seenOf('subagent:started')).toBeDefined());
      const runId = seenOf('subagent:started')!.data.runId as string;

      expect(runner.cancelRunsForTask('other-task')).toBe(0);
      expect(runner.cancelRunsForTask('task-1')).toBe(1);
      expect(interrupts).toEqual([runId]);
      expect(runner.getRun(runId)!.status).toBe('error');
      // Terminal already: a second cancel is a no-op.
      expect(runner.cancelRunsForTask('task-1')).toBe(0);
    } finally {
      bus.unsubscribe('subagent-runner-interrupt-test');
    }
  });
});
