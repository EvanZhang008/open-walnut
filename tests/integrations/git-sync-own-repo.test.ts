/**
 * The data home's git sync acts on a repository of its own, never on one the data
 * home merely sits inside (a home directory kept in git, a project checkout).
 * 2026-10-30: a fresh install whose data home lay inside a checkout staged the
 * checkout's own files with every auto-commit. Real git, temp dirs only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dirs = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('node:os') as typeof import('node:os');
  const outer = p.join(o.tmpdir(), `walnut-own-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { outer, home: p.join(outer, 'nested', '.open-walnut') };
});

vi.mock('../../src/constants.js', async () => {
  const { createMockConstants } = await import('../helpers/mock-constants.js');
  return createMockConstants('walnut-own-repo', { WALNUT_HOME: dirs.home });
});

import { commitIfDirty, ensureRepo, isOwnRepoPrefix } from '../../src/integrations/git-sync.js';
import { compactGitHistory } from '../../src/integrations/git-compaction.js';
import { maintainRepo } from '../../src/integrations/git-maintenance.js';

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() }).trim();

beforeEach(() => {
  fs.rmSync(dirs.outer, { recursive: true, force: true });
  fs.mkdirSync(dirs.home, { recursive: true });
  git(dirs.outer, 'init', '-q');
  git(dirs.outer, 'config', 'user.name', 'Outer');
  git(dirs.outer, 'config', 'user.email', 'outer@example.invalid');
  fs.writeFileSync(path.join(dirs.outer, 'outer-file.txt'), 'the outer repo\n');
  git(dirs.outer, 'add', 'outer-file.txt');
  git(dirs.outer, 'commit', '-q', '-m', 'outer');
  fs.writeFileSync(path.join(dirs.outer, 'outer-untracked.txt'), 'not walnut data\n');
});

afterEach(() => {
  fs.rmSync(dirs.outer, { recursive: true, force: true });
});

describe('a data home inside another repository', () => {
  it('isOwnRepoPrefix: only an empty prefix (the top of a work tree) is its own repo', () => {
    expect(isOwnRepoPrefix('')).toBe(true);
    expect(isOwnRepoPrefix('\n')).toBe(true);
    expect(isOwnRepoPrefix('nested/.open-walnut/')).toBe(false);
    expect(isOwnRepoPrefix(null)).toBe(false);
  });

  it('compaction and maintenance stand down in a data home that is not its own repo', async () => {
    const outerHead = git(dirs.outer, 'rev-parse', 'HEAD');
    expect(await compactGitHistory(dirs.home)).toMatchObject({ skipped: true });
    expect((await maintainRepo(dirs.home, { force: true })).ran).toBe(false);
    expect(git(dirs.outer, 'rev-parse', 'HEAD')).toBe(outerHead);
    expect(git(dirs.outer, 'branch', '--list')).toMatch(/^\* (main|master)$/);
  });

  it('ensureRepo gives the data home a repo of its own, and a commit never touches the outer one', async () => {
    const outerHead = git(dirs.outer, 'rev-parse', 'HEAD');
    expect(ensureRepo()).toMatchObject({ available: true });
    expect(fs.existsSync(path.join(dirs.home, '.git'))).toBe(true);
    expect(git(dirs.home, 'rev-parse', '--show-toplevel')).toBe(fs.realpathSync(dirs.home));

    fs.writeFileSync(path.join(dirs.home, 'MEMORY.md'), '# memory\n');
    await commitIfDirty();
    // The outer repo: same HEAD, nothing staged, its untracked file still untracked.
    expect(git(dirs.outer, 'rev-parse', 'HEAD')).toBe(outerHead);
    expect(git(dirs.outer, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(dirs.outer, 'status', '--porcelain')).toContain('?? outer-untracked.txt');
    // The data home's own repo has the data.
    expect(git(dirs.home, 'log', '--name-only', '--format=')).toContain('MEMORY.md');
  });
});
