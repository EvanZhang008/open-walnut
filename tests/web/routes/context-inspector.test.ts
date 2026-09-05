/**
 * Integration tests for the context inspector API route.
 * Uses supertest against an Express app with the route mounted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-ctx-inspect'));

import express from 'express';
import request from 'supertest';
import path from 'node:path';
import yaml from 'js-yaml';
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js';
import { contextInspectorRouter } from '../../../src/web/routes/context-inspector.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { DEFAULT_MODEL } from '../../../src/agent/model.js';
import { DEFAULT_MAX_TOKENS } from '../../../src/agent/providers/defaults.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/context', contextInspectorRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  // These sections describe the in-process assembly (tools, model config, token
  // sums). The default engine is the claude-code lane, whose inspector answer is a
  // different shape, so pin the engine this file is about.
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, yaml.dump({ agent: { provider: 'walnut-agent' } }), 'utf-8');
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/context', () => {
  it('returns 200 with all expected sections', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sections');
    expect(res.body).toHaveProperty('totalTokens');

    const { sections } = res.body;
    expect(sections).toHaveProperty('modelConfig');
    expect(sections).toHaveProperty('roleAndRules');
    expect(sections).toHaveProperty('skills');
    expect(sections).toHaveProperty('compactionSummary');
    expect(sections).toHaveProperty('userProfile');
    expect(sections).toHaveProperty('globalMemory');
    expect(sections).toHaveProperty('dailyLogs');
    expect(sections).toHaveProperty('tools');
    expect(sections).toHaveProperty('apiMessages');
  });

  it('each section has content and tokens fields', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    const { sections } = res.body;
    for (const [name, section] of Object.entries(sections)) {
      const s = section as { content: unknown; tokens: number };
      expect(s, `section "${name}" missing content`).toHaveProperty('content');
      expect(typeof s.tokens, `section "${name}" tokens is not a number`).toBe('number');
      expect(s.tokens).toBeGreaterThanOrEqual(0);
    }
  });

  it('totalTokens is close to the sum of all section tokens', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    const { sections, totalTokens } = res.body;
    const sum = Object.values(sections).reduce(
      (acc, s) => acc + (s as { tokens: number }).tokens,
      0,
    );
    // totalTokens uses estimateFullPayload() on the assembled prompt which includes
    // additional headers/delimiters not counted in individual section estimates.
    // Allow up to 5% divergence.
    expect(totalTokens).toBeGreaterThanOrEqual(sum * 0.95);
    expect(totalTokens).toBeLessThanOrEqual(sum * 1.05);
  });

  it('roleAndRules section contains Walnut identity', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    const role = res.body.sections.roleAndRules.content as string;
    expect(role).toContain('Walnut');
    expect(role).toContain('project manager');
  });

  it('tools section lists all agent tools with count', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    const tools = res.body.sections.tools;
    expect(tools.count).toBeGreaterThan(0);
    expect(Array.isArray(tools.content)).toBe(true);
    expect(tools.content.length).toBe(tools.count);

    // Each tool has name, description, input_schema
    for (const tool of tools.content) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('input_schema');
    }
  });

  it('modelConfig section has expected fields', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    const config = res.body.sections.modelConfig.content;
    expect(config).toHaveProperty('model');
    expect(config).toHaveProperty('max_tokens');
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    // Model config is call parameters, not prompt content — must cost 0 tokens
    expect(res.body.sections.modelConfig.tokens).toBe(0);
  });

  it('userProfile section reflects USER.md bounded store', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    expect(res.body.sections).toHaveProperty('userProfile');
    expect(res.body.sections).not.toHaveProperty('projectSummaries');
  });

  it('apiMessages section starts empty (no chat history)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    const messages = res.body.sections.apiMessages;
    expect(messages.count).toBe(0);
    expect(messages.content).toEqual([]);
  });

  it("lane engine (agent.provider='claude-code') shows the session launch config, not the in-process assembly", async () => {
    const yaml = await import('js-yaml');
    const path = await import('node:path');
    const { CONFIG_FILE } = await import('../../../src/constants.js');
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(CONFIG_FILE, yaml.dump({
      version: 1,
      user: { name: 'Ada' },
      provider: { type: 'claude-code' },
      agent: { provider: 'claude-code' },
    }), 'utf-8');

    const app = createApp();
    const res = await request(app).get('/api/context');

    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('claude-code');
    // The prompt shown is the lane's --system-prompt (Personal AI persona), and the
    // engine note explains ownership of tools/compaction.
    const role = res.body.sections.roleAndRules.content as string;
    expect(role).toContain('Claude Code session');
    expect(role).toContain('## Walnut operating contract');
    for (const removed of [
      '## Error handling and integrity',
      '## Communication style',
      '## Task hierarchy',
      '## Available tools',
      '## Session management',
      '## Proactive execution',
      '## Task sync',
      '## Available agents',
    ]) {
      expect(role).not.toContain(removed);
    }
    // In-process tool schemas / message history must NOT be presented as fed.
    expect(res.body.sections.tools.count).toBe(0);
    expect(res.body.sections.apiMessages.count).toBe(0);
    // Skills ARE fed on this engine — the walnut skills index rides inside the
    // system prompt, and the section splits it out for display.
    expect(res.body.sections.skills.content).toContain('Walnut skills');
    // Standing memory rides INSIDE the system prompt too (engine-neutral
    // injection) — the Global Memory section splits that block out.
    expect(res.body.sections.globalMemory.content).toContain('Standing memory (injected by Walnut)');
    expect(role).toContain('Standing memory (injected by Walnut)');
  });
});

/**
 * `?sessionId=` — the form the home page's Ask Walnut slot uses.
 *
 * The claim under test is HONESTY: the panel describes THAT session or says it
 * cannot. Three ways it used to lie, one case each below: an unknown id fell
 * through to some other conversation's config (now a 404); a record with no
 * recorded profile got the CURRENT Personal AI persona synthesized and labelled
 * "what this session was launched with"; and a session on another engine was
 * reported as `claude-code`, which badges the panel "Claude Code engine".
 *
 * The records are written straight to the session store — a real spawn would need
 * a CLI, and what the route reads is the persisted record either way.
 */
describe('GET /api/context?sessionId=', () => {
  const SYSTEM_PROMPT = 'You are Walnut, the personal AI. ## Walnut operating contract — recorded at launch.';

  /**
   * A persisted session row, under an id UNIQUE to the calling test.
   *
   * Per-test ids are load-bearing: the tracker keeps its SQLite handle open across
   * the `beforeEach` wipe (the file is unlinked, the inode is not), so rows outlive
   * it — and `createSessionRecord` returns the EXISTING row for an id it already
   * knows instead of rewriting it. Sharing one id silently gave test 2's profile to
   * test 3.
   */
  async function seedSession(id: string, extra: Record<string, unknown>): Promise<string> {
    const { createSessionRecord } = await import('../../../src/core/session-tracker.js');
    await createSessionRecord(id, `task-${id}`, 'Ask Walnut', '/tmp', {
      provider: 'cli',
      ...extra,
    } as never);
    return id;
  }

  it('404s on a session id the store does not know', async () => {
    const res = await request(createApp()).get('/api/context').query({ sessionId: 'no-such-session' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('no-such-session');
  });

  it('shows the RECORDED launch profile for a session that has one', async () => {
    const id = await seedSession('sess-with-profile', { profile: { systemPrompt: SYSTEM_PROMPT } });

    const res = await request(createApp()).get('/api/context').query({ sessionId: id });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('claude-code');
    const role = res.body.sections.roleAndRules.content as string;
    expect(role).toContain('Claude Code session');
    expect(role).toContain(SYSTEM_PROMPT);
    // The in-process assembly is NOT what this engine feeds.
    expect(res.body.sections.tools.count).toBe(0);
    expect(res.body.sections.apiMessages.count).toBe(0);
  });

  it('says so instead of synthesizing a prompt when the record has no profile', async () => {
    const id = await seedSession('sess-without-profile', {});

    const res = await request(createApp()).get('/api/context').query({ sessionId: id });
    expect(res.status).toBe(200);
    const role = res.body.sections.roleAndRules.content as string;
    expect(role).toContain('No launch profile was recorded for this session');
    // The giveaway of the old synthesized answer: a persona this session never saw.
    expect(role).not.toContain('## Walnut operating contract');
  });

  it('reports a non-claude engine from the record rather than claiming claude-code', async () => {
    const id = await seedSession('sess-on-codex', { engine: 'codex', profile: { systemPrompt: SYSTEM_PROMPT } });

    const res = await request(createApp()).get('/api/context').query({ sessionId: id });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('codex');
    const role = res.body.sections.roleAndRules.content as string;
    expect(role).toContain('NOT Claude Code');
    expect(role).toContain('codex');
  });
});
