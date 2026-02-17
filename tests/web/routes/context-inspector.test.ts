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
import { WALNUT_HOME } from '../../../src/constants.js';
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
    expect(sections).toHaveProperty('globalMemory');
    expect(sections).toHaveProperty('projectSummaries');
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
    expect(role).toContain('personal intelligent butler');
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
    expect(config.model).toBe('claude-opus-4-6');
    expect(config.max_tokens).toBe(16384);
  });

  it('apiMessages section starts empty (no chat history)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/context');

    const messages = res.body.sections.apiMessages;
    expect(messages.count).toBe(0);
    expect(messages.content).toEqual([]);
  });
});
