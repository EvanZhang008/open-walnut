/**
 * E2E tests for the starred feature via REST API and agent tool.
 *
 * Tests:
 * 1. PATCH /api/tasks/:id with { starred: true } → GET confirms starred: true
 * 2. PATCH /api/tasks/:id with { starred: false } → GET confirms starred: false
 * 3. Agent update tool with starred=true → task.starred is true
 * 4. Agent update tool with starred=false → task.starred reverts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { tools } from '../../src/agent/tools.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('Starred via REST API', () => {
  let taskId: string;

  it('create a task', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'REST starred test', priority: 'none', category: 'test' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { task: { id: string; starred?: boolean } };
    taskId = data.task.id;
    // New tasks should not be starred
    expect(data.task.starred).not.toBe(true);
  });

  it('PATCH starred=true sets starred on the task', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { task: { starred: boolean } };
    expect(data.task.starred).toBe(true);
  });

  it('GET confirms starred persisted', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    expect(res.status).toBe(200);
    const data = await res.json() as { task: { starred: boolean } };
    expect(data.task.starred).toBe(true);
  });

  it('PATCH starred=false unsets starred', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: false }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { task: { starred: boolean } };
    expect(data.task.starred).toBe(false);
  });

  it('GET confirms unstarred persisted', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    expect(res.status).toBe(200);
    const data = await res.json() as { task: { starred: boolean } };
    expect(data.task.starred).toBe(false);
  });
});

describe('Starred via agent update_task tool', () => {
  let taskId: string;
  const updateTool = tools.find((t) => t.name === 'update_task')!;

  it('update_task tool exists', () => {
    expect(updateTool).toBeDefined();
    expect(updateTool.execute).toBeTypeOf('function');
  });

  it('create a task for tool testing', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Tool starred test', priority: 'backlog', category: 'test' }),
    });
    const data = await res.json() as { task: { id: string } };
    taskId = data.task.id;
  });

  it('update_task with starred=true sets starred', async () => {
    const result = await updateTool.execute({ id: taskId, starred: true });
    expect(result).toContain('Task updated');
    expect(result).toContain('(starred)');

    // Verify via GET
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    const data = await res.json() as { task: { starred: boolean } };
    expect(data.task.starred).toBe(true);
  });

  it('update_task with starred=false reverts starred', async () => {
    const result = await updateTool.execute({ id: taskId, starred: false });
    expect(result).toContain('Task updated');
    expect(result).toContain('(unstarred)');

    // Verify via GET
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    const data = await res.json() as { task: { starred: boolean } };
    expect(data.task.starred).toBe(false);
  });

  it('update_task with starred="true" (string) also works', async () => {
    // LLMs sometimes send string booleans
    const result = await updateTool.execute({ id: taskId, starred: 'true' });
    expect(result).toContain('Task updated');
    expect(result).toContain('(starred)');

    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    const data = await res.json() as { task: { starred: boolean } };
    expect(data.task.starred).toBe(true);
  });

  it('update_task without starred does not change it', async () => {
    // Task is currently starred from previous test
    const result = await updateTool.execute({ id: taskId, title: 'Renamed tool test' });
    expect(result).toContain('Renamed tool test');
    expect(result).not.toContain('(starred)');
    expect(result).not.toContain('(unstarred)');

    const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
    const data = await res.json() as { task: { starred: boolean; title: string } };
    expect(data.task.starred).toBe(true); // unchanged
    expect(data.task.title).toBe('Renamed tool test');
  });
});
