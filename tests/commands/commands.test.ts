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
  // Override HOME so that ~/.open-walnut resolves to our temp dir
  env = { ...process.env, HOME: tmpHome } as Record<string, string>;
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
    const result = run('add "High priority work" --json -p immediate -c work --project walnut') as Record<string, unknown>;
    const task = result.task as Record<string, unknown>;

    expect(task.priority).toBe('immediate');
    expect(task.category).toBe('work');
    expect(task.project).toBe('walnut');
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
