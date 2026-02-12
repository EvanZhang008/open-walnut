import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// Mock WALNUT_HOME to a temp dir
let tmpDir: string;

vi.mock('../../src/constants.js', () => ({
  get WALNUT_HOME() { return tmpDir; },
  get MEMORY_DIR() { return path.join(tmpDir, 'memory'); },
}));

// We need a real event bus for testing event subscriptions
import { bus, EventNames } from '../../src/core/event-bus.js';
import { GitVersioningService } from '../../src/core/git-versioning.js';

async function gitCmd(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function gitLog(cwd: string): Promise<string[]> {
  const out = await gitCmd(['log', '--oneline', '--format=%s'], cwd);
  return out ? out.split('\n') : [];
}

describe('GitVersioningService', () => {
  let svc: GitVersioningService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-git-test-'));
    // Init a git repo in tmpDir
    await gitCmd(['init'], tmpDir);
    await gitCmd(['config', 'user.email', 'test@test.com'], tmpDir);
    await gitCmd(['config', 'user.name', 'Test'], tmpDir);
    // Create initial commit
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.sqlite\n', 'utf-8');
    await gitCmd(['add', '-A'], tmpDir);
    await gitCmd(['commit', '-m', 'init'], tmpDir);
  });

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
    }
    // Clean up bus subscriptions
    try { bus.unsubscribe('git-versioning'); } catch {}
    // Remove tmpDir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('commits after debounce when dirty files are tracked', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 100 });
    svc.start();

    // Write a file that simulates a task change
    fs.mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'tasks.json'), '{"tasks":[]}', 'utf-8');

    // Emit a task event (git-versioning is a global subscriber, so destinations don't matter)
    bus.emit(EventNames.TASK_CREATED, { task: { id: 't1', title: 'Test task' } }, ['web-ui']);

    // Wait for debounce + commit
    await new Promise((r) => setTimeout(r, 500));

    const commits = await gitLog(tmpDir);
    expect(commits[0]).toContain('task:');
    expect(commits[0]).toContain('Test task');
  });

  it('collapses multiple events in same category into one commit', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 100 });
    svc.start();

    fs.mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'tasks.json'), '{"tasks":[1]}', 'utf-8');

    // Emit multiple task events rapidly
    bus.emit(EventNames.TASK_CREATED, { task: { id: 't1', title: 'Task A' } }, ['web-ui']);
    bus.emit(EventNames.TASK_UPDATED, { task: { id: 't2', title: 'Task B' } }, ['web-ui']);
    bus.emit(EventNames.TASK_COMPLETED, { task: { id: 't3', title: 'Task C' } }, ['web-ui']);

    await new Promise((r) => setTimeout(r, 500));

    const commits = await gitLog(tmpDir);
    // All events map to tasks/tasks.json — last one overwrites; single debounce = one commit
    expect(commits).toHaveLength(2); // init + 1 auto commit
  });

  it('creates multi-category commit message when different files change', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 100 });
    svc.start();

    fs.mkdirSync(path.join(tmpDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'tasks.json'), '{"tasks":[]}', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '{"sessions":[]}', 'utf-8');

    // Emit events for different categories
    bus.emit(EventNames.TASK_CREATED, { task: { id: 't1', title: 'A' } }, ['web-ui']);
    bus.emit(EventNames.SESSION_STARTED, { sessionId: 's1' }, ['web-ui']);

    await new Promise((r) => setTimeout(r, 500));

    const commits = await gitLog(tmpDir);
    expect(commits[0]).toContain('auto:');
    expect(commits[0]).toContain('2 changes');
  });

  it('notifyMemoryChange marks dirty and commits', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 100 });
    svc.start();

    const dailyDir = path.join(tmpDir, 'memory', 'daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(path.join(dailyDir, '2026-02-19.md'), '## 10:00\nDid stuff\n', 'utf-8');

    svc.notifyMemoryChange('daily/2026-02-19.md');

    await new Promise((r) => setTimeout(r, 500));

    const commits = await gitLog(tmpDir);
    expect(commits[0]).toContain('memory:');
    expect(commits[0]).toContain('2026-02-19.md');
  });

  it('flush commits immediately without waiting for debounce', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 60_000 }); // Long debounce
    svc.start();

    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'version: 1\n', 'utf-8');
    bus.emit(EventNames.CONFIG_CHANGED, {}, ['web-ui']);

    // Flush should commit immediately
    await svc.flush();

    const commits = await gitLog(tmpDir);
    expect(commits[0]).toContain('config');
  });

  it('serial queue prevents concurrent git operations', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 50 });
    svc.start();

    // Rapid events that each create a file
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), `data${i}`, 'utf-8');
      svc.notifyMemoryChange(`file${i}.txt`);
      await new Promise((r) => setTimeout(r, 10));
    }

    // Wait for all debounces to fire + commits to complete
    await new Promise((r) => setTimeout(r, 500));
    await svc.flush();

    // Should not have any errors (no index.lock conflicts)
    const commits = await gitLog(tmpDir);
    expect(commits.length).toBeGreaterThanOrEqual(2); // init + at least 1 auto commit
  });

  it('graceful degradation on commit failure (nothing to commit)', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 50 });
    svc.start();

    // Emit event but don't write any actual file changes
    bus.emit(EventNames.CONFIG_CHANGED, {}, ['web-ui']);

    // Should not throw
    await new Promise((r) => setTimeout(r, 200));
  });

  it('destroy flushes pending dirty and unsubscribes', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 60_000 });
    svc.start();

    fs.writeFileSync(path.join(tmpDir, 'sessions.json'), '{}', 'utf-8');
    bus.emit(EventNames.SESSION_STARTED, { sessionId: 's1' }, ['web-ui']);

    // destroy should flush
    await svc.destroy();

    const commits = await gitLog(tmpDir);
    expect(commits[0]).toContain('session');
  });

  it('respects .gitignore — sqlite files not committed', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 100 });
    svc.start();

    // Write both an ignored and a tracked file
    fs.writeFileSync(path.join(tmpDir, 'usage.sqlite'), 'binary data', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'version: 1\n', 'utf-8');

    bus.emit(EventNames.CONFIG_CHANGED, {}, ['web-ui']);
    await new Promise((r) => setTimeout(r, 500));

    // Check tracked files
    const tracked = await gitCmd(['ls-files'], tmpDir);
    expect(tracked).toContain('config.yaml');
    expect(tracked).not.toContain('usage.sqlite');
  });

  // Subtask events test removed — subtask events no longer exist in the plugin system

  it('handles cron events', async () => {
    svc = new GitVersioningService({ commit_debounce_ms: 100 });
    svc.start();

    fs.writeFileSync(path.join(tmpDir, 'cron-jobs.json'), '[]', 'utf-8');

    bus.emit('cron:job-added' as any, { id: 'j1', name: 'test' }, ['web-ui']);

    await new Promise((r) => setTimeout(r, 500));

    const commits = await gitLog(tmpDir);
    expect(commits[0]).toContain('cron');
  });
});
