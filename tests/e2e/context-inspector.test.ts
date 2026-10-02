/**
 * E2E tests for the Context Inspector feature.
 *
 * Spins up a real server with Express + WebSocket, then tests:
 * - GET /api/context returns the launch-config sections of the session that answers
 * - Token counts are consistent
 *
 * Every chat turn runs in a `claude` CLI session (dae90b5d), so the tool list,
 * the message transcript and the compaction summary live in the CLI and are not
 * sections here any more; tests/web/routes/context-inspector.test.ts pins the
 * per-section contract in detail.
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

  it('returns exactly the launch-config sections', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();
    const sectionNames = Object.keys(body.sections).sort();

    expect(sectionNames).toEqual(['globalMemory', 'modelConfig', 'roleAndRules', 'skills']);
    // The session CLI owns these, so a zeroed copy would read as "the model got
    // none of that" (removed in dae90b5d).
    for (const removed of ['tools', 'apiMessages', 'compactionSummary', 'taskProjects', 'userProfile', 'notesContext', 'dailyLogs', 'projectSummaries']) {
      expect(sectionNames).not.toContain(removed);
    }
  });

  it('roleAndRules section is non-empty and describes Walnut', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();
    const role = body.sections.roleAndRules.content as string;

    expect(role.length).toBeGreaterThan(0);
    expect(role).toContain('Walnut');
  });

  it('totalTokens is the system prompt, which already contains memory and skills', async () => {
    const res = await fetch(apiUrl('/api/context'));
    const body = await res.json();
    const { sections, totalTokens } = body;

    expect(totalTokens).toBe(sections.roleAndRules.tokens);
    // Skills and standing memory are substrings of that same prompt, so each is
    // part of the total rather than an addition to it.
    expect(sections.skills.tokens).toBeGreaterThan(0);
    expect(sections.globalMemory.tokens).toBeGreaterThan(0);
    expect(sections.skills.tokens).toBeLessThan(totalTokens);
    expect(sections.globalMemory.tokens).toBeLessThan(totalTokens);
    expect(sections.modelConfig.tokens).toBe(0);
  });

  it('subsequent requests return consistent structure', async () => {
    const res1 = await fetch(apiUrl('/api/context'));
    const body1 = await res1.json();
    const res2 = await fetch(apiUrl('/api/context'));
    const body2 = await res2.json();

    // Same section keys
    expect(Object.keys(body1.sections).sort()).toEqual(Object.keys(body2.sections).sort());
    // Same prompt: no conversation has a session yet, so both describe the next spawn.
    expect(body1.engine).toBe(body2.engine);
    expect(body1.totalTokens).toBe(body2.totalTokens);
  });
});
