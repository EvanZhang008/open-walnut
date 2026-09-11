/**
 * Integration tests for the context inspector API route.
 * Uses supertest against an Express app with the route mounted.
 *
 * There is one shape to test: a chat turn runs in a coding-agent session, so the
 * route answers with that session's LAUNCH CONFIG. With no session yet it reports
 * the persona the next spawn will carry (buildLaneProfile, the same builder a mint
 * uses), and for a named session it reports that record or says it has no profile.
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
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    provider: { type: 'claude-code' },
  }), 'utf-8');
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/context', () => {
  it('reports the launch config of the session that answers, not a prompt Walnut assembles', async () => {
    const res = await request(createApp()).get('/api/context');

    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('claude-code');
    // The prompt shown is the lane's persona block, and the engine note explains
    // who owns tools and compaction.
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
    // Skills ARE fed — the walnut skills index rides inside the system prompt, and
    // the section splits it out for display.
    expect(res.body.sections.skills.content).toContain('Walnut skills');
    // Standing memory rides INSIDE the system prompt too (engine-neutral
    // injection) — the Global Memory section splits that block out.
    expect(res.body.sections.globalMemory.content).toContain('Standing memory (injected by Walnut)');
    expect(role).toContain('Standing memory (injected by Walnut)');
  });

  it('emits only sections with a real source — no zeroed tools or transcript', async () => {
    const res = await request(createApp()).get('/api/context');

    const { sections } = res.body;
    expect(Object.keys(sections).sort()).toEqual(['globalMemory', 'modelConfig', 'roleAndRules', 'skills']);
    // A zeroed tools/apiMessages section would read as "the model got none of
    // that"; the session CLI owns both, so they are absent instead.
    expect(sections).not.toHaveProperty('tools');
    expect(sections).not.toHaveProperty('apiMessages');
    expect(sections).not.toHaveProperty('compactionSummary');
    expect(sections).not.toHaveProperty('dailyLogs');
  });

  it('each section has content and tokens fields', async () => {
    const res = await request(createApp()).get('/api/context');

    for (const [name, section] of Object.entries(res.body.sections)) {
      const s = section as { content: unknown; tokens: number };
      expect(s, `section "${name}" missing content`).toHaveProperty('content');
      expect(typeof s.tokens, `section "${name}" tokens is not a number`).toBe('number');
      expect(s.tokens).toBeGreaterThanOrEqual(0);
    }
  });

  it('totalTokens is the system prompt, which already contains memory and skills', async () => {
    const res = await request(createApp()).get('/api/context');

    const { sections, totalTokens } = res.body;
    expect(totalTokens).toBe(sections.roleAndRules.tokens);
    // Substrings of the same prompt, so each is smaller than the whole.
    expect(sections.skills.tokens).toBeLessThan(totalTokens);
    expect(sections.globalMemory.tokens).toBeLessThan(totalTokens);
  });

  it('modelConfig describes the session, and costs no tokens', async () => {
    const res = await request(createApp()).get('/api/context');

    const config = res.body.sections.modelConfig.content;
    expect(config).toHaveProperty('model');
    expect(config).toHaveProperty('region');
    // Not a prompt: call parameters must not be counted.
    expect(res.body.sections.modelConfig.tokens).toBe(0);
    // max_tokens had no source once the prompt stopped being assembled here.
    expect(config).not.toHaveProperty('max_tokens');
  });

  it('404s an agent id the registry does not know', async () => {
    const res = await request(createApp()).get('/api/context').query({ agentId: 'no-such-agent' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('no-such-agent');
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
