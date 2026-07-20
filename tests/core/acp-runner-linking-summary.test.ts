import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () =>
  createMockConstants('walnut-acp-runner-linking-summary'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  enqueueMessage,
  getQueue,
  loadQueue,
  resetCache,
} from '../../src/core/session-message-queue.js';
import {
  _resetForTesting,
  addTask,
  getTask,
} from '../../src/core/task-manager.js';
import * as taskManager from '../../src/core/task-manager.js';
import {
  _resetSessionTrackerForTesting,
  createSessionRecord,
  getSessionByClaudeId,
  stageAcpSessionIdMigration,
  updateSessionRecord,
} from '../../src/core/session-tracker.js';
import {
  __resetTriageRateLimiter,
  runTriage,
} from '../../src/core/session-hooks/builtins.js';
import type { OnTurnCompletePayload } from '../../src/core/session-hooks/types.js';
import type { SessionRecord } from '../../src/core/types.js';
import {
  AcpForkUnsupportedError,
  SessionRunner,
  assertSessionForkSupported,
  sessionRunner,
} from '../../src/providers/claude-code-session.js';
import { AcpSession } from '../../src/providers/acp-session.js';
import { bus } from '../../src/core/event-bus.js';

beforeEach(async () => {
  _resetForTesting();
  _resetSessionTrackerForTesting();
  resetCache();
  __resetTriageRateLimiter();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  const singleton = sessionRunner as unknown as {
    acpSessions: Map<string, unknown>;
    sessions: Map<string, unknown>;
  };
  singleton.acpSessions.clear();
  singleton.sessions.clear();
  _resetForTesting();
  _resetSessionTrackerForTesting();
  resetCache();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('ACP runner queue contract', () => {
  it('sends one exact queued item with its stable queue ID per turn', async () => {
    const runner = new SessionRunner();
    const sessionId = 'acp-queue-session';
    let activity: 'processing' | 'idle' = 'idle';
    const send = vi.fn(async () => {
      activity = 'processing';
    });
    const fake = {
      runtimeId: 'acp-runtime-queue',
      sessionId,
      get activity() { return activity; },
      establish: vi.fn(async () => sessionId),
      send,
      abortTurn: vi.fn(async () => {}),
    };

    const first = await enqueueMessage(sessionId, 'first\n\nexact text');
    const second = await enqueueMessage(sessionId, 'second exact text');

    await (runner as unknown as {
      drainAcpQueue(session: unknown, sid: string): Promise<void>;
    }).drainAcpQueue(fake, sessionId);

    expect(send).toHaveBeenCalledWith('first\n\nexact text', first.id);
    expect(send).not.toHaveBeenCalledWith(
      expect.stringContaining('second exact text'),
      expect.anything(),
    );
    expect(await getQueue(sessionId)).toEqual([
      expect.objectContaining({
        id: second.id,
        message: 'second exact text',
        status: 'pending',
      }),
    ]);

    // A second drain while the first turn is active is a no-op.
    await (runner as unknown as {
      drainAcpQueue(session: unknown, sid: string): Promise<void>;
    }).drainAcpQueue(fake, sessionId);
    expect(send).toHaveBeenCalledTimes(1);

    // The terminal turn boundary unlocks exactly the next item.
    activity = 'idle';
    (runner as unknown as {
      clearActiveProcessing(sid: string): void;
    }).clearActiveProcessing(sessionId);
    await (runner as unknown as {
      drainAcpQueue(session: unknown, sid: string): Promise<void>;
    }).drainAcpQueue(fake, sessionId);

    expect(send).toHaveBeenNthCalledWith(2, 'second exact text', second.id);
    (runner as unknown as {
      clearActiveProcessing(sid: string): void;
    }).clearActiveProcessing(sessionId);
  });

  it('keeps terminal drain behind accepted-prompt queue settlement', async () => {
    const runner = new SessionRunner();
    const sessionId = 'acp-fast-terminal-session';
    let releaseSend!: () => void;
    const sendAccepted = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let activity: 'processing' | 'idle' = 'idle';
    const send = vi.fn(async () => {
      activity = 'processing';
      await sendAccepted;
      activity = 'idle';
    });
    const fake = {
      runtimeId: 'acp-runtime-fast-terminal',
      sessionId,
      get activity() { return activity; },
      establish: vi.fn(async () => sessionId),
      send,
      abortTurn: vi.fn(async () => {}),
    };
    const first = await enqueueMessage(sessionId, 'first');
    const second = await enqueueMessage(sessionId, 'second');

    const firstDrain = (runner as unknown as {
      drainAcpQueue(session: unknown, sid: string): Promise<void>;
    }).drainAcpQueue(fake, sessionId);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const settlement = (runner as unknown as {
      acpDeliverySettlements: Map<string, Promise<void>>;
    }).acpDeliverySettlements.get(sessionId);
    expect(settlement).toBeDefined();
    let settled = false;
    void settlement!.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSend();
    await firstDrain;
    await settlement;

    expect(settled).toBe(true);
    expect(await getQueue(sessionId)).toEqual([
      expect.objectContaining({ id: second.id, status: 'pending' }),
    ]);
    expect((await getQueue(sessionId)).some((message) => message.id === first.id))
      .toBe(false);
  });
});

describe('ACP task linking and fork routing', () => {
  it('links slot, primary session, and history idempotently', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP link target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const sessionId = 'acp-link-session';
    const link = (runner as unknown as {
      linkAcpSessionToTask(
        taskId: string,
        sid: string,
        mode: 'default',
      ): Promise<void>;
    }).linkAcpSessionToTask.bind(runner);

    await link(task.id, sessionId, 'default');
    await link(task.id, sessionId, 'default');

    const linked = await getTask(task.id);
    expect(linked.exec_session_id).toBe(sessionId);
    expect(linked.session_id).toBe(sessionId);
    expect(linked.session_ids.filter((id) => id === sessionId)).toHaveLength(1);
  });

  it('rejects unsupported Codex fork routing with a typed error', () => {
    expect(() => assertSessionForkSupported({
      claudeSessionId: 'codex-source-session',
      engine: 'codex',
    })).toThrow(AcpForkUnsupportedError);

    expect(() => assertSessionForkSupported({
      claudeSessionId: 'native-source-session',
      engine: 'claude',
    })).not.toThrow();
  });

  it('single-flights concurrent record reattach into one ACP consumer', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP attach target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    await createSessionRecord('acp-attach-session', task.id, task.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-attach-runtime',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const establish = vi.spyOn(AcpSession.prototype, 'establish')
      .mockImplementation(async function establishOnce() {
        await gate;
        return this.sessionId!;
      });
    const attach = (runner as unknown as {
      maybeAttachAcpSession(id: string): Promise<AcpSession | undefined>;
    }).maybeAttachAcpSession.bind(runner);

    const first = attach('acp-attach-session');
    const second = attach('acp-attach-session');
    await vi.waitFor(() => expect(establish).toHaveBeenCalledOnce());
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(establish).toHaveBeenCalledOnce();
  });

  it('does not reattach or reclaim task slots for an archived ACP record', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'Archived ACP target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    await createSessionRecord('acp-archived-session', task.id, task.project, '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: 'acp-archived-runtime',
    });
    await updateSessionRecord('acp-archived-session', { archived: true });
    const establish = vi.spyOn(AcpSession.prototype, 'establish');

    const attached = await (runner as unknown as {
      maybeAttachAcpSession(id: string): Promise<AcpSession | undefined>;
    }).maybeAttachAcpSession('acp-archived-session');

    expect(attached).toBeUndefined();
    expect(establish).not.toHaveBeenCalled();
    expect((await getTask(task.id)).session_id).toBeUndefined();
  });

  it('rechecks archival after establish before reclaiming a task slot', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP archive race target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const sessionId = 'acp-archive-race-session';
    await createSessionRecord(sessionId, task.id, task.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-archive-race-runtime',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const establish = vi.spyOn(AcpSession.prototype, 'establish')
      .mockImplementation(async () => {
        await gate;
        return sessionId;
      });
    const attaching = (runner as unknown as {
      maybeAttachAcpSession(id: string): Promise<AcpSession | undefined>;
    }).maybeAttachAcpSession(sessionId);
    await vi.waitFor(() => expect(establish).toHaveBeenCalledOnce());

    await updateSessionRecord(sessionId, { archived: true });
    release();

    expect(await attaching).toBeUndefined();
    expect((await getTask(task.id)).session_id).toBeUndefined();
    expect((runner as unknown as {
      acpSessions: Map<string, unknown>;
    }).acpSessions.size).toBe(0);
  });

  it('compensates when archival lands after provider task links are published', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP final archive race target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const sessionId = 'acp-final-archive-race-session';
    await createSessionRecord(sessionId, task.id, task.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-final-archive-race-runtime',
    });
    vi.spyOn(AcpSession.prototype, 'establish').mockResolvedValue(sessionId);
    const stop = vi.spyOn(AcpSession.prototype, 'kill').mockResolvedValue();
    const originalLinkSession = taskManager.linkSession;
    vi.spyOn(taskManager, 'linkSession').mockImplementationOnce(async (...args) => {
      const linked = await originalLinkSession(...args);
      await updateSessionRecord(sessionId, {
        archived: true,
        archive_reason: 'user_archived',
      });
      return linked;
    });

    const attached = await (runner as unknown as {
      maybeAttachAcpSession(id: string): Promise<AcpSession | undefined>;
    }).maybeAttachAcpSession(sessionId);

    expect(attached).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    const after = await getTask(task.id);
    expect(after.session_id).toBeUndefined();
    expect(after.exec_session_id).toBeUndefined();
    expect(after.session_ids).toContain(sessionId);
    expect((runner as unknown as {
      acpSessions: Map<string, unknown>;
    }).acpSessions.size).toBe(0);
  });

  it('migrates the durable record and every task link when fallback gets a new provider ID', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP fallback target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const oldId = 'acp-provider-old';
    const newId = 'acp-provider-new';
    await createSessionRecord(oldId, task.id, task.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-fallback-runtime',
      acpJournalPath: '/tmp/acp-fallback-runtime.acp.jsonl',
    });
    await (runner as unknown as {
      linkAcpSessionToTask(taskId: string, sid: string, mode: 'default'): Promise<void>;
    }).linkAcpSessionToTask(task.id, oldId, 'default');
    const session = new AcpSession({
      taskId: task.id,
      project: task.project,
      cwd: '/tmp',
      mode: 'default',
      providerSessionId: oldId,
      runtimeId: 'acp-fallback-runtime',
      acpJournalPath: '/tmp/acp-fallback-runtime.acp.jsonl',
    });

    await (session as unknown as {
      adoptSessionResponse(response: unknown): Promise<void>;
    }).adoptSessionResponse({ sessionId: newId });

    expect(await getSessionByClaudeId(oldId)).toBeNull();
    expect(await getSessionByClaudeId(newId)).toMatchObject({
      claudeSessionId: newId,
      acpRuntimeId: 'acp-fallback-runtime',
      acpJournalPath: '/tmp/acp-fallback-runtime.acp.jsonl',
    });
    const linked = await getTask(task.id);
    expect(linked.session_id).toBe(newId);
    expect(linked.exec_session_id).toBe(newId);
    expect(linked.session_ids).toContain(newId);
    expect(linked.session_ids).not.toContain(oldId);
  });

  it('rolls the durable record back when provider-ID task-link migration fails', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP fallback rollback target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const oldId = 'acp-provider-rollback-old';
    const newId = 'acp-provider-rollback-new';
    await createSessionRecord(oldId, task.id, task.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-fallback-rollback-runtime',
    });
    await (runner as unknown as {
      linkAcpSessionToTask(taskId: string, sid: string, mode: 'default'): Promise<void>;
    }).linkAcpSessionToTask(task.id, oldId, 'default');
    const session = new AcpSession({
      taskId: task.id,
      project: task.project,
      cwd: '/tmp',
      mode: 'default',
      providerSessionId: oldId,
      runtimeId: 'acp-fallback-rollback-runtime',
      artifacts: { workerCmd: ['worker'], adapterCmd: ['adapter'] },
    });
    const send = vi.fn(async (command: string, params?: Record<string, unknown>) => {
      if (command === 'acpStart') {
        return {
          ok: true,
          state: {
            providerSessionId: oldId,
            adapterPid: 123,
            turnActive: false,
            controlActive: false,
            pendingPermissions: [],
            initializeResponse: {},
            capabilities: {},
            sessionResponse: {},
            lastAcceptedCommands: {},
            journalOffset: 0,
          },
        };
      }
      return { ok: true, result: { accepted: true, params } };
    });
    Object.assign(session as object, {
      conn: { connected: true, send },
      _active: true,
    });
    vi.spyOn(taskManager, 'replaceSessionIdLinks')
      .mockRejectedValueOnce(new Error('injected task-link write failure'));

    await expect((session as unknown as {
      publishSessionResponse(response: unknown): Promise<void>;
    }).publishSessionResponse({ sessionId: newId }))
      .rejects.toThrow('injected task-link write failure');

    expect(await getSessionByClaudeId(oldId)).toMatchObject({
      claudeSessionId: oldId,
      acpRuntimeId: 'acp-fallback-rollback-runtime',
    });
    expect(await getSessionByClaudeId(newId)).toBeNull();
    const linked = await getTask(task.id);
    expect(linked.session_id).toBe(oldId);
    expect(linked.exec_session_id).toBe(oldId);
    expect(linked.session_ids).toContain(oldId);
    expect(linked.session_ids).not.toContain(newId);
    expect(session.sessionId).toBe(oldId);
    expect(session.active).toBe(false);
    expect(send).toHaveBeenCalledWith('acpStop', {
      sid: 'acp-fallback-rollback-runtime',
    });

    await session.sendAccepted('next prompt after rollback', 'qm-after-rollback');
    expect(send).toHaveBeenCalledWith('acpStart', expect.objectContaining({
      sid: 'acp-fallback-rollback-runtime',
      providerSessionId: oldId,
    }));
    expect(send).toHaveBeenCalledWith('acpSend', expect.objectContaining({
      sid: 'acp-fallback-rollback-runtime',
      walnutMessageId: 'qm-after-rollback',
    }));
    expect(session.sessionId).toBe(oldId);
  });

  it('recovers a crash-staged provider-ID migration with one runtime consumer', async () => {
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP fallback crash recovery target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const oldId = 'acp-provider-crash-old';
    const newId = 'acp-provider-crash-new';
    const runtimeId = 'acp-fallback-crash-runtime';
    const journalPath = '/tmp/acp-fallback-crash-runtime.acp.jsonl';
    await createSessionRecord(oldId, task.id, task.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: runtimeId,
      acpJournalPath: journalPath,
    });
    await (runner as unknown as {
      linkAcpSessionToTask(taskId: string, sid: string, mode: 'default'): Promise<void>;
    }).linkAcpSessionToTask(task.id, oldId, 'default');
    const queued = await enqueueMessage(oldId, 'survive identity migration crash');

    // Simulate process death after the SQLite stage committed but before task
    // links changed. Both records survive; the old one is a durable redirect.
    await stageAcpSessionIdMigration(oldId, newId, {
      acpRuntimeId: runtimeId,
      acpJournalPath: journalPath,
    });
    expect(await getSessionByClaudeId(oldId)).toMatchObject({
      archived: true,
      archive_reason: `acp_identity_replaced:${newId}`,
    });
    expect((await getTask(task.id)).session_id).toBe(oldId);

    const emit = vi.spyOn(bus, 'emit');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const establish = vi.spyOn(AcpSession.prototype, 'establish')
      .mockImplementation(async function establishRecovered() {
        await gate;
        return this.sessionId!;
      });
    const send = vi.spyOn(AcpSession.prototype, 'send').mockResolvedValue();
    const attach = (runner as unknown as {
      maybeAttachAcpSession(id: string): Promise<AcpSession | undefined>;
    }).maybeAttachAcpSession.bind(runner);
    const fromOldIdentity = attach(oldId);
    const fromNewIdentity = attach(newId);
    await vi.waitFor(() => expect(establish).toHaveBeenCalledOnce());
    release();

    const [oldAttach, newAttach] = await Promise.all([
      fromOldIdentity,
      fromNewIdentity,
    ]);
    expect(oldAttach).toBe(newAttach);
    expect(establish).toHaveBeenCalledOnce();
    expect(emit.mock.calls.filter(([name, data]) =>
      name === 'session:system-event'
        && (data as { previousSessionId?: string }).previousSessionId === oldId
        && (data as { newSessionId?: string }).newSessionId === newId))
      .toHaveLength(1);
    expect(runner.findAcpSession(oldId)).toBe(oldAttach);
    expect(await getSessionByClaudeId(oldId)).toBeNull();
    expect(await getSessionByClaudeId(newId)).toMatchObject({
      claudeSessionId: newId,
      acpRuntimeId: runtimeId,
      acpJournalPath: journalPath,
      archived: false,
    });
    const linked = await getTask(task.id);
    expect(linked.session_id).toBe(newId);
    expect(linked.exec_session_id).toBe(newId);
    expect(linked.session_ids).toContain(newId);
    expect(linked.session_ids).not.toContain(oldId);

    expect(await getQueue(oldId)).toEqual([]);
    expect(await getQueue(newId)).toEqual([
      expect.objectContaining({ id: queued.id, sessionId: newId, status: 'pending' }),
    ]);

    // Simulate a crash after the redirect row was deleted. A fresh runner has
    // no old-ID alias in memory; startup redelivery must still find the queue
    // under the durable replacement identity and deliver its stable command ID.
    const oldState = runner as unknown as {
      acpSessions: Map<string, AcpSession>;
    };
    for (const session of new Set(oldState.acpSessions.values())) session.detach();
    oldState.acpSessions.clear();
    resetCache();
    await loadQueue();
    const recoveredRunner = new SessionRunner();
    await (recoveredRunner as unknown as {
      processNext(id: string): Promise<void>;
    }).processNext(newId);
    await (recoveredRunner as unknown as {
      processNext(id: string): Promise<void>;
    }).processNext(newId);
    expect(send).toHaveBeenCalledWith('survive identity migration crash', queued.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await getQueue(oldId)).toEqual([]);
    expect(await getQueue(newId)).toEqual([]);
  });

  it('rejects a fallback provider ID already owned by another ACP runtime', async () => {
    const { task: sourceTask } = await addTask({
      title: 'ACP collision source',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const { task: otherTask } = await addTask({
      title: 'ACP collision owner',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const oldId = 'acp-provider-collision-old';
    const occupiedId = 'acp-provider-collision-occupied';
    await createSessionRecord(oldId, sourceTask.id, sourceTask.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-collision-source-runtime',
    });
    await createSessionRecord(occupiedId, otherTask.id, otherTask.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-collision-other-runtime',
    });
    const session = new AcpSession({
      taskId: sourceTask.id,
      project: sourceTask.project,
      cwd: '/tmp',
      mode: 'default',
      providerSessionId: oldId,
      runtimeId: 'acp-collision-source-runtime',
    });

    await expect((session as unknown as {
      adoptSessionResponse(response: unknown): Promise<void>;
    }).adoptSessionResponse({ sessionId: occupiedId }))
      .rejects.toThrow(/already belongs to another session/i);

    expect(await getSessionByClaudeId(oldId)).toMatchObject({
      taskId: sourceTask.id,
      acpRuntimeId: 'acp-collision-source-runtime',
    });
    expect(await getSessionByClaudeId(occupiedId)).toMatchObject({
      taskId: otherTask.id,
      acpRuntimeId: 'acp-collision-other-runtime',
    });
  });

  it('does not let an in-flight reattach repopulate a destroyed runner', async () => {
    vi.spyOn(bus, 'unsubscribe').mockImplementation(() => {});
    const runner = new SessionRunner();
    const { task } = await addTask({
      title: 'ACP destroy race target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const sessionId = 'acp-destroy-race-session';
    await createSessionRecord(sessionId, task.id, task.project, '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'acp-destroy-race-runtime',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const establish = vi.spyOn(AcpSession.prototype, 'establish')
      .mockImplementation(async () => {
        await gate;
        return sessionId;
      });
    const attaching = (runner as unknown as {
      maybeAttachAcpSession(id: string): Promise<AcpSession | undefined>;
    }).maybeAttachAcpSession(sessionId);
    await vi.waitFor(() => expect(establish).toHaveBeenCalledOnce());

    runner.destroy();
    release();

    expect(await attaching).toBeUndefined();
    const state = runner as unknown as {
      acpSessions: Map<string, unknown>;
      acpAttachPromises: Map<string, unknown>;
    };
    expect(state.acpSessions.size).toBe(0);
    expect(state.acpAttachPromises.size).toBe(0);
    expect((await getTask(task.id)).session_id).toBeUndefined();
  });

  it('detaches or stops ACP workers and clears all ACP runner state on destruction', async () => {
    vi.spyOn(bus, 'unsubscribe').mockImplementation(() => {});
    const detachRunner = new SessionRunner();
    const detach = vi.fn();
    const detached = { detach, kill: vi.fn(async () => {}) };
    const detachState = detachRunner as unknown as {
      acpSessions: Map<string, typeof detached>;
      acpAttachPromises: Map<string, Promise<unknown>>;
      acpAbortInProgress: Set<string>;
      acpDeliverySettlements: Map<string, Promise<void>>;
    };
    detachState.acpSessions.set('runtime', detached);
    detachState.acpSessions.set('provider', detached);
    detachState.acpAttachPromises.set('provider', Promise.resolve(undefined));
    detachState.acpAbortInProgress.add('provider');
    detachState.acpDeliverySettlements.set('provider', Promise.resolve());
    detachRunner.destroy();

    expect(detach).toHaveBeenCalledOnce();
    expect(detachState.acpSessions.size).toBe(0);
    expect(detachState.acpAttachPromises.size).toBe(0);
    expect(detachState.acpAbortInProgress.size).toBe(0);
    expect(detachState.acpDeliverySettlements.size).toBe(0);

    const killRunner = new SessionRunner();
    const kill = vi.fn(async () => {});
    const killed = { detach: vi.fn(), kill };
    const killState = killRunner as unknown as {
      acpSessions: Map<string, typeof killed>;
    };
    killState.acpSessions.set('runtime', killed);
    killState.acpSessions.set('provider', killed);
    killRunner.destroyAndKill();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
    expect(killed.detach).toHaveBeenCalledOnce();
    expect(killState.acpSessions.size).toBe(0);
  });

  it.each(['destroy', 'destroyAndKill'] as const)(
    '%s aborts an open turn-ledger promise immediately',
    async (method) => {
      vi.spyOn(bus, 'unsubscribe').mockImplementation(() => {});
      const runner = new SessionRunner();
      (runner as unknown as {
        setActiveProcessing(id: string, count: number): void;
      }).setActiveProcessing('open-turn-on-destroy', 1);
      const current = runner.currentTurn('open-turn-on-destroy');
      expect(current).toBeDefined();
      const rejected = expect(current!).rejects.toThrow(
        method === 'destroy' ? 'session-runner-destroyed' : 'session-runner-destroyed-and-killed',
      );

      runner[method]();

      await rejected;
      expect(runner.currentTurn('open-turn-on-destroy')).toBeUndefined();
    },
  );
});

describe('ACP replay monotonicity', () => {
  it('does not reopen durable running state when recovered acceptance follows interruption', async () => {
    const sessionId = 'acp-monotonic-replay-session';
    const commandId = 'acp-prompt:qm-monotonic';
    await createSessionRecord(sessionId, '', 'Quick Start', '/tmp', {
      initialProcessStatus: 'running',
      messageCount: 0,
      engine: 'codex',
      acpRuntimeId: 'acp-monotonic-replay-runtime',
    });
    const session = new AcpSession({
      taskId: '',
      project: 'Quick Start',
      cwd: '/tmp',
      mode: 'default',
      providerSessionId: sessionId,
      runtimeId: 'acp-monotonic-replay-runtime',
      consumedOffset: 0,
    });
    const consume = (session as unknown as {
      consumeJournalLine(line: string, offset: number): void;
    }).consumeJournalLine.bind(session);

    consume(JSON.stringify({
      kind: 'meta',
      ts: 1,
      event: { type: 'turn-interrupted', reason: 'worker-crash', commandId },
    }), 100);
    consume(JSON.stringify({
      kind: 'meta',
      ts: 2,
      event: {
        type: 'prompt-accepted',
        commandId,
        walnutMessageId: 'qm-monotonic',
        text: 'already terminal',
      },
    }), 200);

    await vi.waitFor(async () => {
      expect(await getSessionByClaudeId(sessionId)).toMatchObject({
        process_status: 'error',
        status_reason: 'api_error',
        lastAcceptedAcpCommandId: commandId,
        messageCount: 1,
      });
    });
    expect(session.activity).toBe('idle');
  });
});

describe('provider-neutral turn-complete self-report', () => {
  it('persists ACP task summary and session recap through the existing merge policy', async () => {
    const { task } = await addTask({
      title: 'ACP summary target',
      category: 'Local',
      project: 'Quick Start',
      source: 'local',
      _skipPluginOps: true,
    });
    const sessionId = 'acp-summary-session';
    const record = await createSessionRecord(
      sessionId,
      task.id,
      task.project,
      '/tmp/acp-summary',
      {
        initialProcessStatus: 'idle',
        engine: 'codex',
        acpRuntimeId: 'acp-summary-runtime',
      },
    );
    const report = `EXEC_SUMMARY: Codex completed the queue integration and focused tests pass.
GOAL: Request: integrate Codex sessions. Objective: preserve one prompt per turn with task parity.
CONTEXT: Codex runs through an ACP provider session.
PROGRESS: DONE queue integration - focused tests pass
WORK_LOG: append: Added stable queue IDs and provider-neutral summary handling.
RECAP: Queue integration complete; focused tests pass.
WHAT_I_DID: Integrated one-item ACP queue delivery and task linking.
STATUS: succeeded - focused tests pass.
PHASE_SIGNAL: implement-done
NEXT_STEPS: Run the full E2E matrix.
BLOCKERS: none
USER_INTENT: autonomous
VERIFIED: ran-and-saw-pass`;
    const requestTurnCompleteSelfReport = vi.fn(async () => report);
    const fake = {
      runtimeId: record.acpRuntimeId,
      sessionId,
      get activity() { return 'idle' as const; },
      establish: vi.fn(async () => sessionId),
      send: vi.fn(async () => {}),
      abortTurn: vi.fn(async () => {}),
      requestTurnCompleteSelfReport,
    };
    (sessionRunner as unknown as {
      acpSessions: Map<string, unknown>;
    }).acpSessions.set(sessionId, fake);

    await runTriage({
      sessionId,
      taskId: task.id,
      task,
      session: record as SessionRecord,
      result: 'done',
      turnIndex: 1,
      isPlanSession: false,
      timestamp: new Date().toISOString(),
      traceId: 'acp-summary-test',
    } as OnTurnCompletePayload);

    expect(requestTurnCompleteSelfReport).toHaveBeenCalledOnce();
    expect((await getTask(task.id)).summary)
      .toBe('Codex completed the queue integration and focused tests pass.');
    expect((await getSessionByClaudeId(sessionId))?.recap)
      .toBe('Queue integration complete; focused tests pass.');
  });
});
