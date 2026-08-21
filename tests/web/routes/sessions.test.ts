import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const taskSlotInterleave = vi.hoisted(() => ({
  beforeLink: undefined as undefined | ((
    taskId: string,
    sessionId: string,
    slot: 'plan' | 'exec',
  ) => Promise<void>),
}));

vi.mock('../../../src/constants.js', () => createMockConstants());
vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/task-manager.js')>();
  return {
    ...actual,
    linkSessionSlot: async (
      taskId: string,
      sessionId: string,
      slot: 'plan' | 'exec',
    ) => {
      await taskSlotInterleave.beforeLink?.(taskId, sessionId, slot);
      return actual.linkSessionSlot(taskId, sessionId, slot);
    },
  };
});
vi.mock('../../../src/core/ssh-config-scanner.js', () => ({
  scanSshConfig: async () => new Map(),
}));
vi.mock('../../../src/core/daemon-file-reader.js', async () => {
  const fsp = await import('node:fs/promises');
  return {
    DaemonFileReader: class {
      async readFile(filePath: string): Promise<string | null> {
        try {
          return await fsp.readFile(filePath, 'utf-8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }

      async findSession(): Promise<null> {
        return null;
      }
    },
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import {
  createSessionRecord,
  listSessions,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js';
import {
  addTask,
  getTask,
  linkSession,
  linkSessionSlot,
  listTasks,
  _resetForTesting as resetTaskManager,
} from '../../../src/core/task-manager.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js';
import { bus } from '../../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import {
  registerSessionManager,
  unregisterSessionManager,
} from '../../../src/providers/session-manager.js';
import { sessionRunner } from '../../../src/providers/claude-code-session.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  taskSlotInterleave.beforeLink = undefined;
  // This router-only fixture deliberately has no SessionRunner. A prior
  // startServer() in the same Vitest worker must not turn its failure-path
  // execute tests into real session starts.
  bus.unsubscribe('session-runner');
  closeSessionDb();
  closeTaskDb();
  _resetSessionTrackerForTesting();
  resetTaskManager();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  taskSlotInterleave.beforeLink = undefined;
  bus.unsubscribe('session-runner');
  closeSessionDb();
  closeTaskDb();
  _resetSessionTrackerForTesting();
  resetTaskManager();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/sessions', () => {
  it('returns empty session list initially', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('returns sessions after creating some', async () => {
    await createSessionRecord('sess-a', 'task-1', 'project-a');
    await createSessionRecord('sess-b', 'task-2', 'project-b');

    const app = createApp();
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });

  it('persists a dead-process liveness correction with a new revision', async () => {
    const created = await createSessionRecord('dead-live-overlay', 'task-1', 'project-a');
    const app = createApp();

    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions[0]).toMatchObject({
      claudeSessionId: 'dead-live-overlay',
      process_status: 'stopped',
      statusRevision: created.statusRevision + 1,
    });
    const stored = (await listSessions())
      .find((session) => session.claudeSessionId === 'dead-live-overlay');
    expect(stored).toMatchObject({
      process_status: 'stopped',
      statusRevision: created.statusRevision + 1,
    });
    expect(stored?.activity).toBeUndefined();
    expect(stored?.statusUpdatedAt).toBe(res.body.sessions[0].statusUpdatedAt);
  });

  it('does not persist remote transport uncertainty as stopped', async () => {
    const created = await createSessionRecord(
      'remote-unreachable-overlay',
      'task-1',
      'project-a',
      undefined,
      { host: 'remote-test' },
    );
    registerSessionManager('remote-unreachable-overlay', {
      isAlive: async () => false,
      detach: () => {},
    } as never);
    const app = createApp();

    try {
      const res = await request(app).get('/api/sessions');

      expect(res.status).toBe(200);
      expect(res.body.sessions[0]).toMatchObject({
        claudeSessionId: 'remote-unreachable-overlay',
        process_status: 'running',
        statusRevision: created.statusRevision,
      });
      const stored = (await listSessions())
        .find((session) => session.claudeSessionId === 'remote-unreachable-overlay');
      expect(stored).toMatchObject({
        process_status: 'running',
        statusRevision: created.statusRevision,
      });
    } finally {
      unregisterSessionManager('remote-unreachable-overlay');
    }
  });
});

describe('GET /api/sessions/status', () => {
  it('returns full snapshots keyed by provider session ID', async () => {
    await createSessionRecord('status-a', 'task-a', 'project-a', undefined, {
      initialProcessStatus: 'idle',
      engine: 'codex',
    });
    await createSessionRecord('status-b', '', 'project-b', undefined, {
      initialProcessStatus: 'stopped',
    });
    const app = createApp();

    const res = await request(app).get('/api/sessions/status?ids=status-a,status-b,missing');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.statuses)).toEqual(['status-a', 'status-b']);
    expect(res.body.statuses['status-a']).toEqual(expect.objectContaining({
      sessionId: 'status-a',
      taskId: 'task-a',
      process_status: 'idle',
      activity: null,
      mode: 'default',
      planCompleted: false,
      archived: false,
      errorMessage: null,
      provider: 'cli',
      engine: 'codex',
      statusRevision: 1,
      statusUpdatedAt: expect.any(String),
    }));
    expect(res.body.statuses['status-b'].taskId).toBeNull();
  });

  it('rejects empty and over-limit hydration requests', async () => {
    const app = createApp();
    expect((await request(app).get('/api/sessions/status')).status).toBe(400);
    const ids = Array.from({ length: 101 }, (_, index) => `status-${index}`).join(',');
    expect((await request(app).get(`/api/sessions/status?ids=${ids}`)).status).toBe(400);
  });

  it('keys snapshots safely for any provider session ID', async () => {
    await createSessionRecord('__proto__', 'task-special', 'project-a');
    const app = createApp();

    const res = await request(app).get('/api/sessions/status?ids=__proto__');

    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body.statuses, '__proto__')).toBe(true);
    expect(res.body.statuses.__proto__.sessionId).toBe('__proto__');
  });
});

describe('GET /api/sessions/working-dirs', () => {
  it('includes all configured hosts even with zero session history', async () => {
    // The launcher's host tabs are built from this response. A freshly added
    // remote host has NO history yet — it must still be offered, otherwise the
    // user can never start that first session (chicken-and-egg).
    const { CONFIG_FILE } = await import('../../../src/constants.js');
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    await fs.writeFile(CONFIG_FILE, [
      'version: 1',
      'hosts:',
      '  freshbox:',
      '    hostname: fresh.example.com',
      '    label: Fresh Box',
      '  unlabeled:',
      '    hostname: unlabeled.example.com',
      '',
    ].join('\n'));

    const app = createApp();
    const res = await request(app).get('/api/sessions/working-dirs');

    expect(res.status).toBe(200);
    expect(res.body.dirs).toEqual([]);
    expect(res.body.hosts).toEqual(expect.arrayContaining([
      { alias: 'freshbox', label: 'Fresh Box' },
      { alias: 'unlabeled', label: 'unlabeled' }, // label falls back to alias
    ]));
  });

  it('returns empty hosts array when no hosts configured', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/working-dirs');

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual([]);
  });
});

describe('GET /api/sessions/recent', () => {
  it('returns recent sessions sorted by lastActiveAt', async () => {
    await createSessionRecord('old-sess', 'task-1', 'proj');
    await new Promise((r) => setTimeout(r, 10));
    await createSessionRecord('new-sess', 'task-2', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].claudeSessionId).toBe('new-sess');
  });

  it('respects limit parameter', async () => {
    await createSessionRecord('s1', 'task-1', 'proj');
    await createSessionRecord('s2', 'task-2', 'proj');
    await createSessionRecord('s3', 'task-3', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/recent?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });
});

describe('GET /api/sessions/summaries', () => {
  it('returns summaries array', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/summaries');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.summaries)).toBe(true);
  });
});

describe('GET /api/sessions/task/:taskId', () => {
  it('returns sessions for a task', async () => {
    await createSessionRecord('s1', 'task-x', 'proj');
    await createSessionRecord('s2', 'task-x', 'proj');
    await createSessionRecord('s3', 'task-y', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/task/task-x');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });

  it('returns empty array for unknown task', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/task/no-such-task');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });
});

describe('PATCH /api/sessions/:sessionId', () => {
  it('updates session title', async () => {
    await createSessionRecord('patch-sess', 'task-1', 'project-a');

    const app = createApp();
    const res = await request(app)
      .patch('/api/sessions/patch-sess')
      .send({ title: 'Fix authentication bug' });

    expect(res.status).toBe(200);
    expect(res.body.session.title).toBe('Fix authentication bug');
    expect(res.body.session.claudeSessionId).toBe('patch-sess');
  });

  it('returns typed 404s for unknown provider/runtime IDs without mutation', async () => {
    const { task } = await addTask({
      title: 'Session identity guard',
      project: 'Walnut',
      source: 'local',
    });
    const providerSessionId = 'known-provider-session';
    const runtimeId = 'known-acp-runtime';
    await createSessionRecord(providerSessionId, task.id, task.project, '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: runtimeId,
      mode: 'bypass',
    });
    await linkSession(task.id, providerSessionId);
    await linkSessionSlot(task.id, providerSessionId, 'exec');

    const sessionsBefore = await listSessions();
    const tasksBefore = await listTasks();
    const app = createApp();

    for (const id of ['unknown-provider-session', runtimeId]) {
      const res = await request(app)
        .patch(`/api/sessions/${id}`)
        .send({
          title: 'must not be written',
          human_note: 'must not be written',
          mode: 'plan',
        });

      expect(res.status, id).toBe(404);
      expect(res.body, id).toEqual({
        code: 'SESSION_NOT_FOUND',
        error: 'session not found',
      });
    }

    expect(await listSessions()).toEqual(sessionsBefore);
    expect(await listTasks()).toEqual(tasksBefore);
    const persistedTask = await getTask(task.id);
    expect(persistedTask.session_id).toBe(providerSessionId);
    expect(persistedTask.exec_session_id).toBe(providerSessionId);
    expect(persistedTask.plan_session_id).toBeUndefined();
  });

  it('rejects non-string title with 400', async () => {
    await createSessionRecord('val-sess', 'task-1', 'project-a');

    const app = createApp();
    const res = await request(app)
      .patch('/api/sessions/val-sess')
      .send({ title: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('title must be a string');
  });

  it('rejects title exceeding 500 chars with 400', async () => {
    await createSessionRecord('long-sess', 'task-1', 'project-a');

    const app = createApp();
    const res = await request(app)
      .patch('/api/sessions/long-sess')
      .send({ title: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('max 500 chars');
  });

  it('compensates when a stale mode change relinks a task after archive cleanup', async () => {
    const { task } = await addTask({
      title: 'Archive slot race',
      project: 'Walnut',
      source: 'local',
    });
    const sessionId = 'archive-mode-race';
    await createSessionRecord(sessionId, task.id, 'Walnut', '/tmp', {
      initialProcessStatus: 'stopped',
      mode: 'bypass',
    });
    await linkSession(task.id, sessionId);
    await linkSessionSlot(task.id, sessionId, 'exec');

    let releasePlanLink!: () => void;
    const planLinkReleased = new Promise<void>((resolve) => {
      releasePlanLink = resolve;
    });
    let markPlanLinkReached!: () => void;
    const planLinkReached = new Promise<void>((resolve) => {
      markPlanLinkReached = resolve;
    });
    taskSlotInterleave.beforeLink = async (taskId, linkedSessionId, slot) => {
      if (taskId === task.id && linkedSessionId === sessionId && slot === 'plan') {
        markPlanLinkReached();
        await planLinkReleased;
      }
    };

    const app = createApp();
    const modeRequest = request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ mode: 'plan' })
      .then((response) => response);

    await planLinkReached;
    const archiveResponse = await request(app)
      .patch(`/api/sessions/${sessionId}`)
      .send({ archived: true, archive_reason: 'test-race' });
    expect(archiveResponse.status).toBe(200);

    // Archive has committed and cleared every slot. Let the stale mode request
    // perform its delayed plan link; the authoritative recheck must clear it.
    releasePlanLink();
    const modeResponse = await modeRequest;

    expect(modeResponse.status).toBe(200);
    expect(modeResponse.body.session).toEqual(expect.objectContaining({
      claudeSessionId: sessionId,
      archived: true,
      mode: 'plan',
    }));
    const persistedTask = await getTask(task.id);
    expect(persistedTask.session_id).toBeUndefined();
    expect(persistedTask.plan_session_id).toBeUndefined();
    expect(persistedTask.exec_session_id).toBeUndefined();
    expect(persistedTask.session_ids).toContain(sessionId);
  });
});

describe('GET /api/sessions/:sessionId/history', () => {
  it('uses the ACP journal projection for both Codex history phases with stable IDs', async () => {
    const journalPath = `${WALNUT_HOME}/journals/runtime-history.acp.jsonl`;
    await fs.mkdir(`${WALNUT_HOME}/journals`, { recursive: true });
    await fs.writeFile(journalPath, [
      JSON.stringify({
        kind: 'meta',
        ts: Date.parse('2026-07-19T12:00:00.000Z'),
        event: {
          type: 'prompt-accepted',
          commandId: 'acp-prompt:qm-history-1',
          walnutMessageId: 'qm-history-1',
          text: 'first exact prompt',
        },
      }),
      JSON.stringify({
        kind: 'acp',
        ts: Date.parse('2026-07-19T12:00:01.000Z'),
        source: 'live',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'first exact answer' },
            },
          },
        },
      }),
      JSON.stringify({
        kind: 'meta',
        ts: Date.parse('2026-07-19T12:00:02.000Z'),
        event: {
          type: 'turn-ended',
          commandId: 'acp-prompt:qm-history-1',
          stopReason: 'end_turn',
        },
      }),
      '',
    ].join('\n'));
    await createSessionRecord('codex-history', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: 'runtime-history',
      acpJournalPath: journalPath,
      messageCount: 2,
    });
    const projected = [
      {
        role: 'user',
        text: 'first exact prompt',
        timestamp: '2026-07-19T12:00:00.000Z',
        msgId: 'acp:runtime-history:acp-prompt:qm-history-1:user',
        walnutMessageId: 'qm-history-1',
      },
      {
        role: 'assistant',
        text: 'first exact answer',
        timestamp: '2026-07-19T12:00:01.000Z',
        msgId: 'acp:runtime-history:acp-prompt:qm-history-1:segment:0',
      },
    ];
    const app = createApp();
    const streams = await request(app).get('/api/sessions/codex-history/history?source=streams');
    const full = await request(app).get('/api/sessions/codex-history/history');

    expect(streams.status).toBe(200);
    expect(streams.body).toEqual({ messages: projected, total: 2 });
    expect(full.status).toBe(200);
    expect(full.body.messages).toEqual(projected);
    expect(full.body.total).toBe(2);
    expect(full.body.cursor).toBe(2);
    expect(full.body.delta).toBe(false);
  });

  it('full-rebuilds a Codex cursor when later chunks grow the same assistant message', async () => {
    const journalPath = `${WALNUT_HOME}/journals/runtime-growing.acp.jsonl`;
    await fs.mkdir(`${WALNUT_HOME}/journals`, { recursive: true });
    const records = [
      {
        kind: 'meta',
        ts: Date.parse('2026-07-19T12:00:00.000Z'),
        event: {
          type: 'prompt-accepted',
          commandId: 'acp-prompt:qm-growing',
          walnutMessageId: 'qm-growing',
          text: 'slow reply',
        },
      },
      {
        kind: 'acp',
        ts: Date.parse('2026-07-19T12:00:01.000Z'),
        source: 'live',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'thinking...' },
            },
          },
        },
      },
    ];
    await fs.writeFile(
      journalPath,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    await createSessionRecord('codex-history-growing', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'running',
      engine: 'codex',
      acpRuntimeId: 'runtime-growing',
      acpJournalPath: journalPath,
      messageCount: 1,
    });

    const app = createApp();
    const partial = await request(app).get('/api/sessions/codex-history-growing/history');
    expect(partial.status).toBe(200);
    expect(partial.body.cursor).toBe(2);
    expect(partial.body.messages[1].text).toBe('thinking...');

    const completion = [
      {
        kind: 'acp',
        ts: Date.parse('2026-07-19T12:00:02.000Z'),
        source: 'live',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'still working...' },
            },
          },
        },
      },
      {
        kind: 'acp',
        ts: Date.parse('2026-07-19T12:00:03.000Z'),
        source: 'live',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'done: slow reply' },
            },
          },
        },
      },
      {
        kind: 'meta',
        ts: Date.parse('2026-07-19T12:00:04.000Z'),
        event: {
          type: 'turn-ended',
          commandId: 'acp-prompt:qm-growing',
          stopReason: 'end_turn',
        },
      },
    ];
    await fs.appendFile(
      journalPath,
      completion.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    await updateSessionRecord('codex-history-growing', { process_status: 'idle' });

    const converged = await request(app)
      .get('/api/sessions/codex-history-growing/history')
      .query({ since: partial.body.cursor });

    expect(converged.status).toBe(200);
    expect(converged.body.delta).toBe(false);
    expect(converged.body.cursor).toBe(2);
    expect(converged.body.messages).toHaveLength(2);
    expect(converged.body.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      text: 'thinking...still working...done: slow reply',
      msgId: 'acp:runtime-growing:acp-prompt:qm-growing:segment:0',
    }));
  });

  it('reports an unavailable Codex journal without claiming a Claude file is missing', async () => {
    await createSessionRecord('codex-history-missing', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: 'runtime-missing',
      acpJournalPath: `${WALNUT_HOME}/journals/runtime-missing.acp.jsonl`,
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions/codex-history-missing/history');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      messages: [],
      total: 0,
      cursor: 0,
      delta: false,
      historyUnavailable: 'Codex session history journal not found',
    });
  });

  it('returns a valid full rebuild for an existing empty Codex journal', async () => {
    const journalPath = `${WALNUT_HOME}/journals/runtime-empty.acp.jsonl`;
    await fs.mkdir(`${WALNUT_HOME}/journals`, { recursive: true });
    await fs.writeFile(journalPath, '');
    await createSessionRecord('codex-history-empty', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: 'runtime-empty',
      acpJournalPath: journalPath,
    });

    const app = createApp();
    const full = await request(app).get('/api/sessions/codex-history-empty/history');
    const delta = await request(app).get('/api/sessions/codex-history-empty/history?since=0');

    expect(full.status).toBe(200);
    expect(full.body).toEqual({
      messages: [],
      total: 0,
      cursor: 0,
      delta: false,
    });
    expect(delta.status).toBe(200);
    expect(delta.body).toEqual({
      messages: [],
      total: 0,
      cursor: 0,
      delta: false,
    });
  });

  it('returns 404 for unknown session with no JSONL file', async () => {
    const app = createApp();
    const res = await request(app).get('/api/sessions/nonexistent-session/history');
    expect(res.status).toBe(404);
  });

  // ── Startup window: a just-launched session has no JSONL for its first
  // seconds (measured on a real launch: history fetched at +0.8s, first JSONL
  // line at +4.8s). Claiming "Session history file not found" there made EVERY
  // task creation flash "History unavailable" in the UI.
  it('does NOT report historyUnavailable for a session still starting up', async () => {
    await createSessionRecord('hist-starting', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions/hist-starting/history');

    expect(res.status).toBe(200);
    expect(res.body.historyUnavailable).toBeUndefined();
    expect(res.body).toEqual({ messages: [], total: 0, cursor: 0, delta: false });
  });

  it('still reports historyUnavailable once the startup window has passed', async () => {
    await createSessionRecord('hist-stale-missing', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'idle',
    });
    // Age both clocks past the 2-minute grace so the missing file is a real fault.
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await updateSessionRecord('hist-stale-missing', {
      startedAt: old,
      last_status_change: old,
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions/hist-stale-missing/history');

    expect(res.status).toBe(200);
    expect(res.body.historyUnavailable).toBe('Session history file not found');
  });

  // ── FORK: a fresh fork's OWN transcript is empty by definition — its whole
  // value is the INHERITED parent conversation. The "nothing to show" verdict was
  // decided BEFORE the fork-ancestor block ran, so a fork both reported
  // "History unavailable" AND never loaded the parent history at all.
  it('serves the inherited parent conversation for a fork whose own transcript is still empty', async () => {
    const parentJournal = `${WALNUT_HOME}/journals/runtime-fork-parent.acp.jsonl`;
    await fs.mkdir(`${WALNUT_HOME}/journals`, { recursive: true });
    await fs.writeFile(parentJournal, [
      JSON.stringify({
        kind: 'meta',
        ts: Date.parse('2026-08-09T12:00:00.000Z'),
        event: {
          type: 'prompt-accepted',
          commandId: 'acp-prompt:qm-fork-parent',
          walnutMessageId: 'qm-fork-parent',
          text: 'parent question',
        },
      }),
      JSON.stringify({
        kind: 'acp',
        ts: Date.parse('2026-08-09T12:00:01.000Z'),
        source: 'live',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'parent answer' },
            },
          },
        },
      }),
      JSON.stringify({
        kind: 'meta',
        ts: Date.parse('2026-08-09T12:00:02.000Z'),
        event: { type: 'turn-ended', commandId: 'acp-prompt:qm-fork-parent', stopReason: 'end_turn' },
      }),
      '',
    ].join('\n'));
    await createSessionRecord('fork-parent', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: 'runtime-fork-parent',
      acpJournalPath: parentJournal,
      messageCount: 2,
    });
    // The fork itself: no journal on disk yet (just spawned), points at the parent.
    await createSessionRecord('fork-child', 'task-2', 'project-a', '/tmp', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
      engine: 'codex',
      acpRuntimeId: 'runtime-fork-child',
      acpJournalPath: `${WALNUT_HOME}/journals/runtime-fork-child.acp.jsonl`,
      forkedFromSessionId: 'fork-parent',
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions/fork-child/history');

    expect(res.status).toBe(200);
    // The regression: the parent conversation must be PRESENT, not "unavailable".
    expect(res.body.historyUnavailable).toBeUndefined();
    expect(res.body.messages.map((m: { text: string }) => m.text))
      .toEqual(['parent question', 'parent answer']);
    expect(res.body.forkedFromSessionId).toBe('fork-parent');
    // Everything shown belongs to the ancestor, so the boundary sits at the end.
    expect(res.body.forkBoundaryIndex).toBe(2);
  });

  it('does NOT report historyUnavailable for a starting fork whose parent is also empty', async () => {
    await createSessionRecord('fork-empty-parent', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'stopped',
    });
    await createSessionRecord('fork-empty-child', 'task-2', 'project-a', '/tmp', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
      forkedFromSessionId: 'fork-empty-parent',
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions/fork-empty-child/history');

    expect(res.status).toBe(200);
    expect(res.body.historyUnavailable).toBeUndefined();
    expect(res.body.messages).toEqual([]);
  });

  it('still explains itself for an OLD fork with no transcript anywhere', async () => {
    // The deferred verdict must still fire — a fork is not a blanket excuse.
    await createSessionRecord('fork-old-parent', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'stopped',
    });
    await createSessionRecord('fork-old-child', 'task-2', 'project-a', '/tmp', {
      initialProcessStatus: 'idle',
      forkedFromSessionId: 'fork-old-parent',
    });
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await updateSessionRecord('fork-old-child', { startedAt: old, last_status_change: old });

    const app = createApp();
    const res = await request(app).get('/api/sessions/fork-old-child/history');

    expect(res.status).toBe(200);
    expect(res.body.historyUnavailable).toBe('Session history file not found');
  });

  it('reports historyUnavailable immediately for a terminal session that never wrote a transcript', async () => {
    // A stopped/errored session with no transcript is a REAL fault — it must not
    // be hidden behind the startup grace window.
    await createSessionRecord('hist-dead-missing', 'task-1', 'project-a', '/tmp', {
      initialProcessStatus: 'stopped',
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions/hist-dead-missing/history');

    expect(res.status).toBe(200);
    expect(res.body.historyUnavailable).toBe('Session history file not found');
  });

  it('returns messages for a known session', async () => {
    // Create session record first
    await createSessionRecord('hist-session', 'task-1', 'project-a');

    const app = createApp();
    // Even without JSONL file, should return 200 with empty messages (record exists)
    const res = await request(app).get('/api/sessions/hist-session/history');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  // ── Delta mode (?since=<N>) — the turn-boundary incremental path ──
  it('full (no since) response carries a cursor + delta:false', async () => {
    await createSessionRecord('hist-delta-1', 'task-1', 'project-a');
    const app = createApp();
    const res = await request(app).get('/api/sessions/hist-delta-1/history');
    expect(res.status).toBe(200);
    // No JSONL → 0 messages, but the cursor contract must still be present.
    expect(res.body.cursor).toBe(0);
    expect(res.body.delta).toBe(false);
    expect(res.body.total).toBe(0);
  });

  it('?since=0 on an empty session returns an empty delta (delta:true, cursor:0)', async () => {
    // Empty archive: nothing flushed yet. A client that already synced 0 messages
    // asks "what's new since 0?" — the answer is an empty slice, delta:true. The
    // client must treat this as "archive lagging, keep streaming blocks", NOT as a
    // signal to clear. (This is the exact no-op the anti-vanish fix relies on.)
    await createSessionRecord('hist-delta-2', 'task-1', 'project-a');
    const app = createApp();
    const res = await request(app).get('/api/sessions/hist-delta-2/history?since=0');
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(true);
    expect(res.body.messages).toEqual([]);
    expect(res.body.cursor).toBe(0);
  });

  it('?since greater than total falls back to a full payload (delta:false) — never a silent drop', async () => {
    // Client cursor ahead of the archive (file rotated / rebuilt). The server must
    // NOT return an empty delta (which would strand the client); it rebuilds from
    // scratch with delta:false so the client does a full replace.
    await createSessionRecord('hist-delta-3', 'task-1', 'project-a');
    const app = createApp();
    const res = await request(app).get('/api/sessions/hist-delta-3/history?since=999');
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(false);
    expect(res.body.cursor).toBe(0); // total messages (0 without JSONL)
  });
});

describe('POST /api/sessions/:sessionId/fork', () => {
  it('fails closed for Codex before creating a child task', async () => {
    const { task } = await addTask({
      title: 'Codex fork source',
      project: 'Walnut',
      source: 'local',
    });
    await createSessionRecord('codex-no-fork', task.id, 'Walnut', '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: 'acp-no-fork',
    });
    const beforeIds = (await listTasks()).map((t) => t.id).sort();
    const beforeSessions = (await listSessions()).map((session) => session.claudeSessionId).sort();

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/codex-no-fork/fork')
      .send({ create_child_task: true, message: 'Do not mutate tasks' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'ACP_FORK_UNSUPPORTED',
      error: 'Fork is unavailable for this Codex session',
    });
    expect((await listTasks()).map((t) => t.id).sort()).toEqual(beforeIds);
    expect((await listSessions()).map((session) => session.claudeSessionId).sort()).toEqual(beforeSessions);
  });
});

describe('POST /api/sessions/:sessionId/execute', () => {
  it('does not throw "record is not defined" for plan sessions', async () => {
    // Create a plan session with planCompleted + planFile
    const planFilePath = `${WALNUT_HOME}/test-plan.md`;
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    await fs.writeFile(planFilePath, '# Test Plan\n1. Step one\n2. Step two\n');

    await createSessionRecord('plan-sess-1', 'task-1', 'my-project', '/tmp', {
      mode: 'plan',
      planFile: planFilePath,
      planCompleted: true,
    });

    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord('plan-sess-1', { process_status: 'stopped' });

    const app = createApp();
    expect(bus.has('session-runner')).toBe(false);
    const res = await request(app)
      .post('/api/sessions/plan-sess-1/execute')
      .send({})
      .timeout(35_000); // endpoint waits up to 30s for session runner

    // No session runner in test env → new session never starts → 502 with timeout error.
    // The key assertion: no "record is not defined" ReferenceError (the original bug).
    // Plan session is preserved (not archived) so user can retry.
    expect(res.body.error ?? '').not.toContain('record is not defined');
    expect(res.status).toBe(502);
    expect(res.body.planPreserved).toBe(true);
    expect(res.body.planSessionId).toBe('plan-sess-1');
  }, 40_000);

  it('does not throw "record is not defined" for execution sessions re-executing', async () => {
    // Create the original plan session
    const planFilePath = `${WALNUT_HOME}/test-plan-2.md`;
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    await fs.writeFile(planFilePath, '# Plan\nDo stuff\n');

    await createSessionRecord('orig-plan', 'task-1', 'my-project', '/tmp', {
      mode: 'plan',
      planFile: planFilePath,
      planCompleted: true,
    });

    // Create an execution session that points back to the plan session
    await createSessionRecord('exec-sess-1', 'task-1', 'my-project', '/tmp', {
      mode: 'bypass',
      fromPlanSessionId: 'orig-plan',
    });

    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord('exec-sess-1', { process_status: 'stopped' });

    const app = createApp();
    expect(bus.has('session-runner')).toBe(false);
    const res = await request(app)
      .post('/api/sessions/exec-sess-1/execute')
      .send({})
      .timeout(35_000);

    // Must NOT crash with "record is not defined" — 502 timeout is expected (no session runner in test)
    expect(res.body.error ?? '').not.toContain('record is not defined');
    expect(res.status).toBe(502);
    expect(res.body.planPreserved).toBe(true);
  }, 40_000);
});

// ── Session id prefix resolution ──
//
// Regression: the UI renders only the first 8 chars of a session id (chips,
// "Session <id> finished" notifications), so that truncated string reaches
// GET /api/sessions/:id via deep links. Exact-match-only lookup answered 404,
// SessionPanel retried 30x/500ms (~15s) and then left a dead column in
// sessionStorage that replayed the loop on every reload — observed as 144 404s
// for one id, and reported as "new sessions are broken" even though the session
// existed and was running the whole time.
describe('GET /api/sessions/:sessionId — Codex cold attach', () => {
  it('uses an attached worker empty result instead of a stale durable permission', async () => {
    await createSessionRecord('codex-live-empty', 'task-live', 'project-a', '/tmp', {
      initialProcessStatus: 'running',
      engine: 'codex',
      acpRuntimeId: 'runtime-live-empty',
      title: 'Live Codex title',
    });
    await updateSessionRecord('codex-live-empty', {
      pendingPermission: {
        requestId: 'perm-stale',
        toolName: 'Stale tool',
        receivedAt: '2026-08-18T00:00:00.000Z',
      },
    });
    vi.spyOn(sessionRunner, 'findAcpSession').mockReturnValue({
      getPendingPermissionRequests: () => [],
    } as never);
    const attach = vi.spyOn(sessionRunner, 'findOrAttachAcpSession');

    const response = await request(createApp()).get('/api/sessions/codex-live-empty');

    expect(response.status).toBe(200);
    expect(response.body.pendingPermissions).toEqual([]);
    expect(attach).not.toHaveBeenCalled();
  });

  it('returns durable metadata and permission without waiting for session/load', async () => {
    await createSessionRecord('codex-cold-detail', 'task-cold', 'project-a', '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'runtime-cold-detail',
      title: 'Saved Codex title',
    });
    await updateSessionRecord('codex-cold-detail', {
      pendingPermission: {
        requestId: 'perm-cold',
        toolName: 'Write file /tmp/mock.txt',
        input: { path: '/tmp/mock.txt' },
        acpOptions: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
        receivedAt: '2026-08-18T00:00:00.000Z',
      },
    });
    vi.spyOn(sessionRunner, 'findAcpSession').mockReturnValue(undefined);
    const attach = vi.spyOn(sessionRunner, 'findOrAttachAcpSession')
      .mockReturnValue(new Promise<never>(() => {}));

    const response = await Promise.race([
      request(createApp()).get('/api/sessions/codex-cold-detail'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('detail blocked on cold attach')), 2_000)),
    ]);

    expect(response.status).toBe(200);
    expect(response.body.session.title).toBe('Saved Codex title');
    expect(response.body.pendingPermissions).toEqual([{
      requestId: 'perm-cold',
      toolName: 'Write file /tmp/mock.txt',
      input: { path: '/tmp/mock.txt' },
      acpOptions: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
    }]);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith('codex-cold-detail');
  });
});

describe('GET /api/sessions/:sessionId — id prefix resolution', () => {
  const FULL = '8f3095b3-abfc-47d7-93db-e1ba726151e8';

  it('resolves a unique 8-char prefix to the canonical session', async () => {
    await createSessionRecord(FULL, 'task-1', 'project-a');
    const app = createApp();

    const res = await request(app).get('/api/sessions/8f3095b3');

    expect(res.status).toBe(200);
    // Canonical id comes back so the client can adopt it (streams/RPCs are keyed
    // by the full id, so it must stop using the prefix).
    expect(res.body.session.claudeSessionId).toBe(FULL);
  });

  it('still resolves the full id exactly', async () => {
    await createSessionRecord(FULL, 'task-1', 'project-a');
    const app = createApp();

    const res = await request(app).get(`/api/sessions/${FULL}`);

    expect(res.status).toBe(200);
    expect(res.body.session.claudeSessionId).toBe(FULL);
  });

  it('404s an unknown prefix', async () => {
    await createSessionRecord(FULL, 'task-1', 'project-a');
    const app = createApp();

    const res = await request(app).get('/api/sessions/deadbeef');

    expect(res.status).toBe(404);
  });

  it('409s an ambiguous prefix rather than guessing', async () => {
    await createSessionRecord('abcd1234-0000-0000-0000-000000000001', 'task-1', 'p');
    await createSessionRecord('abcd1234-0000-0000-0000-000000000002', 'task-2', 'p');
    const app = createApp();

    const res = await request(app).get('/api/sessions/abcd1234');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SESSION_ID_AMBIGUOUS');
  });

  it('refuses a prefix shorter than 8 chars (too weak to guess from)', async () => {
    await createSessionRecord(FULL, 'task-1', 'project-a');
    const app = createApp();

    const res = await request(app).get('/api/sessions/8f30');

    expect(res.status).toBe(404);
  });

  it('does not treat LIKE wildcards as a prefix match', async () => {
    await createSessionRecord(FULL, 'task-1', 'project-a');
    const app = createApp();

    // '%' / '_' would match everything if interpolated into LIKE unescaped.
    expect((await request(app).get('/api/sessions/8f3095b_')).status).toBe(404);
    expect((await request(app).get(`/api/sessions/${encodeURIComponent('8f3095b%')}`)).status).toBe(404);
  });
});
