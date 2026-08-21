/**
 * E2E test for GET /api/task-phase-hooks endpoint.
 *
 * B2: Returns complete hook info via HTTP with enriched fields.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  // This endpoint only reports task hooks that carry a phase filter, and there
  // is no longer a BUILTIN one (human-verified-auto-push died with the
  // HUMAN_VERIFIED phase). Seed a declarative one so the endpoint still has
  // something real to report.
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), yaml.dump({
    hooks: {
      defs: [{
        id: 'config-phase-message',
        name: 'Message the session on AGENT_COMPLETE',
        on: ['onTaskPhaseChanged'],
        action: { type: 'send_message_to_session', message: 'Task {{task.title}} needs attention' },
        filter: { phases: ['AGENT_COMPLETE'], requiresSession: true },
      }],
    },
  }));
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

interface HookInfo {
  id: string;
  name: string;
  description: string;
  triggerPhase: string;
  fromPhases?: string[];
  actionType: string;
  actionDetail: string;
  conditions: string[];
  priority: number;
}

describe('GET /api/task-phase-hooks (B2)', () => {
  it('returns 200 with a JSON array of hook info objects', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    expect(res.status).toBe(200);

    const body = await res.json() as HookInfo[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('each hook has actionDetail and conditions fields', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    const body = await res.json() as HookInfo[];

    for (const hook of body) {
      expect(hook.actionDetail).toBeDefined();
      expect(typeof hook.actionDetail).toBe('string');
      expect(hook.conditions).toBeDefined();
      expect(Array.isArray(hook.conditions)).toBe(true);
    }
  });

  it('reports a phase-filtered task hook with the full enriched shape', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    const body = await res.json() as HookInfo[];

    const hook = body.find(h => h.id === 'config-phase-message');
    expect(hook).toBeDefined();
    expect(hook!.actionType).toBe('send_message');
    // (WAIT removed 2026-08-18 — the fixture hook now filters on AGENT_COMPLETE.)
    expect(hook!.triggerPhase).toBe('AGENT_COMPLETE');
    expect(hook!.actionDetail).toMatch(/^Send message:/);
    expect(hook!.conditions).toEqual(['Requires active session']);
    expect(hook!.priority).toBe(100);
  });

  // Nothing built-in fires on a phase change any more — the human/AI verify
  // hook was the only one and it is deleted, not replaced.
  it('ships no built-in task-phase hook', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    const body = await res.json() as HookInfo[];
    expect(body.map(h => h.id)).not.toContain('human-verified-auto-push');
  });
});
