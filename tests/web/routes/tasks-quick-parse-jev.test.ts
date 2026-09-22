/**
 * POST /api/tasks/quick-parse with Jev configured — the integration tier the
 * unit files can't cover: the real route, the real config-manager, the real
 * jev-client speaking HTTP to a real (stub) endpoint. Contract pinned:
 *   - CLI main provider: the route answers from Jev alone, no `claude -p`
 *     spawn (sendMessage never called), Bearer auth reaches the endpoint
 *   - a down endpoint degrades to the raw note with HTTP 200, never a 500
 *   - direct-API provider: LLM and Jev merge, Jev winning the classification
 *   - a `${file:}` key under <walnut-home>/secrets/ works end to end
 *
 * Real: route, config, jev-client, HTTP. Fake: sendMessage (the one thing the
 * testing rules say to mock), the Jev endpoint itself (a local http server).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

const sendMessageMock = vi.fn();
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-quick-parse-jev'));
vi.mock('../../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { updateConfig } from '../../../src/core/config-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

// ── Stub Jev endpoint: a real HTTP server whose behavior each test sets ──
type StubMode =
  | { kind: 'answers'; answers: Record<string, unknown> }
  | { kind: 'error'; status: number };
let stubMode: StubMode = { kind: 'error', status: 500 };
const stubRequests: Array<{ auth?: string; body: { model?: string; state?: string; questions?: Record<string, unknown> } }> = [];
let stub: http.Server;
let stubUrl = '';

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      stubRequests.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      if (stubMode.kind === 'error') {
        res.writeHead(stubMode.status).end('stub says no');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        model: 'jev-1.13.0',
        answers: stubMode.answers,
        usage: { input_tokens: 50, output_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const addr = stub.address() as { port: number };
  stubUrl = `http://127.0.0.1:${addr.port}/decisions`;
});

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

function choice(key: string, confidence: number) {
  return { type: 'choice', choice: key, probabilities: { [key]: confidence }, confidence };
}

const validBody = { timeZone: 'America/Los_Angeles' };

beforeEach(async () => {
  sendMessageMock.mockReset();
  stubRequests.length = 0;
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(path.join(WALNUT_HOME, 'secrets'), { recursive: true });
  // Distinct per-test key files defeat the jev-client's 60s client cache, so
  // each test's endpoint/behavior wiring is actually exercised.
  const keyFile = path.join(WALNUT_HOME, 'secrets', `jev-${Date.now()}-${Math.random().toString(36).slice(2)}.key`);
  await fs.writeFile(keyFile, 'stub-test-key\n');
  await updateConfig({
    agent: { quick_parse: true, main_provider: 'claude_cli' },
    jev: { api_key: `\${file:${keyFile}}`, endpoint: stubUrl, model: 'jev-stub' },
  });
  // A seeded project gives the digest a real knownProjects list.
  await addTask({ title: 'Fix search ranking', project: 'walnut' });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('POST /api/tasks/quick-parse with Jev (CLI provider: no spawn)', () => {
  it('answers from Jev alone with Bearer auth from the ${file:} key', async () => {
    stubMode = {
      kind: 'answers',
      answers: {
        pinTier: choice('focus', 0.9),
        priority: choice('immediate', 0.8),
        project: choice('walnut', 0.85),
      },
    };

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'urgent: fix the search ranking regression in walnut asap', ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: 'urgent: fix the search ranking regression in walnut asap',
      pinTier: 'focus',
      priority: 'immediate',
      project: 'walnut',
    });
    // The whole point: no `claude -p` (sendMessage) spawn on the CLI provider.
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0].auth).toBe('Bearer stub-test-key');
    expect(stubRequests[0].body.model).toBe('jev-stub');
    expect(stubRequests[0].body.state).toContain('search ranking');
    expect(Object.keys(stubRequests[0].body.questions ?? {})).toEqual(
      expect.arrayContaining(['pinTier', 'priority', 'project']),
    );
  });

  it('degrades to the raw note with HTTP 200 when the endpoint is down', async () => {
    stubMode = { kind: 'error', status: 503 };

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'call the bank asap', ...validBody });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'call the bank asap' });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/quick-parse with Jev (direct-API provider: merge)', () => {
  it('runs both legs and Jev wins the classification fields', async () => {
    await updateConfig({ agent: { quick_parse: true, main_provider: 'bedrock' } });
    stubMode = { kind: 'answers', answers: { pinTier: choice('satellite', 0.8) } };
    sendMessageMock.mockResolvedValue({
      content: [{ type: 'text', text: '{"title":"Fix search ranking","pinTier":"focus","due_date":"2026-09-25"}' }],
      stopReason: 'end_turn',
    });

    const res = await request(createApp())
      .post('/api/tasks/quick-parse')
      .send({ text: 'fix search ranking by sep 25', ...validBody });

    expect(res.status).toBe(200);
    // Title and date from the LLM, tier from Jev.
    expect(res.body).toMatchObject({
      title: 'Fix search ranking',
      due_date: '2026-09-25',
      pinTier: 'satellite',
    });
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(stubRequests).toHaveLength(1);
  });
});
