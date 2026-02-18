import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to redirect to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import {
  isGitAvailable,
  getSyncStatus,
  initSync,
  sync,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('isGitAvailable', () => {
  it('returns true when git is installed', () => {
    expect(isGitAvailable()).toBe(true);
  });
});

describe('getSyncStatus', () => {
  it('returns not initialized when no git repo', () => {
    const status = getSyncStatus();
    expect(status.initialized).toBe(false);
    expect(status.remoteConfigured).toBe(false);
    expect(status.lastSyncAt).toBeNull();
    expect(status.pendingChanges).toBe(0);
    expect(status.branch).toBe('main');
  });

  it('returns initialized after initSync', () => {
    initSync();
    const status = getSyncStatus();
    expect(status.initialized).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.remoteConfigured).toBe(false);
  });
});

describe('initSync', () => {
  it('creates a git repo in WALNUT_HOME', () => {
    initSync();
    // Verify .git directory exists
    const result = execSync('git rev-parse --is-inside-work-tree', {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
    expect(result).toBe('true');
  });

  it('creates .gitignore', async () => {
    initSync();
    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('ms-todo-tokens.json');
  });

  it('creates initial commit', () => {
    initSync();
    const log = execSync('git log --oneline -1', {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
    expect(log).toContain('walnut init');
  });

  it('is idempotent - can be called twice', () => {
    initSync();
    initSync(); // Should not throw
    const status = getSyncStatus();
    expect(status.initialized).toBe(true);
  });
});

describe('sync', () => {
  it('commits pending changes', async () => {
    initSync();

    // Create a new file to trigger a commit
    await fsp.writeFile(path.join(tmpDir, 'test-file.txt'), 'test content');

    const result = sync();
    // Should have committed the change (pushed=1 means commit was created)
    expect(result.pushed).toBe(1);
    expect(result.conflicts).toBe(0);
  });

  it('reports no changes when repo is clean', () => {
    initSync();

    const result = sync();
    // No new files, so no push
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(result.conflicts).toBe(0);
  });

  it('shows zero pending after sync', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, 'pending.txt'), 'data');

    sync();

    const status = getSyncStatus();
    expect(status.pendingChanges).toBe(0);
  });
});
