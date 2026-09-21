/**
 * git-sync must not honour an inherited GIT_DIR — the production half of the
 * 2026-09-20 class.
 *
 * The test-harness version of this bug put a candidate tree's snapshot on this
 * repo's main branch. The same shape reaches production through a different door:
 * git EXPORTS GIT_DIR while running its own hooks (scripts/cloud/setup.sh already
 * unsets it for that reason), so a Walnut server started from a hook — a post-merge
 * redeploy, say — would have every git-sync call resolve to that repo instead of
 * ~/.open-walnut, and the 30-second auto-commit would write the data repo's state
 * into it.
 *
 * `gitChildEnv()` (src/lib/git-env.ts) is the fix, and these tests drive the real
 * `git()` / `gitAsync()` helpers with a poisoned process.env to prove it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { removeTempTree } from '../helpers/temp-home.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-gitenv-test'));

import { git, gitAsync, gitSafe } from '../../src/integrations/git-sync.js';
import { gitChildEnv, GIT_REPO_REDIRECT_VARS } from '../../src/lib/git-env.js';
import { WALNUT_HOME } from '../../src/constants.js';

function plainGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    // The probe must read the repo it names, not whatever this test poisoned.
    env: gitChildEnv(),
  }).trim();
}

let root: string;
let elsewhere: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const name of GIT_REPO_REDIRECT_VARS) saved[name] = process.env[name];
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-sync-env-redirect-'));
  elsewhere = path.join(root, 'elsewhere');

  // The repo git-sync owns…
  await removeTempTree(WALNUT_HOME);
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
  plainGit(['init', '-q', '-b', 'main'], WALNUT_HOME);
  plainGit(['config', 'user.email', 'walnut@localhost'], WALNUT_HOME);
  plainGit(['config', 'user.name', 'Open Walnut'], WALNUT_HOME);

  // …and the repo an inherited GIT_DIR would hijack it into.
  fs.mkdirSync(elsewhere, { recursive: true });
  plainGit(['init', '-q', '-b', 'main'], elsewhere);
  plainGit(['config', 'user.email', 'other@example.com'], elsewhere);
  plainGit(['config', 'user.name', 'Other'], elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'theirs.txt'), 'theirs\n');
  plainGit(['add', '-A'], elsewhere);
  plainGit(['commit', '-q', '-m', 'their base'], elsewhere);
});

afterEach(async () => {
  for (const name of GIT_REPO_REDIRECT_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await removeTempTree(WALNUT_HOME);
  await fsp.rm(root, { recursive: true, force: true });
});

describe('git-sync ignores an inherited git redirect', () => {
  it('git() commits into WALNUT_HOME even when GIT_DIR names another repo', () => {
    const theirTip = plainGit(['rev-parse', 'HEAD'], elsewhere);
    process.env.GIT_DIR = path.join(elsewhere, '.git');
    process.env.GIT_WORK_TREE = elsewhere;

    fs.writeFileSync(path.join(WALNUT_HOME, 'mine.md'), 'walnut data\n');
    git('add -A');
    git('commit -q -m "walnut auto-save"');

    expect(plainGit(['log', '--format=%s', '-1'], WALNUT_HOME)).toBe('walnut auto-save');
    expect(plainGit(['show', '--stat', '--format=', 'HEAD'], WALNUT_HOME)).toContain('mine.md');
    // The other repo gained nothing and stayed clean.
    expect(plainGit(['rev-parse', 'HEAD'], elsewhere)).toBe(theirTip);
    expect(plainGit(['status', '--porcelain'], elsewhere)).toBe('');
  });

  it('gitAsync() (the tick path) resolves to WALNUT_HOME too', async () => {
    process.env.GIT_DIR = path.join(elsewhere, '.git');

    const toplevel = await gitAsync('rev-parse --show-toplevel');
    expect(fs.realpathSync(toplevel)).toBe(fs.realpathSync(WALNUT_HOME));
  });

  it('an inherited GIT_INDEX_FILE cannot move where git-sync stages', () => {
    const foreign = path.join(root, 'foreign.index');
    process.env.GIT_INDEX_FILE = foreign;

    fs.writeFileSync(path.join(WALNUT_HOME, 'staged.md'), 'x\n');
    git('add -A');

    expect(fs.existsSync(foreign)).toBe(false);
    expect(gitSafe('diff --cached --name-only')).toBe('staged.md');
  });

  it('an explicit env argument still wins (a caller choosing a repo is not an inherit)', () => {
    process.env.GIT_DIR = path.join(elsewhere, '.git');
    const env = gitChildEnv({ GIT_DIR: path.join(WALNUT_HOME, '.git') });
    expect(env.GIT_DIR).toBe(path.join(WALNUT_HOME, '.git'));
  });
});
