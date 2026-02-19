/**
 * E2E tests for the Context Inspector feature.
 *
 * Spins up a real server with Express + WebSocket, then tests:
 * - GET /api/context returns all sections
 * - Token counts are consistent
 * - All tools are listed
 * - API messages section reflects chat history state
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-ctx'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('Context Inspector E2E', () => {
  it('GET /api/context returns 200 with all sections via real server', async () => {
    const res = await fetch(apiUrl('/api/context'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('sections');
    expect(body).toHaveProperty('totalTokens');
    expect(typeof body.totalTokens).toBe('number');
    expect(body.totalTokens).toBeGreaterThan(0);
  });

  it('returns all 9 sections', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();
    const sectionNames = Object.keys(body.sections);

    expect(sectionNames).toContain('modelConfig');
    expect(sectionNames).toContain('roleAndRules');
    expect(sectionNames).toContain('skills');
    expect(sectionNames).toContain('compactionSummary');
    expect(sectionNames).toContain('globalMemory');
    expect(sectionNames).toContain('projectSummaries');
    expect(sectionNames).toContain('dailyLogs');
    expect(sectionNames).toContain('tools');
    expect(sectionNames).toContain('apiMessages');
    expect(sectionNames).toHaveLength(9);
  });

  it('tools section contains known tools', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();
    const tools = body.sections.tools.content as Array<{ name: string }>;

    const names = tools.map((t) => t.name);
    expect(names).toContain('query_tasks');
    expect(names).toContain('create_task');
    expect(names).toContain('search');
    expect(names).toContain('memory');
    expect(names).toContain('start_session');
  });

  it('roleAndRules section mentions current date', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();
    const role = body.sections.roleAndRules.content as string;

    // Should contain current year
    const year = new Date().getFullYear().toString();
    expect(role).toContain(year);
  });

  it('totalTokens is close to the sum of all section tokens', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();

    const sum = Object.values(body.sections).reduce(
      (acc: number, s: unknown) => acc + (s as { tokens: number }).tokens,
      0,
    );
    // totalTokens uses estimateFullPayload() on the assembled prompt which includes
    // additional headers/delimiters not counted in individual section estimates.
    // Allow up to 5% divergence.
    expect(body.totalTokens).toBeGreaterThanOrEqual(sum * 0.95);
    expect(body.totalTokens).toBeLessThanOrEqual(sum * 1.05);
  });

  it('apiMessages starts empty with no prior chat', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();

    expect(body.sections.apiMessages.count).toBe(0);
    expect(body.sections.apiMessages.content).toEqual([]);
  });

  it('subsequent requests return consistent structure', async () => {
    const res1 = await fetch(apiUrl('/api/context'));
    const body1 = await res1.json();
    const res2 = await fetch(apiUrl('/api/context'));
    const body2 = await res2.json();

    // Same section keys
    expect(Object.keys(body1.sections).sort()).toEqual(Object.keys(body2.sections).sort());
    // Same tool count
    expect(body1.sections.tools.count).toBe(body2.sections.tools.count);
  });
});
