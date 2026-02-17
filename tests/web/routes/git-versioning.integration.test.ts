import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// vi.hoisted runs before imports, so it's safe to use in vi.mock factories
const { mockConst, tmpDir } = vi.hoisted(() => {
  const _path = require('node:path');
  const _os = require('node:os');
  const base = _path.join(
    _os.tmpdir(),
    `walnut-git-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const tasksDir = _path.join(base, 'tasks');
  return {
    tmpDir: base as string,
    mockConst: {
      WALNUT_HOME: base,
      TASKS_DIR: tasksDir,
      TASKS_FILE: _path.join(tasksDir, 'tasks.json'),
      ARCHIVE_DIR: _path.join(tasksDir, 'archive'),
      MEMORY_DIR: _path.join(base, 'memory'),
      SESSIONS_DIR: _path.join(base, 'memory', 'sessions'),
      PROJECTS_DIR: _path.join(base, 'memory', 'projects'),
      DAILY_DIR: _path.join(base, 'memory', 'daily'),
      MEMORY_FILE: _path.join(base, 'MEMORY.md'),
      PROJECTS_MEMORY_DIR: _path.join(base, 'memory', 'projects'),
      CONFIG_FILE: _path.join(base, 'config.yaml'),
      SYNC_DIR: _path.join(base, 'sync'),
      SESSIONS_FILE: _path.join(base, 'sessions.json'),
      CLAUDE_HOME: _path.join(base, '.claude'),
      HOOK_LOG_FILE: _path.join(base, 'hook-errors.log'),
      GLOBAL_SKILLS_DIR: _path.join(base, 'skills'),
      CLAUDE_SKILLS_DIR: _path.join(base, '.claude', 'skills'),
      CHAT_HISTORY_FILE: _path.join(base, 'chat-history.json'),
      CRON_FILE: _path.join(base, 'cron-jobs.json'),
      PLUGIN_A_SYNC_FILE: _path.join(base, 'sync', 'plugin-a-sync.json'),
      PLUGIN_B_SYNC_FILE: _path.join(base, 'sync', 'plugin-b-sync.json'),
      USAGE_DB_FILE: _path.join(base, 'usage.sqlite'),
      SESSION_STREAMS_DIR: _path.join(base, 'sessions', 'streams'),
      SESSION_QUEUE_FILE: _path.join(base, 'session-message-queue.json'),
      IMAGES_DIR: _path.join(base, 'images'),
      HEARTBEAT_FILE: _path.join(base, 'HEARTBEAT.md'),
      COMMANDS_DIR: _path.join(base, 'commands'),
      BUILTIN_COMMANDS_DIR: _path.join(base, 'builtin-commands'),
      TIMELINE_DIR: _path.join(base, 'timeline'),
      LOG_DIR: _path.join(base, 'logs'),
      LOG_PREFIX: 'walnut-test-',
    },
  };
});

vi.mock('../../../src/constants.js', () => mockConst);

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
