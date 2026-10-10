/**
 * /api/v1 session launch (additive) — mobile "create a session" endpoints.
 *
 *   GET  /sessions/launch-options: primary-box hosts list ('' = Mac + enabled
 *        config.hosts entries, disabled filtered out) + frequent-dir
 *        suggestions in the web launcher's score order.
 *   POST /sessions: task create + SESSION_START emit through the shared
 *        quickStartSession core, host allowlist validation, taskId link mode,
 *        frozen error envelope on every failure.
 *
 * POST /delegate is GONE (its describe block with it): creating a task and
 * starting a session are two calls now — task_create then session_start
 * (POST /tasks/:id/start, covered by tests/web/task-start-host-inheritance.test.ts).
 *
 * Same harness as quick-start-model-validation.test.ts: mounted routers +
 * supertest, session-runner side effects mocked away, SESSION_START captured
 * off the bus.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
  getDaemonConnection: async () => ({ send: async () => ({ ok: true }) }),
  // The Start gate reads the host's frame: an idle host (never dialed) goes ahead.
  getDaemonConnectState: (host: string) => ({ host, connected: false, phase: 'idle', phaseElapsedMs: 0, connectElapsedMs: 0 }),
  cancelReconnectBackoff: () => false,
}));
// The real gate, with its inputs recorded: a phone launch must carry its own budget.
const gateInputs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../src/core/sessions/host-start-gate.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/host-start-gate.js')>();
  return { ...real, hostStartGate: (input: Parameters<typeof real.hostStartGate>[0], deps?: Parameters<typeof real.hostStartGate>[1]) => { gateInputs.push(input as never); return real.hostStartGate(input, deps); } };
});
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));
// Keep the machine's real ~/.ssh/config out of the hosts assertion.
vi.mock('../../../src/core/ssh-config-scanner.js', () => ({
  scanSshConfig: async () => new Map(),
}));

import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { sessionLaunchV1Router } from '../../../src/web/routes/session-launch-v1.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, getTask, _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { getSessionByClaudeId } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import type { BusEvent } from '../../../src/core/event-bus.js';
import { recordDirectory } from '../../../src/core/frequent-dirs.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', sessionLaunchV1Router);
  app.use(errorHandler);
  return app;
}

async function writeHostsConfig(): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, [
    'hosts:',
    '  devbox:',
    '    hostname: devbox.example.com',
    '    label: Dev Box',
    '  cloudbox:',
    '    hostname: cloud.example.com',
    '  retired:',
    '    hostname: old.example.com',
    '    enabled: false',
    '',
  ].join('\n'), 'utf-8');
}

let starts: BusEvent[];

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetTaskManager();
  bus.clear();
  starts = [];
  bus.subscribe('session-runner', (e) => { if (e.name === EventNames.SESSION_START) starts.push(e); });
});

afterEach(async () => {
  bus.clear();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/v1/sessions/launch-options', () => {
  it('returns the primary box + enabled hosts, and scored dir suggestions', async () => {
    await writeHostsConfig();
    await recordDirectory('/Users/me/proj-a', null);
    await recordDirectory('/Users/me/proj-a', null);
    await recordDirectory('/workplace/remote-proj', 'devbox');

    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);

    const aliases = (res.body.hosts as Array<{ alias: string; label: string }>).map((h) => h.alias);
    expect(aliases).toEqual(['', 'devbox', 'cloudbox']); // '' first, 'retired' filtered
    expect(res.body.hosts[0].label).toBe('This Mac');
    expect(res.body.hosts[1].label).toBe('Dev Box'); // label from config
    expect(res.body.hosts[2].label).toBe('cloudbox'); // alias fallback

    const dirs = res.body.dirs as Array<{ cwd: string; host: string; count: number }>;
    expect(dirs.length).toBe(2);
    const local = dirs.find((d) => d.cwd === '/Users/me/proj-a');
    expect(local?.host).toBe(''); // null host normalized to '' for mobile
    expect(local?.count).toBe(2);
    expect(dirs.find((d) => d.cwd === '/workplace/remote-proj')?.host).toBe('devbox');
  });

  it('works with no hosts configured and no history', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual([{ alias: '', label: 'This Mac' }]);
    expect(res.body.dirs).toEqual([]);
  });

  it('orders dirs by the shared launcher score (recency-dominant)', async () => {
    // Same count, different recency: the more recent dir must rank first
    // (recency carries 70% of the score). Then a heavily-used old dir vs a
    // once-used fresh dir: freshness still wins at 5x count difference
    // because 0.3 freq weight < 0.7 recency weight.
    const { recordDirectory: rec } = await import('../../../src/core/frequent-dirs.js');
    for (let i = 0; i < 5; i++) await rec('/old/heavy', null);
    await rec('/new/light', null);
    // Backdate the heavy dir by rewriting the store (lastUsed is write-time).
    const { FREQUENT_DIRS_FILE } = await import('../../../src/constants.js');
    const store = JSON.parse(await fs.readFile(FREQUENT_DIRS_FILE, 'utf-8'));
    for (const d of store.directories) {
      if (d.cwd === '/old/heavy') d.lastUsed = new Date(Date.now() - 30 * 86_400_000).toISOString();
    }
    await fs.writeFile(FREQUENT_DIRS_FILE, JSON.stringify(store));

    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);
    const cwds = (res.body.dirs as Array<{ cwd: string }>).map((d) => d.cwd);
    expect(cwds).toEqual(['/new/light', '/old/heavy']);
  });

  it('filters out count-0 placeholder rows and dirs on unoffered hosts', async () => {
    await writeHostsConfig();
    await recordDirectory('/Users/me/real-proj', null);
    // count-0 placeholder: recordLaunchPrefs on a dir that never launched —
    // its fresh lastUsed would otherwise rank it TOP (and the sheet
    // preselects rank #1 as the default path).
    const { recordLaunchPrefs } = await import('../../../src/core/frequent-dirs.js');
    await recordLaunchPrefs('/Users/me/never-launched', null, { model: 'opus' });
    // dir on a disabled host: unlaunchable, must not eat a suggestion slot
    await recordDirectory('/on/retired/box', 'retired');

    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);
    const cwds = (res.body.dirs as Array<{ cwd: string }>).map((d) => d.cwd);
    expect(cwds).toEqual(['/Users/me/real-proj']);
  });
});

describe('POST /api/v1/sessions', () => {
  it('201: creates a task, seeds the session record, emits SESSION_START', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/my-proj', message: 'fix the bug' });
    expect(res.status).toBe(201);
    expect(typeof res.body.sessionId).toBe('string');
    expect(typeof res.body.taskId).toBe('string');
    expect(res.body.title).toBe('Session: my-proj');

    expect(starts.length).toBe(1);
    const data = starts[0].data as Record<string, unknown>;
    expect(data.cwd).toBe('/tmp/my-proj');
    expect(data.message).toBe('fix the bug');
    expect(data.host).toBeUndefined();
    expect(data.preassignedSessionId).toBe(res.body.sessionId);

    // Pre-seeded record: the app's conversation view reads it immediately.
    const record = await getSessionByClaudeId(res.body.sessionId);
    expect(record?.taskId).toBe(res.body.taskId);
    expect(record?.process_status).toBe('idle');
  });

  // The phone's voice mode launches with a spoken first message: the CLI also gets
  // the voice-reply line after it, and nothing that NAMES the work reads it.
  it('voice:true appends the voice-reply line to the first message only', async () => {
    const { VOICE_REPLY_INSTRUCTION } = await import('../../../src/core/sessions/voice-reply.js');
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/voice-proj', message: 'what is still open today', voice: true });
    expect(res.status).toBe(201);
    const data = starts[0].data as Record<string, unknown>;
    expect(data.message).toBe(`what is still open today\n\n${VOICE_REPLY_INSTRUCTION}`);
    expect(res.body.title).not.toContain('Voice reply');

    const bad = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/voice-proj', message: 'x', voice: 1 });
    expect(bad.status).toBe(400);
    expect(starts.length).toBe(1);

    // An empty launch carries nothing at all (no first turn to answer).
    const empty = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/voice-proj', message: '', voice: true });
    expect(empty.status).toBe(201);
    expect((starts[1].data as Record<string, unknown>).message).toBe('');
  });

  // The phone's New Session page has no tier control, like the web draft column,
  // so its task is born where the web draft's is: Focus. The launch core's own
  // default (Satellite) put every phone session out of the user's first view.
  it('a task-less phone launch is born pinned in Focus, like the web draft', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/my-proj', message: 'fix the bug' });
    expect(res.status).toBe(201);
    const task = await getTask(res.body.taskId);
    expect(task.pinned).toBe(true);
    expect(task.focus_tier).toBe('focus');
  });

  it("a launch from an existing task keeps that task's tier", async () => {
    const { task } = await addTask({ title: 'Satellite work', project: 'Quick Start', pinned: true });
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/y', taskId: task.id, message: 'continue' });
    expect(res.status).toBe(201);
    const after = await getTask(task.id);
    // undefined = Satellite, the store's default tier for a pinned task.
    expect(after.focus_tier ?? 'satellite').toBe('satellite');
  });

  it('keeps the frozen mobile response shape when an engine field is present', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/mobile-contract', message: 'start', engine: 'codex' });

    expect(res.status).toBe(201);
    expect(typeof res.body.sessionId).toBe('string');
    expect(starts[0].data).toMatchObject({ preassignedSessionId: res.body.sessionId });
    expect((starts[0].data as Record<string, unknown>).engine).toBeUndefined();
  });

  it('201 with a valid config.hosts alias — SESSION_START carries the host', async () => {
    await writeHostsConfig();
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/workplace/x', host: 'devbox', message: '' });
    expect(res.status).toBe(201);
    expect((starts[0].data as Record<string, unknown>).host).toBe('devbox');
    // A phone request sits behind a relay and a mobile network: the gate gets ~10s, not the web's 25s.
    expect(gateInputs.at(-1)).toMatchObject({ host: 'devbox', source: 'human', deadlineMs: 10_000 });
  });

  it("host '' is the primary box (same as absent)", async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/local-proj', host: '', message: 'hi' });
    expect(res.status).toBe(201);
    expect((starts[0].data as Record<string, unknown>).host).toBeUndefined();
  });

  // Was 400 bad_request before 2026-09: now the gate's own code, same as the web launcher.
  it('409 host_removed for an unknown or disabled host, with the gate body', async () => {
    await writeHostsConfig();
    for (const host of ['nosuch', 'retired']) {
      const res = await request(createApp())
        .post('/api/v1/sessions')
        .send({ cwd: '/tmp/x', host, message: '' });
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: 'host_removed', message: 'This host is no longer in Settings.' });
      expect(res.body).toMatchObject({ host, headline: 'This host is no longer in Settings.', hint: '' });
    }
    expect(starts.length).toBe(0);
  });

  it('the bridge relay answer for a refused host carries the gate code and its fields (no bare 400 kind)', async () => {
    await writeHostsConfig();
    const { handleLaunchRelayRequest } = await import('../../../src/core/sessions/mobile-launch.js');
    const out = await handleLaunchRelayRequest('launch', { cwd: '/tmp/x', host: 'retired', message: '' });
    expect(out).toEqual({
      ok: false, error: 'This host is no longer in Settings.', errorKind: 'host_removed',
      details: { host: 'retired', headline: 'This host is no longer in Settings.', hint: '' },
    });
    expect(starts.length).toBe(0);
  });

  it('taskId links the session to an existing task instead of creating one', async () => {
    const { task } = await addTask({ title: 'Existing work', project: 'Quick Start' });
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/y', taskId: task.id, message: 'continue' });
    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe(task.id);
    expect(res.body.title).toBe('Existing work');
    const after = await getTask(task.id);
    expect(after.id).toBe(task.id); // reused, not duplicated
  });

  it('404 not_found for an unknown taskId', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/z', taskId: 'task-does-not-exist', message: '' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('400 bad_request when cwd is missing/blank/relative', async () => {
    for (const body of [{}, { cwd: '' }, { cwd: '   ' }, { cwd: 42 }, { cwd: 'relative/path' }, { cwd: '~/home-ish' }]) {
      const res = await request(createApp()).post('/api/v1/sessions').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    }
    expect(starts.length).toBe(0);
  });

  it('retry mode archives the task\'s error/stopped sessions to free the slot', async () => {
    const { task } = await addTask({ title: 'Retry me', project: 'Quick Start' });
    const { createSessionRecord, getSessionByClaudeId: readRecord, updateSessionRecord } =
      await import('../../../src/core/session-tracker.js');
    await createSessionRecord('dead-session-0001', task.id, 'Quick Start', '/tmp/y', { title: 'Retry me' });
    await updateSessionRecord('dead-session-0001', { process_status: 'error' });

    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/y', taskId: task.id, message: 'again' });
    expect(res.status).toBe(201);
    const archived = await readRecord('dead-session-0001');
    expect(archived?.archived).toBe(true);
    expect(archived?.archive_reason).toBe('retry');
  });

  it('400 bad_request for a bad mode; valid mode rides SESSION_START', async () => {
    const bad = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/m', mode: 'yolo' });
    expect(bad.status).toBe(400);

    const ok = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/m', mode: 'plan' });
    expect(ok.status).toBe(201);
    expect((starts[0].data as Record<string, unknown>).mode).toBe('plan');
  });

  it('400 bad_request for garbage model; alias resolves to CLI form', async () => {
    const bad = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/mm', model: 'not-a-model!!' });
    expect(bad.status).toBe(400);

    const ok = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/mm', model: 'opus-1m' });
    expect(ok.status).toBe(201);
    expect((starts[0].data as Record<string, unknown>).model).toBe('opus[1m]');
  });
});
