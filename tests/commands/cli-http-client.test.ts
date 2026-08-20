/**
 * The CLI as an HTTP client of /api/v1 (P1 migration).
 *
 * Runs the REAL command functions (runAdd/runTasks/runDone/…) against a REAL
 * server started on port 0, with OPEN_WALNUT_API_URL pointed at it — so a
 * created task is verified by reading it back over HTTP, exactly the path a
 * user's `open-walnut add` now takes.
 *
 * Zero destructive side effects: the only server is the one this file starts
 * (torn down via stopServer), the dead-port case binds-then-closes its own
 * listener, and no `claude` CLI is ever spawned (no test starts a session).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cli-http'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

/** Everything the command printed to stdout, joined. */
function stdout(): string {
  return logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

/** Everything the command printed to stderr, joined. */
function stderr(): string {
  return errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

/** Parse the single JSON blob a --json command printed. */
function jsonOut<T>(): T {
  return JSON.parse(stdout()) as T;
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return await res.json() as T;
}

/** A port nothing listens on: bind it, read the number, close it. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const addr = probe.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const p = addr.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return p;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
  process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  delete process.env.OPEN_WALNUT_API_URL;
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
  delete process.env.WALNUT_CLI_DIRECT;
  delete process.env.WALNUT_SESSION_ID;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = undefined;
  delete process.env.WALNUT_CLI_DIRECT;
  delete process.env.WALNUT_SESSION_ID;
});

describe('open-walnut add → POST /api/v1/tasks', () => {
  it('creates the task on the server and prints a task-ref tag', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    await runAdd('Water the fig tree', {}, {});

    expect(process.exitCode).toBeUndefined();
    const out = stdout();
    expect(out).toContain('Created task');
    expect(out).toContain('Water the fig tree');
    // The AI-citable handle the web UI renders as a pill.
    expect(out).toMatch(/<task-ref id="[^"]+" label="Water the fig tree"\/>/);

    // The task really exists server-side (single writer = the server).
    const { tasks } = await api<{ tasks: Array<{ title: string }> }>('/api/v1/tasks');
    expect(tasks.some((t) => t.title === 'Water the fig tree')).toBe(true);
  });

  it('--json carries the ref tag in a "ref" field', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    await runAdd('Rotate the SSH key', { priority: 'important' }, { json: true });

    const payload = jsonOut<{ id: string; status: string; ref: string; task: { title: string; priority: string } }>();
    expect(payload.status).toBe('created');
    expect(payload.task.priority).toBe('important');
    expect(payload.ref).toBe(`<task-ref id="${payload.id}" label="Rotate the SSH key"/>`);
  });

  it('sends --list/--project as the project and omits it for Inbox', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    await runAdd('Ship the marina docs', { list: 'marina' }, { json: true });
    expect(jsonOut<{ task: { project: string } }>().task.project).toBe('marina');

    logSpy.mockClear();
    await runAdd('Loose end', {}, { json: true });
    expect(jsonOut<{ task: { project: string } }>().task.project).toBe('');
  });

  it('surfaces the server error message (bad priority) and exits 1', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    await runAdd('Bad input', { priority: 'urgent-ish' }, {});

    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain('priority must be one of');
  });
});

describe('open-walnut tasks → GET /api/v1/tasks', () => {
  it('lists tasks and honours --status / --project filters', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    const { runTasks } = await import('../../src/commands/tasks.js');
    await runAdd('Listing subject', { list: 'acme' }, { json: true });
    logSpy.mockClear();

    await runTasks({}, { json: true });
    const all = jsonOut<Array<{ title: string }>>();
    expect(Array.isArray(all)).toBe(true);
    expect(all.some((t) => t.title === 'Listing subject')).toBe(true);

    logSpy.mockClear();
    await runTasks({ project: 'acme' }, { json: true });
    const filtered = jsonOut<Array<{ project: string }>>();
    expect(filtered.length).toBeGreaterThan(0);
    for (const t of filtered) expect(t.project).toBe('acme');

    logSpy.mockClear();
    await runTasks({ status: 'todo' }, { json: true });
    for (const t of jsonOut<Array<{ status: string }>>()) expect(t.status).toBe('todo');
  });

  it('human mode renders one row per task', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    const { runTasks } = await import('../../src/commands/tasks.js');
    await runAdd('Human row task', {}, { json: true });
    logSpy.mockClear();

    await runTasks({}, {});
    expect(stdout()).toContain('Human row task');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('open-walnut done → POST /api/v1/tasks/:id/complete', () => {
  it('completes by id PREFIX, prints a ref, and the server row is done', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    const { runDone } = await import('../../src/commands/done.js');
    await runAdd('Finish the audit', {}, { json: true });
    const { id } = jsonOut<{ id: string }>();
    logSpy.mockClear();

    // A real PREFIX, not the whole id — task ids start with a base36 timestamp,
    // so trimming only the last char keeps it unique within this file's store.
    await runDone(id.slice(0, -1), {});
    expect(stderr()).toBe('');
    expect(process.exitCode).toBeUndefined();
    const out = stdout();
    expect(out).toContain('Completed');
    expect(out).toContain(`<task-ref id="${id}" label="Finish the audit"/>`);

    const { task } = await api<{ task: { status: string; phase: string; pinned?: boolean } }>(`/api/v1/tasks/${id}`);
    expect(task.status).toBe('done');
    expect(task.phase).toBe('COMPLETE');
  });

  it('unpins the completed task (completeTask semantics, not bare PATCH)', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    const { runDone } = await import('../../src/commands/done.js');
    await runAdd('Pinned then completed', {}, { json: true });
    const { id } = jsonOut<{ id: string }>();

    const pinRes = await fetch(`http://127.0.0.1:${port}/api/v1/focus/tasks/${id}`, { method: 'POST' });
    expect(pinRes.status).toBe(200);
    const before = await api<{ task: { pinned?: boolean } }>(`/api/v1/tasks/${id}`);
    expect(before.task.pinned).toBe(true);

    logSpy.mockClear();
    await runDone(id, { json: true });
    const after = await api<{ task: { pinned?: boolean } }>(`/api/v1/tasks/${id}`);
    expect(after.task.pinned).toBeFalsy();
  });

  // Replaces the deleted "rejects managed agents" pair: `walnut done` no longer
  // asks who is calling, so the contract to pin is that a managed session (the
  // env that used to mean "agent, refuse") completes exactly like a terminal.
  it.each([
    ['HTTP', false],
    ['legacy direct', true],
  ])('completes from inside a managed session too (%s path)', async (_path, direct) => {
    const { runAdd } = await import('../../src/commands/add.js');
    const { runDone } = await import('../../src/commands/done.js');
    await runAdd(`Managed session completion ${_path}`, {}, { json: true });
    const { id } = jsonOut<{ id: string }>();
    logSpy.mockClear();

    process.env.WALNUT_SESSION_ID = 'managed-session';
    if (direct) {
      process.env.WALNUT_CLI_DIRECT = '1';
      // Direct runners are installed by the full CLI entry at boot; direct
      // src imports install them explicitly (see direct-registry.ts).
      const { installDirect } = await import('../../src/commands/direct-commands.js');
      installDirect();
    }
    await runDone(id, { json: true });

    expect(stderr()).toBe('');
    expect(process.exitCode).toBeUndefined();
    expect(jsonOut<{ status: string }>().status).toBe('completed');
    const { task } = await api<{ task: { status: string; phase: string } }>(`/api/v1/tasks/${id}`);
    expect(task.status).toBe('done');
    expect(task.phase).toBe('COMPLETE');
  });

  it('unknown id → server 404 message on stderr, exit 1', async () => {
    const { runDone } = await import('../../src/commands/done.js');
    await runDone('deadbeefdeadbeef', {});
    expect(process.exitCode).toBe(1);
    expect(stderr().toLowerCase()).toContain('no task found');
  });
});

describe('open-walnut recall → GET /api/v1/search', () => {
  it('returns search results as JSON', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    const { runRecall } = await import('../../src/commands/recall.js');
    await runAdd('Recallable pomegranate note', {}, { json: true });
    logSpy.mockClear();

    await runRecall('pomegranate', { json: true });
    const results = jsonOut<Array<{ type: string; title: string }>>();
    expect(Array.isArray(results)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('open-walnut projects → GET /api/v1/projects', () => {
  it('lists registry projects with task counts', async () => {
    const { runAdd } = await import('../../src/commands/add.js');
    const { runProjects } = await import('../../src/commands/projects.js');
    await runAdd('Counted one', { list: 'lighthouse' }, { json: true });
    await runAdd('Counted two', { list: 'lighthouse' }, { json: true });
    logSpy.mockClear();

    await runProjects({ json: true });
    const projects = jsonOut<Array<{ name: string; taskCount: number; activeTasks: number }>>();
    const row = projects.find((p) => p.name === 'lighthouse');
    expect(row).toBeDefined();
    expect(row!.taskCount).toBe(2);
    expect(row!.activeTasks).toBe(2);
  });
});

describe('open-walnut sessions → GET /api/v1/sessions', () => {
  it('returns a JSON array (no sessions started by this test)', async () => {
    const { runSessions } = await import('../../src/commands/sessions.js');
    await runSessions({ json: true });
    expect(Array.isArray(jsonOut<unknown[]>())).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('open-walnut start → POST /api/v1/tasks/:id/start', () => {
  // Only the NOT-FOUND leg is asserted: a successful start would spawn a real
  // `claude` CLI, which this tier must never do.
  it('unknown task → 404 message, exit 1', async () => {
    const { runStart } = await import('../../src/commands/start.js');
    await runStart('nosuchtaskid', {}, {});
    expect(process.exitCode).toBe(1);
    expect(stderr().toLowerCase()).toContain('no task found');
  });
});

describe('server not running', () => {
  it('prints ONE friendly line pointing at `open-walnut web` and exits 1', async () => {
    const dead = await closedPort();
    const saved = process.env.OPEN_WALNUT_API_URL;
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${dead}`;
    try {
      const { runAdd } = await import('../../src/commands/add.js');
      await runAdd('Never lands', {}, {});
      expect(process.exitCode).toBe(1);
      const lines = errSpy.mock.calls.length;
      expect(lines).toBe(1);
      expect(stderr()).toContain('server is not running');
      expect(stderr()).toContain('open-walnut web');
    } finally {
      process.env.OPEN_WALNUT_API_URL = saved;
    }
  });

  it('--json mode reports the same failure as a JSON error', async () => {
    const dead = await closedPort();
    const saved = process.env.OPEN_WALNUT_API_URL;
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${dead}`;
    try {
      const { runTasks } = await import('../../src/commands/tasks.js');
      await runTasks({}, { json: true });
      expect(process.exitCode).toBe(1);
      expect(jsonOut<{ error: string }>().error).toContain('server is not running');
    } finally {
      process.env.OPEN_WALNUT_API_URL = saved;
    }
  });
});

describe('WALNUT_CLI_DIRECT=1 escape hatch', () => {
  it('add still works through the in-process core path', async () => {
    process.env.WALNUT_CLI_DIRECT = '1';
    // Direct runners live in a separate module the data commands can't import
    // (bundle-size seam); the full CLI entry installs them at boot, tests do
    // it explicitly.
    const { installDirect } = await import('../../src/commands/direct-commands.js');
    installDirect();
    // Point the HTTP path at a dead port too: if the direct branch were not
    // taken, this would fail with the unreachable-server message.
    const dead = await closedPort();
    const saved = process.env.OPEN_WALNUT_API_URL;
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${dead}`;
    try {
      const { runAdd } = await import('../../src/commands/add.js');
      await runAdd('Direct path task', {}, { json: true });
      expect(process.exitCode).toBeUndefined();
      const payload = jsonOut<{ id: string; status: string; ref: string }>();
      expect(payload.status).toBe('created');
      expect(payload.ref).toBe(`<task-ref id="${payload.id}" label="Direct path task"/>`);

      // Same store the server reads, so it comes back over HTTP too.
      const { tasks } = await api<{ tasks: Array<{ title: string }> }>('/api/v1/tasks');
      expect(tasks.some((t) => t.title === 'Direct path task')).toBe(true);
    } finally {
      process.env.OPEN_WALNUT_API_URL = saved;
    }
  });
});
