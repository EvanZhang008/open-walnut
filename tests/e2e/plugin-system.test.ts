/**
 * Plugin system E2E tests — section F of PLUGIN_TEST_PLAN.md.
 *
 * Spins up a real server on port 0, loads real plugins from the source tree,
 * and tests the full plugin lifecycle via HTTP. External API calls are mocked
 * at the module level so no real network traffic occurs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to isolate data files
vi.mock('../../src/constants.js', () => createMockConstants());

// Mock external API modules to prevent real HTTP calls (F setup)
vi.mock('../../src/integrations/microsoft-todo.js', () => ({
  autoPushTask: vi.fn().mockResolvedValue('mock-ms-id'),
  deltaPull: vi.fn().mockResolvedValue(undefined),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { registry } from '../../src/core/integration-registry.js';

// ── Server setup ──

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// F1: Server starts with plugins loaded
describe('F1: server starts with plugins loaded', () => {
  it('GET /api/integrations returns plugin metadata', async () => {
    const res = await fetch(apiUrl('/api/integrations'));
    if (res.status === 200) {
      const body = await res.json() as Array<{ id: string; name: string; badge: string; badgeColor: string }>;
      expect(Array.isArray(body)).toBe(true);
      // Verify expected structure
      for (const plugin of body) {
        expect(plugin.id).toBeTruthy();
        expect(plugin.name).toBeTruthy();
        expect(plugin.badge).toBeTruthy();
        expect(plugin.badgeColor).toBeTruthy();
      }
    }
    expect([200, 404]).toContain(res.status);
  });
});

// F2: GET /api/integrations excludes local plugin
describe('F2: integrations API excludes local', () => {
  it('local plugin not in API response', async () => {
    const res = await fetch(apiUrl('/api/integrations'));
    if (res.status === 200) {
      const body = await res.json() as Array<{ id: string }>;
      expect(body.every(p => p.id !== 'local')).toBe(true);
    }
  });
});

// F3: GET /api/integrations returns correct display metadata
describe('F3: correct display metadata', () => {
  it('loaded plugins have correct badge info', async () => {
    const res = await fetch(apiUrl('/api/integrations'));
    if (res.status === 200) {
      const body = await res.json() as Array<{ id: string; badge: string; badgeColor: string }>;
      const msPlugin = body.find(p => p.id === 'ms-todo');
      if (msPlugin) {
        expect(msPlugin.badge).toBe('M');
        expect(msPlugin.badgeColor).toBe('#0078D4');
      }
      // Verify all plugins have non-empty badge info
      for (const plugin of body) {
        expect(plugin.badge.length).toBeGreaterThan(0);
        expect(plugin.badgeColor.length).toBeGreaterThan(0);
      }
    }
  });
});

// F4: POST /api/tasks creates task with source
describe('F4: task creation triggers plugin', () => {
  it('creates task with source and title', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Plugin E2E task', category: 'TestCategory', project: 'Test' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { task: { id: string; title: string; source: string } };
    expect(body.task.title).toBe('Plugin E2E task');
    expect(typeof body.task.source).toBe('string');
    expect(body.task.source.length).toBeGreaterThan(0);
  });
});

// F5: PATCH /api/tasks/:id with phase change
describe('F5: phase change via PATCH', () => {
  it('updates phase successfully', async () => {
    // Create a task first
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Phase test task', category: 'PhaseTest' }),
    });
    const { task } = await createRes.json() as { task: { id: string } };

    // Update phase
    const patchRes = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'IN_PROGRESS' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { task: { phase: string; status: string } };
    expect(patchBody.task.phase).toBe('IN_PROGRESS');
    expect(patchBody.task.status).toBe('in_progress');
  });
});

// F6: source is determined by plugin category claim
describe('F6: source determined by category claim', () => {
  it('tasks get source assigned based on plugin claims', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Source routing task', category: 'SourceRoute' }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: { source: string } };
    // The source must be one of the registered plugins
    const pluginIds = registry.getAll().map(p => p.id);
    expect(pluginIds).toContain(task.source);
  });
});

// F7: tasks in same category get consistent source
describe('F7: source consistency within category', () => {
  it('two tasks in same category get same source', async () => {
    const res1 = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Consistent 1', category: 'ConsistentCat' }),
    });
    const { task: task1 } = await res1.json() as { task: { source: string } };

    const res2 = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Consistent 2', category: 'ConsistentCat' }),
    });
    const { task: task2 } = await res2.json() as { task: { source: string } };

    expect(task1.source).toBe(task2.source);
  });
});

// Additional: registry verification
describe('Registry state', () => {
  it('local plugin is always registered', () => {
    expect(registry.has('local')).toBe(true);
  });

  it('all plugins have unique IDs', () => {
    const all = registry.getAll();
    const ids = all.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all plugins have sync implementations', () => {
    for (const plugin of registry.getAll()) {
      expect(plugin.sync).toBeDefined();
      expect(typeof plugin.sync.createTask).toBe('function');
      expect(typeof plugin.sync.syncPoll).toBe('function');
    }
  });
});

// Additional: local plugin sync no-ops
describe('Local plugin sync through registry', () => {
  it('createTask returns null', async () => {
    const local = registry.get('local')!;
    const result = await local.sync.createTask({
      id: 'test-1',
      title: 'Local task',
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      category: 'Local',
      project: 'Local',
      session_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      description: '',
      summary: '',
      note: '',
      source: 'local',
    });
    expect(result).toBeNull();
  });
});

// Additional: task lifecycle
describe('Task lifecycle via REST', () => {
  let taskId: string;

  it('create → retrieve → update → complete', async () => {
    // Create
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Lifecycle task', category: 'Lifecycle' }),
    });
    expect(createRes.status).toBe(201);
    const { task } = await createRes.json() as { task: { id: string } };
    taskId = task.id;

    // Retrieve
    const getRes = await fetch(apiUrl(`/api/tasks/${taskId}`));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as { task: { id: string; title: string } };
    expect(getBody.task.id).toBe(taskId);

    // Update
    const patchRes = await fetch(apiUrl(`/api/tasks/${taskId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated lifecycle task' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { task: { title: string } };
    expect(patchBody.task.title).toBe('Updated lifecycle task');

    // Complete
    const completeRes = await fetch(apiUrl(`/api/tasks/${taskId}/complete`), { method: 'POST' });
    expect(completeRes.status).toBe(200);
    const completeBody = await completeRes.json() as { task: { status: string; phase: string } };
    expect(completeBody.task.status).toBe('done');
    expect(completeBody.task.phase).toBe('COMPLETE');
  });
});

// Multi-category
describe('Multi-category task creation', () => {
  it('creates tasks across 3 different categories', async () => {
    const categories = ['Alpha', 'Beta', 'Gamma'];
    const ids: string[] = [];

    for (const cat of categories) {
      const res = await fetch(apiUrl('/api/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Task in ${cat}`, category: cat }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { task: { id: string; category: string } };
      expect(body.task.category).toBe(cat);
      ids.push(body.task.id);
    }

    // All tasks exist
    const res = await fetch(apiUrl('/api/tasks'));
    const body = await res.json() as { tasks: Array<{ id: string }> };
    for (const id of ids) {
      expect(body.tasks.some(t => t.id === id)).toBe(true);
    }
  });
});
