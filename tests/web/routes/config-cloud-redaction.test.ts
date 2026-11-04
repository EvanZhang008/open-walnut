/**
 * Security regression (Finding 7): in CLOUD mode, GET /api/config must MASK
 * provider secrets. config.yaml is git-synced to the public box and the route
 * is reachable by any paired-device token, so returning plaintext bearer
 * tokens / API keys / AWS secret keys there would hand a phone token holder the
 * Bedrock credentials. On the trusted-LAN Mac the values stay unmasked (covered
 * by config.test.ts) — this file locks the cloud path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-config-cloud', { CLOUD_MODE: true }));

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js';
import { configRouter } from '../../../src/web/routes/config.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetWriteLockForTest } from '../../../src/core/config-manager.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  _resetWriteLockForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/config (cloud mode) redacts secrets', () => {
  it('masks bearer tokens, api keys, and AWS secret keys — tail preserved, body hidden', async () => {
    const secretToken = 'bedrock-super-secret-token-1234ABCD';
    const secretKey = 'sk-provider-plaintext-key-9876WXYZ';
    const awsSecret = 'aws-secret-access-key-value-5555zzzz';
    const initial = {
      version: 1,
      user: { name: 'Owner' },
      defaults: { priority: 'none', project: 'personal' },
      provider: { bedrock_bearer_token: secretToken },
      providers: {
        bedrock: { api: 'bedrock', aws_secret_access_key: awsSecret },
        openai: { api: 'openai-chat', api_key: secretKey },
      },
      api_keys: [{ name: 'legacy', key: 'legacy-plaintext-apikey-0000', created_at: '2026-01-01' }],
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    const res = await request(createApp()).get('/api/config');
    expect(res.status).toBe(200);
    const c = res.body.config;

    // No plaintext secret survives anywhere in the serialized response.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(awsSecret);
    expect(serialized).not.toContain('legacy-plaintext-apikey-0000');

    // Masked values keep the last 4 chars so the UI can show "configured".
    expect(c.provider.bedrock_bearer_token).toBe('••••••••ABCD');
    expect(c.providers.bedrock.aws_secret_access_key).toBe('••••••••zzzz');
    expect(c.providers.openai.api_key).toBe('••••••••WXYZ');
    expect(c.api_keys[0].key).toBe('••••••••0000');

    // Non-secret fields pass through untouched.
    expect(c.user.name).toBe('Owner');
    expect(c.providers.bedrock.api).toBe('bedrock');
    expect(c.api_keys[0].name).toBe('legacy');
  });
});

describe('PUT /api/config (cloud mode): where backups go', () => {
  it('a switch of service is refused as the person-only choice, not as an unpaired mask', async () => {
    const r2 = { type: 'r2', bucket: 'mine', account_id: 'acct', access_key_id: 'AKR2', secret_access_key: 'r2-secret-access-key-value-7777QQQQ' };
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, backup: { enabled: true, interval_hours: 24, destination: r2 } }), 'utf-8');
    const app = createApp();
    const masked = (await request(app).get('/api/config')).body.config.backup.destination;
    const r = await request(app).put('/api/config').send({
      backup: { enabled: true, interval_hours: 24, destination: { type: 'gdrive' }, other_destinations: [masked] },
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'person_at_this_machine' });
  });
});
