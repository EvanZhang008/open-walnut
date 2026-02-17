import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

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

describe('GET /api/config', () => {
  it('returns default config when no config file exists', async () => {
    const app = createApp();
    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body.config).toBeDefined();
    expect(res.body.config.version).toBe(1);
    expect(res.body.config.defaults).toBeDefined();
    expect(res.body.config.defaults.priority).toBe('none');
  });
});

describe('PUT /api/config', () => {
  it('saves config and can read it back', async () => {
    const app = createApp();

    const newConfig = {
      version: 1,
      user: { name: 'Test User' },
      defaults: { priority: 'immediate', category: 'work' },
      provider: { type: 'claude-code' },
    };

    const putRes = await request(app)
      .put('/api/config')
      .send(newConfig);

    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);

    // Read it back
    const getRes = await request(app).get('/api/config');
    expect(getRes.status).toBe(200);
    expect(getRes.body.config.user.name).toBe('Test User');
    expect(getRes.body.config.defaults.priority).toBe('immediate');
  });

  it('partial PUT preserves unmentioned config sections', async () => {
    const app = createApp();

    // Seed config with ms_todo section
    const initial = {
      version: 1,
      user: { name: 'TestUser' },
      defaults: { priority: 'none', category: 'personal' },
      ms_todo: { client_id: 'abc-123', tenant_id: 'xyz-789' },
      agent: { model: 'claude-opus-4' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // Send partial update — only change defaults
    const putRes = await request(app)
      .put('/api/config')
      .send({ defaults: { priority: 'immediate', category: 'work' } });

    expect(putRes.status).toBe(200);

    // Read raw file to verify ms_todo survived
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const onDisk = yaml.load(raw) as any;

    expect(onDisk.ms_todo).toEqual({ client_id: 'abc-123', tenant_id: 'xyz-789' });
    expect(onDisk.user.name).toBe('TestUser');
    expect(onDisk.defaults.priority).toBe('immediate');
  });
});
