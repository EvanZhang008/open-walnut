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
  tmpHome = path.join(os.tmpdir(), `walnut-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpHome, { recursive: true });
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

describe('CLI integration: recall command', () => {
  it('searches tasks and returns JSON results', () => {
    // First add a task so there is something to search
    run('add "Buy groceries for dinner" --json');
    run('add "Fix login bug" --json');

    const results = run('recall "groceries" --json') as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Should find the groceries task
    const found = results.some(
      (r: any) => r.type === 'task' && r.title.includes('groceries'),
    );
    expect(found).toBe(true);
  });

  it('returns empty array when nothing matches', () => {
    run('add "Some task" --json');
    const results = run('recall "zzzznonexistent" --json') as unknown[];
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });
});

describe('CLI integration: projects command', () => {
  it('lists projects from tasks as JSON', () => {
    run('add "Work task" --json --project walnut');
    run('add "Another work task" --json --project walnut');
    run('add "Personal task" --json');

    const projects = run('projects --json') as any[];
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThanOrEqual(1);

    const walnut = projects.find((p) => p.name === 'walnut');
    expect(walnut).toBeDefined();
    expect(walnut.taskCount).toBe(2);
    expect(walnut.activeTasks).toBe(2);
  });

  it('returns empty array when no tasks', () => {
    const projects = run('projects --json') as unknown[];
    expect(Array.isArray(projects)).toBe(true);
    expect(projects).toHaveLength(0);
  });
});

describe('CLI integration: sessions command', () => {
  it('returns JSON array (empty initially)', () => {
    const sessions = run('sessions --json') as unknown[];
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions).toHaveLength(0);
  });
});

describe('CLI integration: sync command', () => {
  it('returns status via --status --json', () => {
    const status = run('sync --status --json') as Record<string, unknown>;
    expect(status).toHaveProperty('git');
    const git = status.git as Record<string, unknown>;
    expect(git).toHaveProperty('initialized');
    expect(git.initialized).toBe(false);
  });
});
