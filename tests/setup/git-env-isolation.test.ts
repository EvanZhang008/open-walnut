/**
 * Ratchet for tests/setup/git-env-isolation.ts — the 2026-09-20 stray-commit class.
 *
 * The incident: a run launched with GIT_DIR / GIT_WORK_TREE still exported made
 * every `execSync('git …', { cwd: tmpDir })` in the git suites address the REAL
 * open-walnut repo. `git init` rewrote its config (identity + core.worktree) and
 * one `git add -A && git commit -m init` put a candidate snapshot on main.
 *
 * The first test below reproduces that shape against a throwaway VICTIM repo and
 * proves the strip keeps the writes inside the temp repo. Remove the strip and it
 * fails the way the real repo did: the victim gains a commit it never asked for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GIT_REDIRECT_ENV_VARS, stripGitRedirectEnv } from './git-env-isolation';

/** Run git the way the git suites do: cwd + inherited process.env. */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** `git config --get` exits 1 for an absent key, so absence needs its own reader. */
function gitConfigOrNull(key: string, cwd: string): string | null {
  try {
    return git(['config', '--get', key], cwd);
  } catch {
    return null;
  }
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'victim@example.com'], dir);
  git(['config', 'user.name', 'Victim'], dir);
  fs.writeFileSync(path.join(dir, 'kept.txt'), 'original\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'victim base'], dir);
}

let root: string;
let victim: string;
let scratch: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const name of GIT_REDIRECT_ENV_VARS) saved[name] = process.env[name];
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-env-isolation-'));
  victim = path.join(root, 'victim');
  scratch = path.join(root, 'scratch');
  initRepo(victim);
  fs.mkdirSync(scratch, { recursive: true });
});

afterEach(async () => {
  for (const name of GIT_REDIRECT_ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await fsp.rm(root, { recursive: true, force: true });
});

describe('git env isolation', () => {
  it('a test repo built under an inherited GIT_DIR/GIT_WORK_TREE cannot reach the victim', () => {
    const victimHead = git(['rev-parse', 'HEAD'], victim);
    // The launcher's leftovers, exactly as the incident had them.
    process.env.GIT_DIR = path.join(victim, '.git');
    process.env.GIT_WORK_TREE = scratch;

    // Deliberately NOT asserting the return value here: this test's job is to fail
    // on the DAMAGE (the victim's tip and config) the way the real repo showed it,
    // so removing the strip reproduces the incident rather than a bookkeeping diff.
    stripGitRedirectEnv();

    // What the git suites do in beforeEach + a commit, all with cwd = temp dir.
    git(['init', '-q', '-b', 'main'], scratch);
    git(['config', 'user.email', 't@t'], scratch);
    git(['config', 'user.name', 't'], scratch);
    fs.writeFileSync(path.join(scratch, 'a.md'), 'x\n');
    git(['add', '-A'], scratch);
    git(['commit', '-q', '-m', 'init'], scratch);

    // The temp repo owns the commit…
    expect(fs.existsSync(path.join(scratch, '.git'))).toBe(true);
    expect(git(['log', '--format=%s', '-1'], scratch)).toBe('init');

    // …and the victim is byte-for-byte what it was: same tip, its own identity,
    // no core.worktree redirect, nothing staged.
    expect(git(['rev-parse', 'HEAD'], victim)).toBe(victimHead);
    expect(git(['log', '--oneline'], victim).split('\n')).toHaveLength(1);
    expect(git(['config', 'user.email'], victim)).toBe('victim@example.com');
    expect(gitConfigOrNull('core.worktree', victim)).toBeNull();
    expect(git(['status', '--porcelain'], victim)).toBe('');
  });

  it('an inherited GIT_INDEX_FILE cannot make a test stage into someone else\'s index', () => {
    const foreignIndex = path.join(root, 'foreign.index');
    process.env.GIT_INDEX_FILE = foreignIndex;
    stripGitRedirectEnv();

    git(['init', '-q', '-b', 'main'], scratch);
    fs.writeFileSync(path.join(scratch, 'b.md'), 'y\n');
    git(['add', '-A'], scratch);

    expect(fs.existsSync(foreignIndex)).toBe(false);
    expect(git(['diff', '--cached', '--name-only'], scratch)).toBe('b.md');
  });

  it('sweeps the numbered GIT_CONFIG_* override pairs, not just the named vars', () => {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.name';
    process.env.GIT_CONFIG_VALUE_0 = 'Injected';
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'nope.gitconfig');

    const removed = stripGitRedirectEnv();
    expect(removed).toEqual(expect.arrayContaining(
      ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'],
    ));
    expect(process.env.GIT_CONFIG_KEY_0).toBeUndefined();

    git(['init', '-q', '-b', 'main'], scratch);
    git(['config', 'user.email', 't@t'], scratch);
    git(['config', 'user.name', 't'], scratch);
    fs.writeFileSync(path.join(scratch, 'c.md'), 'z\n');
    git(['add', '-A'], scratch);
    git(['commit', '-q', '-m', 'init'], scratch);
    expect(git(['log', '--format=%an', '-1'], scratch)).toBe('t');
  });

  it('leaves identity vars alone (they cannot redirect a write)', () => {
    process.env.GIT_AUTHOR_NAME = 'Someone';
    try {
      stripGitRedirectEnv();
      expect(process.env.GIT_AUTHOR_NAME).toBe('Someone');
    } finally {
      delete process.env.GIT_AUTHOR_NAME;
    }
  });

  it('every vitest config loads the strip — directly or by inheriting the base', () => {
    // A tier config that declares its own `setupFiles` REPLACES the base list, so
    // a new config is one line away from re-opening the hole. Twelve configs exist;
    // this pins the rule rather than the count.
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const configs = fs.readdirSync(repoRoot)
      .filter((f) => /^vitest(\..+)?\.config\.ts$/.test(f))
      .concat(fs.readdirSync(path.join(repoRoot, 'web'))
        .filter((f) => /^vitest(\..+)?\.config\.ts$/.test(f))
        .map((f) => path.join('web', f)));
    expect(configs.length).toBeGreaterThan(5);

    const missing = configs.filter((rel) => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      if (src.includes('git-env-isolation')) return false;
      // mergeConfig(baseConfig, …) inherits the base setupFiles unless it also
      // declares its own — declaring one without the strip is the hole.
      return !(src.includes('mergeConfig') && !/setupFiles\s*:/.test(src));
    });
    expect(missing, 'these vitest configs would run git tests with an inherited GIT_DIR').toEqual([]);
  });

  it('is already in effect in this worker (the setupFile ran)', () => {
    for (const name of GIT_REDIRECT_ENV_VARS) {
      // A test above may have set one; each restores in afterEach, so at the start
      // of this one the inherited environment is what we are asserting on.
      expect(process.env[name], `${name} leaked into the worker`).toBeUndefined();
    }
  });
});
