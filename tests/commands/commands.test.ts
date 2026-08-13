import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(PROJECT_ROOT, 'dist', 'cli.js');

let tmpHome: string;
let env: Record<string, string>;

beforeAll(() => {
  // Build the project before running integration tests
  execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe' });
});

beforeEach(async () => {
  tmpHome = path.join(os.tmpdir(), `walnut-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpHome, { recursive: true });
  // HOME alone is NOT enough: the child inherits OPEN_WALNUT_HOME from the vitest
  // globalSetup (a shared /tmp/open-walnut-test-global), and that env var OUTRANKS
  // HOME in resolveOpenWalnutHome(). Without overriding it every CLI run in every
  // file shares one store — leftover project rows then decide the canonical
  // spelling of a project this test creates ("Walnut" vs "walnut").
  // WALNUT_CLI_DIRECT=1 is MANDATORY here, not a preference: the CLI now
  // defaults to HTTP against http://127.0.0.1:3456 — the PRODUCTION server on a
  // developer's Mac. Without this pin, every `add`/`done` below would write into
  // the user's real task store. This file's whole premise is an isolated temp
  // home, which only the direct path honours; the HTTP path is covered by
  // tests/commands/cli-http-client.test.ts against its own port-0 server.
  env = {
    ...process.env,
    HOME: tmpHome,
    OPEN_WALNUT_HOME: tmpHome,
    WALNUT_CLI_DIRECT: '1',
  } as Record<string, string>;
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function run(args: string): unknown {
  const stdout = execSync(`node ${CLI} ${args}`, {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return JSON.parse(stdout.trim());
}

describe('CLI integration: add command', () => {
  it('adds a task and returns JSON with id and status', () => {
    const result = run('add "Integration test task" --json') as Record<string, unknown>;

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('status', 'created');
    expect(result).toHaveProperty('task');
    const task = result.task as Record<string, unknown>;
    expect(task.title).toBe('Integration test task');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('none');
  });

  it('adds a task with options', () => {
    // Project is the only grouping layer: `-l, --list <project>`.
    const result = run('add "High priority work" --json -p immediate -l walnut') as Record<string, unknown>;
    const task = result.task as Record<string, unknown>;

    expect(task.priority).toBe('immediate');
    expect(task.project).toBe('walnut');
    expect(task).not.toHaveProperty('category');
  });

  it('--project is an alias for -l and omitting both files the task in Inbox', () => {
    const aliased = run('add "Alias route" --json --project walnut') as Record<string, unknown>;
    expect((aliased.task as Record<string, unknown>).project).toBe('walnut');

    const inbox = run('add "No project" --json') as Record<string, unknown>;
    expect((inbox.task as Record<string, unknown>).project).toBe('');
  });
});

describe('CLI integration: tasks command', () => {
  it('lists tasks as JSON array', () => {
    run('add "Task for listing" --json');
    run('add "Another task" --json');

    const tasks = run('tasks --json') as unknown[];
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it('filters tasks by status', () => {
    run('add "Todo task" --json');

    const todos = run('tasks --json -s todo') as unknown[];
    expect(todos.length).toBeGreaterThanOrEqual(1);
    for (const t of todos) {
      expect((t as Record<string, unknown>).status).toBe('todo');
    }
  });
});

describe('CLI integration: done command', () => {
  it('completes a task and returns JSON', () => {
    const addResult = run('add "Task to complete" --json') as Record<string, unknown>;
    const id = addResult.id as string;

    const doneResult = run(`done ${id} --json`) as Record<string, unknown>;
    expect(doneResult).toHaveProperty('status', 'completed');
    expect(doneResult).toHaveProperty('task');
    expect((doneResult.task as Record<string, unknown>).status).toBe('done');
  });

  it('completes a task by partial ID', () => {
    const addResult = run('add "Partial ID task" --json') as Record<string, unknown>;
    const id = (addResult.id as string).slice(0, 6);

    const doneResult = run(`done ${id} --json`) as Record<string, unknown>;
    expect(doneResult).toHaveProperty('status', 'completed');
  });
});

describe('CLI integration: dashboard (default command)', () => {
  it('outputs dashboard JSON with stats', () => {
    run('add "Dashboard task" --json');

    const data = run('--json') as Record<string, unknown>;
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('urgent_tasks');
    expect(data).toHaveProperty('today_tasks');
    expect(data).toHaveProperty('recent_tasks');

    const stats = data.stats as Record<string, number>;
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });
});
