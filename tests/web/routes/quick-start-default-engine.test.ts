/**
 * `config.defaults.engine` — the engine a Walnut-initiated launch inherits.
 *
 * Slice S0. What is pinned here:
 *   1. With no config key, a launch is byte-identical to before: SESSION_START
 *      carries NO engine (the storage/wire contract keeps the default absent)
 *      and the route still answers with a preassigned session id.
 *   2. With `defaults.engine: 'codex'`, a launch that names no engine runs on
 *      codex — and the route stops preassigning an id, because an ACP engine
 *      issues its own (a returned id that never exists parks the client panel
 *      on "Untitled session" forever).
 *   3. An engine named by the caller always wins over the config.
 *   4. A walnutAgent ("Ask Walnut") launch is no longer rejected on an ACP
 *      engine: the persona rides the FIRST MESSAGE there (ACP has no
 *      system-prompt channel) instead of the spawn profile, and the native path
 *      is untouched.
 *   5. A caller that minted its own session id keeps it: the inheritance yields
 *      to that promise rather than handing back a dead id (the frozen /api/v1
 *      launch, the notification repair, a subagent runId).
 *   6. Garbage in the config degrades to the default instead of failing launches.
 *   7. A launch that prepends anything to the message (the ACP persona here)
 *      carries the human's own words alongside it, so the session is named after
 *      the request and not after its own configuration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-default-engine'));

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
}));
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));
vi.mock('../../../src/core/session-message-queue.js', () => ({
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false,
  sendMessageToSession: async () => {},
  getQueue: async () => [],
  revertToPending: async () => {},
}));

// The ONE knob these cases turn. Merged onto the REAL config (task-manager reads
// defaults.priority etc., so a bare replacement 500s every launch).
const configuredEngine = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/config-manager.js')>();
  return {
    ...mod,
    getConfig: async () => {
      const base = await mod.getConfig();
      return {
        ...base,
        defaults: {
          ...base.defaults,
          ...(configuredEngine.value !== undefined ? { engine: configuredEngine.value } : {}),
        },
      };
    },
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { getSessionByClaudeId } from '../../../src/core/session-tracker.js';
import { quickStartSession } from '../../../src/core/sessions/quick-start.js';
import { ASK_PROFILE_BANNER_OPEN } from '../../../src/core/sessions/ask-profile-prefix.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

/** Every SESSION_START payload emitted while subscribed (as 'session-runner'). */
function captureStarts(): { all: () => Record<string, unknown>[]; last: () => Record<string, unknown>; dispose: () => void } {
  const payloads: Record<string, unknown>[] = [];
  bus.subscribe('session-runner', (event) => {
    if (event.name === EventNames.SESSION_START) payloads.push(event.data as Record<string, unknown>);
  });
  return {
    all: () => payloads,
    last: () => {
      expect(payloads.length).toBeGreaterThan(0);
      return payloads[payloads.length - 1]!;
    },
    dispose: () => bus.unsubscribe('session-runner'),
  };
}

let capture: ReturnType<typeof captureStarts>;

beforeEach(async () => {
  configuredEngine.value = undefined;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  capture = captureStarts();
});

afterEach(async () => {
  capture.dispose();
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('POST /api/sessions/quick-start — defaults.engine inheritance', () => {
  it('no config key: the launch is unchanged (no engine on the wire, an id is preassigned)', async () => {
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/no-default', message: 'hello', project: 'Walnut' });

    expect(res.status).toBe(200);
    expect(typeof res.body.sessionId).toBe('string');
    const started = capture.last();
    // The default engine is never written out — this is the byte-identical case.
    expect(started.engine).toBeUndefined();
    expect(started.preassignedSessionId).toBe(res.body.sessionId);
    // And the record is seeded up front, as it always was for a native launch.
    expect((await getSessionByClaudeId(res.body.sessionId))?.taskId).toBe(res.body.taskId);
  });

  it("defaults.engine 'codex': a launch that names none runs on codex and gets no preassigned id", async () => {
    configuredEngine.value = 'codex';
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/inherits-codex', message: 'hello', project: 'Walnut' });

    expect(res.status).toBe(200);
    const started = capture.last();
    expect(started.engine).toBe('codex');
    // An ACP engine mints its own id inside the adapter: neither the answer nor
    // the event may carry one, or the client waits on a session that never exists.
    expect(res.body.sessionId).toBeUndefined();
    expect(started.preassignedSessionId).toBeUndefined();
  });

  it('an engine named by the caller wins over the config, in both directions', async () => {
    configuredEngine.value = 'codex';
    const app = createApp();

    const claude = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/explicit-claude', message: 'hi', project: 'Walnut', engine: 'claude' });
    expect(claude.status).toBe(200);
    expect(capture.last().engine).toBeUndefined();
    expect(typeof claude.body.sessionId).toBe('string');

    configuredEngine.value = undefined;
    const codex = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/explicit-codex', message: 'hi', project: 'Walnut', engine: 'codex' });
    expect(codex.status).toBe(200);
    expect(capture.last().engine).toBe('codex');
  });

  it('a garbage config value degrades to the default instead of failing the launch', async () => {
    configuredEngine.value = 'codx';
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/garbage-default', message: 'hello', project: 'Walnut' });

    expect(res.status).toBe(200);
    expect(capture.last().engine).toBeUndefined();
    expect(typeof res.body.sessionId).toBe('string');
  });

  it('an unknown engine in the BODY is still a 400 (the config default never launders it)', async () => {
    configuredEngine.value = 'codex';
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/bad-body-engine', message: 'hello', engine: 'gemni' });
    expect(res.status).toBe(400);
    expect(capture.all().length).toBe(0);
  });
});

describe('POST /api/sessions/quick-start — walnutAgent on an ACP engine', () => {
  it('accepts the launch and carries the persona on the first message instead of the profile', async () => {
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'what do I have today?', walnutAgent: true, engine: 'codex' });

    // Used to be a hard 400 ("walnutAgent requires the claude engine").
    expect(res.status).toBe(200);
    const started = capture.last();
    expect(started.engine).toBe('codex');
    // The bundle rides the message, and the message itself is still there.
    const message = started.message as string;
    expect(message.startsWith(ASK_PROFILE_BANNER_OPEN)).toBe(true);
    expect(message.endsWith('what do I have today?')).toBe(true);
    // ACP has no channel for either of these, so neither is forwarded.
    expect(started.profile).toBeUndefined();
    expect(started.effort).toBeUndefined();
    // Still an ordinary ask: its own project and the Personal-AI marker.
    expect(res.body.task.project).toBe('Ask Walnut');
    expect(res.body.task.walnut_agent).toBe(true);
  });

  it('inherits the ACP engine when the ask names none (the slot sends no engine)', async () => {
    configuredEngine.value = 'codex';
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'hello', walnutAgent: true });

    expect(res.status).toBe(200);
    const started = capture.last();
    expect(started.engine).toBe('codex');
    expect((started.message as string).startsWith(ASK_PROFILE_BANNER_OPEN)).toBe(true);
  });

  it('the native ask is unchanged: profile on the spawn, nothing prepended to the message', async () => {
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'what do I have today?', walnutAgent: true });

    expect(res.status).toBe(200);
    const started = capture.last();
    expect(started.engine).toBeUndefined();
    expect(started.message).toBe('what do I have today?');
    expect((started.profile as { systemPrompt?: string } | undefined)?.systemPrompt).toBeTruthy();
    expect(started.effort).toBeTruthy();
  });

  it('names the session after the request, not after the persona it wrapped it in', async () => {
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'what do I have today?', walnutAgent: true, engine: 'codex' });

    expect(res.status).toBe(200);
    const started = capture.last();
    // The wire message leads with the profile banner; the naming text does not.
    // Without this the session is titled "[Walnut agent profile] You are the
    // agent described below…" and its description is 500 characters of persona.
    expect(started.namingMessage).toBe('what do I have today?');
    expect((started.message as string).startsWith(ASK_PROFILE_BANNER_OPEN)).toBe(true);
  });

  it('marks the launch as a Walnut agent so the ACP runner mounts Walnut tools', async () => {
    configuredEngine.value = 'codex';
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'what do I have today?', walnutAgent: true });

    expect(res.status).toBe(200);
    // ACP carries no profile, so this flag is the only thing that can tell the
    // runner an ACP ask needs Walnut's own tools (buildAcpStartExtras).
    expect(capture.last().walnutAgent).toBe(true);
  });

  it('marks the native ask too, where the profile also says so', async () => {
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'what do I have today?', walnutAgent: true });

    expect(res.status).toBe(200);
    // Honest about what the launch is on both engines; the native path already
    // gets its tools from the profile and ignores the flag.
    expect(capture.last().walnutAgent).toBe(true);
  });

  it('leaves the flag off a plain coding launch', async () => {
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/plain-launch', message: 'fix the failing test', project: 'Walnut' });

    expect(res.status).toBe(200);
    expect('walnutAgent' in capture.last()).toBe(false);
  });

  it('sends no naming text when nothing was prepended, so every other launch is byte-identical', async () => {
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'what do I have today?', walnutAgent: true });

    expect(res.status).toBe(200);
    const started = capture.last();
    expect(started.message).toBe('what do I have today?');
    // Absent, not equal-to-message: the payload must not grow a field for the
    // callers that never needed one.
    expect('namingMessage' in started).toBe(false);
  });

  it('still refuses a remote ask (the Personal AI runs where the server runs)', async () => {
    configuredEngine.value = 'codex';
    const res = await request(createApp())
      .post('/api/sessions/quick-start')
      .send({ message: 'hello', walnutAgent: true, host: 'devbox' });
    expect(res.status).toBe(400);
  });
});

describe('quickStartSession — inheritance vs a promised session id', () => {
  it('keeps a caller-minted id and stays native, rather than handing back a dead id', async () => {
    configuredEngine.value = 'codex';
    // What the frozen /api/v1 launch, the notification repair and a subagent run
    // all do: mint the id first, then hand it out / key the run on it.
    const promisedId = '11111111-2222-4333-8444-555555555555';
    await quickStartSession({
      message: 'do the thing',
      cwd: '/tmp/promised-id',
      project: 'Walnut',
      source: 'test-promised-id',
      preassignedSessionId: promisedId,
    });

    const started = capture.last();
    expect(started.engine).toBeUndefined();
    expect(started.preassignedSessionId).toBe(promisedId);
    // The seeded record is what makes the promise good.
    expect((await getSessionByClaudeId(promisedId))?.cwd).toBe('/tmp/promised-id');
  });

  it('inherits normally when no id was promised', async () => {
    configuredEngine.value = 'codex';
    await quickStartSession({
      message: 'do the thing',
      cwd: '/tmp/no-promise',
      project: 'Walnut',
      source: 'test-no-promise',
    });
    expect(capture.last().engine).toBe('codex');
  });

  it('does not inherit an ACP engine onto a remote host (the ACP worker is local-only)', async () => {
    configuredEngine.value = 'codex';
    await quickStartSession({
      message: 'do the thing',
      cwd: '/workplace/x',
      host: 'devbox',
      project: 'Walnut',
      source: 'test-remote-host',
    });
    const started = capture.last();
    expect(started.host).toBe('devbox');
    expect(started.engine).toBeUndefined();
  });
});
