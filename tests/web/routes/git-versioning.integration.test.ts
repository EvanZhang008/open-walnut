import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

const execFileAsync = promisify(execFile);

// Use the shared helper, NOT a hand-written constant list: every new export in
// src/constants.ts that initDirectories() touches (REPOS_MEMORY_DIR was the last
// one) breaks an inline mock with "No <X> export is defined on the mock".
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-git-integ'));

import { WALNUT_HOME as tmpDir } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { GitVersioningService, setGitVersioning, getGitVersioning } from '../../../src/core/git-versioning.js';
import { addTask } from '../../../src/core/task-manager.js';

async function gitCmd(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: tmpDir });
  return stdout.trim();
}

async function gitLog(): Promise<string[]> {
  const out = await gitCmd(['log', '--oneline', '--format=%s']);
  return out ? out.split('\n') : [];
}

describe('GitVersioningService integration', () => {
  let svc: GitVersioningService;

  beforeAll(async () => {
    // Ensure tmpDir exists
    fs.mkdirSync(tmpDir, { recursive: true });

    // Init git repo
    await gitCmd(['init']);
    await gitCmd(['config', 'user.email', 'test@test.com']);
    await gitCmd(['config', 'user.name', 'Test']);

    // Write comprehensive .gitignore
    fs.writeFileSync(
      path.join(tmpDir, '.gitignore'),
      '*.sqlite\n*.sqlite-shm\n*.sqlite-wal\nimages/\ntimeline/\nsessions/streams/\n*.lock\n*.lock/\n',
      'utf-8',
    );

    // Create required directories
    fs.mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'memory', 'daily'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'memory', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'memory', 'sessions'), { recursive: true });

    // Initial commit
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'tasks.json'), '{"version":2,"tasks":[]}\n', 'utf-8');
    await gitCmd(['add', '-A']);
    await gitCmd(['commit', '-m', 'init']);

    // Start versioning service with short debounce for testing
    svc = new GitVersioningService({ commit_debounce_ms: 200 });
    svc.start();
    setGitVersioning(svc);
  });

  afterAll(async () => {
    if (svc) {
      await svc.destroy();
      setGitVersioning(null);
    }
    try { bus.unsubscribe('git-versioning'); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-commits when a task is created', async () => {
    const commitsBefore = await gitLog();

    // Create a task through task manager + emit event (as REST routes do)
    const { task } = await addTask({ title: 'Integration test task' });
    bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui']);

    // Wait for debounce + commit
    await new Promise((r) => setTimeout(r, 600));

    const commitsAfter = await gitLog();
    expect(commitsAfter.length).toBeGreaterThan(commitsBefore.length);

    // Most recent commit should mention 'task'
    expect(commitsAfter[0]).toContain('task');
  });

  it('.gitignore excludes sqlite and images', async () => {
    // Write files that should be ignored
    fs.mkdirSync(path.join(tmpDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'usage.sqlite'), 'binary', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'images', 'test.png'), 'png data', 'utf-8');

    // Trigger a commit
    bus.emit(EventNames.CONFIG_CHANGED, {}, ['web-ui']);
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'version: 1\n', 'utf-8');
    await new Promise((r) => setTimeout(r, 600));

    // Verify tracked files
    const tracked = await gitCmd(['ls-files']);
    expect(tracked).not.toContain('usage.sqlite');
    expect(tracked).not.toContain('images/');
  });

  it('getGitVersioning returns the singleton', () => {
    expect(getGitVersioning()).toBe(svc);
  });

  it('flush commits immediately', async () => {
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '{"sessions":[]}', 'utf-8');
    bus.emit(EventNames.SESSION_STARTED, { sessionId: 'test-flush' }, ['web-ui']);

    const commitsBefore = await gitLog();
    await svc.flush();
    const commitsAfter = await gitLog();

    expect(commitsAfter.length).toBeGreaterThan(commitsBefore.length);
    expect(commitsAfter[0]).toContain('session');
  });
});
