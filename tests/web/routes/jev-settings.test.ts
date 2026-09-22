/**
 * /api/jev — the Settings section's server side. Contract pinned:
 *   - POST /key writes the literal to <walnut-home>/secrets/jev-api.key at
 *     0600 and stores only a `${file:}` REFERENCE in config (the key must
 *     never enter config.yaml, which rides git-sync between machines)
 *   - the response never echoes the key
 *   - obvious non-keys are rejected before anything is written
 *   - POST /key preserves sibling jev settings (endpoint/model/decisions)
 *   - DELETE /key drops the config field and removes OUR managed file, but
 *     leaves a user-managed ${file:} path alone
 *   - POST /test round-trips the configured endpoint and reports ms + model;
 *     an unconfigured or failing endpoint answers ok:false, never a 500
 *
 * Real: route, config-manager, jev-client, filesystem, HTTP. Fake: the Jev
 * endpoint (a local http server).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-jev-settings'));

import express from 'express';
import request from 'supertest';
import { jevRouter } from '../../../src/web/routes/jev.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { getConfig, updateConfig } from '../../../src/core/config-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const REAL_KEY = 'sk-or-v1-abcdef0123456789';
const KEY_FILE = path.join(WALNUT_HOME, 'secrets', 'jev-api.key');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/jev', jevRouter);
  app.use(errorHandler);
  return app;
}

// ── Stub Jev endpoint ──
let stubAnswers: Record<string, unknown> | undefined;
let stubStatus = 200;
let stub: http.Server;
let stubUrl = '';

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (stubStatus !== 200) {
        res.writeHead(stubStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'stub-jev-1', answers: stubAnswers ?? {} }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const addr = stub.address();
  stubUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/decisions`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

beforeEach(async () => {
  stubStatus = 200;
  stubAnswers = { check: { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 1 } };
  // Deleting config.yaml is NOT a reset: the config reader is backup-aware and
  // restores the previous file, so a prior test's api_key would survive.
  // Clear the section explicitly instead.
  await updateConfig({ jev: {} });
  await fs.rm(KEY_FILE, { force: true });
});

afterEach(async () => {
  await fs.rm(KEY_FILE, { force: true });
});

describe('POST /api/jev/key', () => {
  it('writes the key to a 0600 secrets file and stores only a ${file:} reference', async () => {
    const res = await request(createApp()).post('/api/jev/key').send({ key: REAL_KEY });

    expect(res.status).toBe(200);
    expect(res.body.ref).toBe(`\${file:${KEY_FILE}}`);
    // The response must not echo the secret anywhere.
    expect(JSON.stringify(res.body)).not.toContain(REAL_KEY);

    expect((await fs.readFile(KEY_FILE, 'utf8')).trim()).toBe(REAL_KEY);
    const mode = (await fs.stat(KEY_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);

    // config.yaml holds the reference, never the key itself.
    const raw = await fs.readFile(path.join(WALNUT_HOME, 'config.yaml'), 'utf8');
    expect(raw).not.toContain(REAL_KEY);
    expect(raw).toContain('${file:');
    expect((await getConfig()).jev?.api_key).toBe(`\${file:${KEY_FILE}}`);
  });

  it('preserves sibling jev settings (endpoint, model, per-decision toggles)', async () => {
    await updateConfig({
      jev: { endpoint: stubUrl, model: 'typesafe/jev-1.13', decisions: { quick_parse: false, session_organize: true } },
    });

    await request(createApp()).post('/api/jev/key').send({ key: REAL_KEY }).expect(200);

    const jev = (await getConfig()).jev;
    expect(jev?.endpoint).toBe(stubUrl);
    expect(jev?.model).toBe('typesafe/jev-1.13');
    expect(jev?.decisions).toEqual({ quick_parse: false, session_organize: true });
  });

  it.each([
    ['empty', ''],
    ['whitespace inside', 'sk or v1 key'],
    ['too short', 'abc'],
  ])('rejects %s without writing anything', async (_label, key) => {
    const res = await request(createApp()).post('/api/jev/key').send({ key });
    expect(res.status).toBe(400);
    await expect(fs.stat(KEY_FILE)).rejects.toThrow();
    expect((await getConfig()).jev?.api_key).toBeUndefined();
  });
});

describe('DELETE /api/jev/key', () => {
  it('clears the config field and removes the managed secret file', async () => {
    await request(createApp()).post('/api/jev/key').send({ key: REAL_KEY }).expect(200);

    await request(createApp()).delete('/api/jev/key').expect(200);

    expect((await getConfig()).jev?.api_key).toBeUndefined();
    await expect(fs.stat(KEY_FILE)).rejects.toThrow();
  });

  it('leaves a user-managed ${file:} path on disk (only the config field is cleared)', async () => {
    const userFile = path.join(WALNUT_HOME, 'secrets', 'my-own.key');
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(userFile, REAL_KEY, { mode: 0o600 });
    await updateConfig({ jev: { api_key: `\${file:${userFile}}` } });

    await request(createApp()).delete('/api/jev/key').expect(200);

    expect((await getConfig()).jev?.api_key).toBeUndefined();
    // Their file is theirs: still there.
    expect((await fs.readFile(userFile, 'utf8')).trim()).toBe(REAL_KEY);
    await fs.rm(userFile, { force: true });
  });
});

describe('POST /api/jev/test', () => {
  it('reports ok with latency and the server-reported model', async () => {
    await updateConfig({ jev: { endpoint: stubUrl, model: 'typesafe/jev-1.13' } });
    await request(createApp()).post('/api/jev/key').send({ key: REAL_KEY }).expect(200);

    const res = await request(createApp()).post('/api/jev/test').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.answered).toBe(true);
    expect(res.body.model).toBe('typesafe/jev-1.13');
    expect(typeof res.body.ms).toBe('number');
  });

  it('answers ok:false (not 500) when Jev is not configured', async () => {
    const res = await request(createApp()).post('/api/jev/test').expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not configured/);
  });

  it('unwraps a JSON error body to one line while KEEPING the status', async () => {
    stubStatus = 401;
    await updateConfig({ jev: { endpoint: stubUrl } });
    await request(createApp()).post('/api/jev/key').send({ key: REAL_KEY }).expect(200);

    const res = await request(createApp()).post('/api/jev/test').expect(200);

    // The stub answers {"error":"nope"} — the status must survive the unwrap,
    // because 401 (wrong key) and 402 (out of credits) need different actions.
    expect(res.body.error).toBe('Jev 401: nope');
  });

  it('answers ok:false with the status when the endpoint rejects', async () => {
    stubStatus = 402;
    await updateConfig({ jev: { endpoint: stubUrl } });
    await request(createApp()).post('/api/jev/key').send({ key: REAL_KEY }).expect(200);

    const res = await request(createApp()).post('/api/jev/test').expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('402');
    expect(res.body.error).not.toContain(REAL_KEY);
  });
});
