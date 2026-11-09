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
    // BUILTIN_GENERAL.name — product-facing Personal AI name, matched by api-v1.test.ts too.
    expect(general.name).toBe('Walnut');
  });
});

describe('GET /api/agents/meta/tools', () => {
  it('returns the read-only op names', async () => {
    const app = createApp();
    const res = await request(app).get('/api/agents/meta/tools');

    expect(res.status).toBe(200);
    expect(res.body.tools).toBeDefined();
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(res.body.tools.length).toBeGreaterThan(0);
    // The vocabulary is the op registry's, not the retired agent tools' —
    // `task_query`/`task_search` were that older naming.
    expect(res.body.tools).toContain('task_list');
    expect(res.body.tools).toContain('search');
    // Read-only means read-only: no write op may be advertised here.
    expect(res.body.tools).not.toContain('task_create');
  });
});

describe('POST /api/agents', () => {
  it('creates a config agent', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents').send({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      system_prompt: 'You test things.',
    });

    expect(res.status).toBe(201);
    expect(res.body.agent).toBeDefined();
    expect(res.body.agent.id).toBe('test-agent');
    expect(res.body.agent.source).toBe('config');

    // Confirm persistence via GET
    const get = await request(app).get('/api/agents/test-agent');
    expect(get.status).toBe(200);
    expect(get.body.agent.name).toBe('Test Agent');
    expect(get.body.agent.system_prompt).toBe('You test things.');
  });

  it('accepts the retired fields of the old agent loop and stores none of them', async () => {
    const app = createApp();
    const res = await request(app).post('/api/agents').send({
      id: 'legacy-form', name: 'Legacy Form', runner: 'cli', model: 'made-up-model', region: 'us-west-2',
      max_tokens: 1000, max_tool_rounds: 5, allowed_tools: ['file_read'], denied_tools: ['shell_exec'],
      working_directory: '/tmp/x', skills: ['walnut'], provider: 'bedrock',
      stateful: { memory_project: 'legacy/form', memory_budget_tokens: 100, memory_source: 'x' },
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.agent).sort()).toEqual(['id', 'name', 'source']);
    const saved = (yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as { agent: { agents: Array<Record<string, unknown>> } }).agent.agents;
    expect(saved).toEqual([{ id: 'legacy-form', name: 'Legacy Form' }]);
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

    // A model (an older form sends one) is ignored, never refused.
    const res = await request(app).patch('/api/agents/edit-me').send({ name: 'Updated', model: 'made-up-model' });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('Updated');
    expect(res.body.agent.model).toBeUndefined();
  });

  it('creates config override when patching builtin agent', async () => {
    const app = createApp();
    const res = await request(app).patch('/api/agents/general').send({ name: 'Custom General', system_prompt: 'Be brief.' });
    expect(res.status).toBe(200);
    expect(res.body.agent.source).toBe('config');
    expect(res.body.agent.overrides_builtin).toBe(true);
    expect(res.body.agent.name).toBe('Custom General');
    expect(res.body.agent.system_prompt).toBe('Be brief.');

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
      system_prompt: 'You are the source.',
      context_sources: [{ id: 'global_memory', enabled: true }],
    });

    const res = await request(app).post('/api/agents/source-agent/clone').send({
      id: 'cloned-agent',
    });

    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBe('cloned-agent');
    expect(res.body.agent.name).toBe('Source (Copy)');
    expect(res.body.agent.system_prompt).toBe('You are the source.');
    expect(res.body.agent.context_sources).toEqual([{ id: 'global_memory', enabled: true }]);
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

describe('GET /api/agents/meta/models and /meta/skills', () => {
  // Agents pick no model and no skills any more; a window on an older bundle
  // still asks for both when it opens /agents and must get an answer, not a 404.
  it('answer empty, even when an older config.yaml still lists models', async () => {
    const config = {
      version: 1,
      user: {},
      defaults: { priority: 'none', project: 'personal' },
      provider: { type: 'claude-code' },
      agent: { available_models: ['custom-model-1', 'custom-model-2'] },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(config), 'utf-8');
    _resetForTest();

    const app = createApp();
    const models = await request(app).get('/api/agents/meta/models');
    expect(models.status).toBe(200);
    expect(models.body).toEqual({ models: [] });
    const skills = await request(app).get('/api/agents/meta/skills');
    expect(skills.status).toBe(200);
    expect(skills.body).toEqual({ skills: [] });
  });
});

describe('PATCH /api/agents/:id (config write-through)', () => {
  it('updates a config-defined agent via config write-through', async () => {
    // Write a config with an agent defined
    const config = {
      version: 1,
      user: {},
      defaults: { priority: 'none', project: 'personal' },
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

    // Update it (the model it sends is ignored)
    const res = await request(app).patch('/api/agents/cfg-agent').send({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Updated Config Agent' });
    expect(res.status).toBe(200);
    expect(res.body.agent.model).toBeUndefined();
    expect(res.body.agent.runner).toBeUndefined();
    expect(res.body.agent.name).toBe('Updated Config Agent');
    expect(res.body.agent.source).toBe('config');

    // Verify persisted to config.yaml: the new name, and the retired fields the
    // user's file held left exactly as they were (read by nothing)
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const savedConfig = yaml.load(raw) as typeof config;
    const savedAgent = savedConfig.agent.agents[0];
    expect(savedAgent.name).toBe('Updated Config Agent');
    expect(savedAgent.model).toBe('global.anthropic.claude-opus-4-6-v1');
    expect(savedAgent.runner).toBe('embedded');
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

});

describe('Builtin agent override lifecycle', () => {
  it('restores builtin after deleting override', async () => {
    const app = createApp();

    // Patch builtin → creates override
    const patch = await request(app).patch('/api/agents/general').send({ name: 'Custom General', system_prompt: 'Custom.' });
    expect(patch.status).toBe(200);
    expect(patch.body.agent.overrides_builtin).toBe(true);

    // Delete the override → restores builtin
    const del = await request(app).delete('/api/agents/general');
    expect(del.status).toBe(204);

    // GET → should be back to original builtin
    const get = await request(app).get('/api/agents/general');
    expect(get.status).toBe(200);
    expect(get.body.agent.source).toBe('builtin');
    expect(get.body.agent.name).toBe('Walnut');
    expect(get.body.agent.overrides_builtin).toBeUndefined();
  });

  it('subsequent patches update config entry (not create duplicates)', async () => {
    const app = createApp();

    // First patch → creates override
    await request(app).patch('/api/agents/general').send({ name: 'V1' });

    // Second patch → updates existing override
    const res = await request(app).patch('/api/agents/general').send({ name: 'V2', description: 'second' });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('V2');
    expect(res.body.agent.description).toBe('second');

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
});
