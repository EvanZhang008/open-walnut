import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import yaml from 'js-yaml';
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js';
import { createAgentsRouter } from '../../../src/web/routes/agents.js';
import { _resetForTest } from '../../../src/core/agent-registry.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', createAgentsRouter());
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  _resetForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  _resetForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/agents', () => {
  it('returns merged list with builtin "general"', async () => {
    const app = createApp();
    const res = await request(app).get('/api/agents');

    expect(res.status).toBe(200);
    expect(res.body.agents).toBeDefined();
    expect(Array.isArray(res.body.agents)).toBe(true);

    const general = res.body.agents.find((a: { id: string }) => a.id === 'general');
    expect(general).toBeDefined();
    expect(general.source).toBe('builtin');
    expect(general.name).toBe('General Agent');
  });
});

describe('GET /api/agents/meta/tools', () => {
  it('returns tool names', async () => {
    const app = createApp();
    const res = await request(app).get('/api/agents/meta/tools');

    expect(res.status).toBe(200);
    expect(res.body.tools).toBeDefined();
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(res.body.tools.length).toBeGreaterThan(0);
    expect(res.body.tools).toContain('query_tasks');
    expect(res.body.tools).toContain('search');
  });
});

describe('POST /api/agents', () => {
  it('creates a config agent', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents').send({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      runner: 'embedded',
      max_tool_rounds: 5,
    });

    expect(res.status).toBe(201);
    expect(res.body.agent).toBeDefined();
    expect(res.body.agent.id).toBe('test-agent');
    expect(res.body.agent.source).toBe('config');

    // Confirm persistence via GET
    const get = await request(app).get('/api/agents/test-agent');
    expect(get.status).toBe(200);
    expect(get.body.agent.name).toBe('Test Agent');
    expect(get.body.agent.max_tool_rounds).toBe(5);
  });

  it('rejects missing id', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents').send({ name: 'No ID' });
    expect(res.status).toBe(400);
  });

  it('rejects missing name', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents').send({ id: 'no-name' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid slug', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents').send({ id: 'INVALID SLUG!', name: 'Bad' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate ID', async () => {
    const app = createApp();
    await request(app).post('/api/agents').send({ id: 'dup-agent', name: 'First' });
    const res = await request(app).post('/api/agents').send({ id: 'dup-agent', name: 'Second' });
    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/agents/:id', () => {
  it('updates a config agent', async () => {
    const app = createApp();
    await request(app).post('/api/agents').send({ id: 'edit-me', name: 'Original' });

    const res = await request(app).patch('/api/agents/edit-me').send({ name: 'Updated', model: 'global.anthropic.claude-opus-4-6-v1' });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('Updated');
    expect(res.body.agent.model).toBe('global.anthropic.claude-opus-4-6-v1');
  });

  it('creates config override when patching builtin agent', async () => {
    const app = createApp();
    const res = await request(app).patch('/api/agents/general').send({ name: 'Custom General', max_tool_rounds: 8 });
    expect(res.status).toBe(200);
    expect(res.body.agent.source).toBe('config');
    expect(res.body.agent.overrides_builtin).toBe(true);
    expect(res.body.agent.name).toBe('Custom General');
    expect(res.body.agent.max_tool_rounds).toBe(8);

    // Verify it persists and shows up with override flag
    const get = await request(app).get('/api/agents/general');
    expect(get.status).toBe(200);
    expect(get.body.agent.source).toBe('config');
    expect(get.body.agent.overrides_builtin).toBe(true);
  });

  it('returns 404 for unknown agent', async () => {
    const app = createApp();
    const res = await request(app).patch('/api/agents/nonexistent').send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/agents/:id', () => {
  it('deletes a config agent', async () => {
    const app = createApp();
    await request(app).post('/api/agents').send({ id: 'del-me', name: 'Delete Me' });

    const res = await request(app).delete('/api/agents/del-me');
    expect(res.status).toBe(204);

    // Confirm it's gone
    const get = await request(app).get('/api/agents/del-me');
    expect(get.status).toBe(404);
  });

  it('rejects delete of builtin agent', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/agents/general');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cannot be deleted');
  });
});

describe('POST /api/agents/:id/clone', () => {
  it('clones a builtin agent as new config agent', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents/general/clone').send({
      id: 'general-copy',
      name: 'My General',
    });

    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBe('general-copy');
    expect(res.body.agent.name).toBe('My General');
    expect(res.body.agent.source).toBe('config');
  });

  it('clones a config agent', async () => {
    const app = createApp();
    await request(app).post('/api/agents').send({
      id: 'source-agent',
      name: 'Source',
      allowed_tools: ['search', 'memory'],
    });

    const res = await request(app).post('/api/agents/source-agent/clone').send({
      id: 'cloned-agent',
    });

    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBe('cloned-agent');
    expect(res.body.agent.name).toBe('Source (Copy)');
    expect(res.body.agent.allowed_tools).toEqual(['search', 'memory']);
  });

  it('returns 404 when cloning nonexistent agent', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents/nonexistent/clone').send({ id: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when clone ID conflicts', async () => {
    const app = createApp();
    await request(app).post('/api/agents').send({ id: 'existing', name: 'Exists' });
    const res = await request(app).post('/api/agents/general/clone').send({ id: 'existing' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/agents/meta/models', () => {
  it('returns default models when config has none', async () => {
    const app = createApp();
    const res = await request(app).get('/api/agents/meta/models');

    expect(res.status).toBe(200);
    expect(res.body.models).toBeDefined();
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.models.length).toBeGreaterThan(0);
    // Should contain at least the defaults from the route
    expect(res.body.models.length).toBeGreaterThanOrEqual(1);
  });

  it('returns config-defined models when present', async () => {
    const config = {
      version: 1,
      user: {},
      defaults: { priority: 'none', category: 'personal' },
      provider: { type: 'claude-code' },
      agent: { available_models: ['custom-model-1', 'custom-model-2'] },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(config), 'utf-8');
    _resetForTest();

    const app = createApp();
    const res = await request(app).get('/api/agents/meta/models');

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(['custom-model-1', 'custom-model-2']);
  });
});

describe('PATCH /api/agents/:id (config write-through)', () => {
  it('updates a config-defined agent via config write-through', async () => {
    // Write a config with an agent defined
    const config = {
      version: 1,
      user: {},
      defaults: { priority: 'none', category: 'personal' },
      provider: { type: 'claude-code' },
      agent: {
        agents: [
          { id: 'cfg-agent', name: 'Config Agent', runner: 'embedded', model: 'global.anthropic.claude-opus-4-6-v1' },
        ],
      },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(config), 'utf-8');
    _resetForTest();

    const app = createApp();

    // Verify agent shows up
    const listRes = await request(app).get('/api/agents');
    const cfgAgent = listRes.body.agents.find((a: { id: string }) => a.id === 'cfg-agent');
    expect(cfgAgent).toBeDefined();
    expect(cfgAgent.source).toBe('config');

    // Update it
    const res = await request(app).patch('/api/agents/cfg-agent').send({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Updated Config Agent' });
    expect(res.status).toBe(200);
    expect(res.body.agent.model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(res.body.agent.name).toBe('Updated Config Agent');
    expect(res.body.agent.source).toBe('config');

    // Verify persisted to config.yaml
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const savedConfig = yaml.load(raw) as typeof config;
    const savedAgent = savedConfig.agent.agents[0];
    expect(savedAgent.model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(savedAgent.name).toBe('Updated Config Agent');
  });

  it('creates config override when patching builtin via config write-through', async () => {
    const app = createApp();
    const res = await request(app).patch('/api/agents/general').send({ name: 'Override General', description: 'customized' });
    expect(res.status).toBe(200);
    expect(res.body.agent.source).toBe('config');
    expect(res.body.agent.overrides_builtin).toBe(true);
    expect(res.body.agent.name).toBe('Override General');
    expect(res.body.agent.description).toBe('customized');
  });

  it('rejects update with invalid model', async () => {
    const app = createApp();
    await request(app).post('/api/agents').send({ id: 'model-test', name: 'Model Test' });
    const res = await request(app).patch('/api/agents/model-test').send({ model: 'made-up-model' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not in the available models list');
  });
});

describe('Builtin agent override lifecycle', () => {
  it('restores builtin after deleting override', async () => {
    const app = createApp();

    // Patch builtin → creates override
    const patch = await request(app).patch('/api/agents/general').send({ name: 'Custom General', max_tool_rounds: 8 });
    expect(patch.status).toBe(200);
    expect(patch.body.agent.overrides_builtin).toBe(true);

    // Delete the override → restores builtin
    const del = await request(app).delete('/api/agents/general');
    expect(del.status).toBe(204);

    // GET → should be back to original builtin
    const get = await request(app).get('/api/agents/general');
    expect(get.status).toBe(200);
    expect(get.body.agent.source).toBe('builtin');
    expect(get.body.agent.name).toBe('General Agent');
    expect(get.body.agent.overrides_builtin).toBeUndefined();
  });

  it('subsequent patches update config entry (not create duplicates)', async () => {
    const app = createApp();

    // First patch → creates override
    await request(app).patch('/api/agents/general').send({ name: 'V1' });

    // Second patch → updates existing override
    const res = await request(app).patch('/api/agents/general').send({ name: 'V2', max_tool_rounds: 12 });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('V2');
    expect(res.body.agent.max_tool_rounds).toBe(12);

    // Verify no duplicate in list
    const list = await request(app).get('/api/agents');
    const generals = list.body.agents.filter((a: { id: string }) => a.id === 'general');
    expect(generals).toHaveLength(1);
    expect(generals[0].name).toBe('V2');
  });

  it('getAllAgents marks overridden builtins with overrides_builtin', async () => {
    const app = createApp();

    // Before override
    const before = await request(app).get('/api/agents');
    const generalBefore = before.body.agents.find((a: { id: string }) => a.id === 'general');
    expect(generalBefore.source).toBe('builtin');
    expect(generalBefore.overrides_builtin).toBeUndefined();

    // Create override
    await request(app).patch('/api/agents/general').send({ name: 'Overridden' });

    // After override
    const after = await request(app).get('/api/agents');
    const generalAfter = after.body.agents.find((a: { id: string }) => a.id === 'general');
    expect(generalAfter.source).toBe('config');
    expect(generalAfter.overrides_builtin).toBe(true);
  });

  it('rejects delete of unmodified builtin agent', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/agents/general');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cannot be deleted');
  });
});
