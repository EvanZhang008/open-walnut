/**
 * scripts/build-info.mjs: what tsup records as dist/build-info.json. Every git
 * call runs in a throwaway repo under the OS temp dir; the setup file strips any
 * inherited GIT_DIR, and the script strips it again on its own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: plain ESM build script, no type declarations
import { collectBuildInfo, writeBuildInfo, GIT_REPO_REDIRECT_VARS as SCRIPT_VARS } from '../../scripts/build-info.mjs';
import { GIT_REPO_REDIRECT_VARS } from '../../src/lib/git-env.js';

let tmp: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makePackage(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'open-walnut', version: '1.2.3' }));
}

function makeRepo(dir: string): string {
  makePackage(dir);
  git(dir, 'init', '-q', '-b', 'trunk');
  git(dir, 'add', 'package.json');
  git(dir, 'commit', '-q', '-m', 'init');
  return git(dir, 'rev-parse', '--short', 'HEAD');
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-build-info-writer-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('collectBuildInfo', () => {
  it('outside a git checkout: version only, commit and branch null, not dirty', () => {
    const pkg = path.join(tmp, 'pkg');
    makePackage(pkg);
    const info = collectBuildInfo(pkg, new Date('2026-09-24T12:00:00.000Z'));
    expect(info).toEqual({ version: '1.2.3', commit: null, branch: null, builtAt: '2026-09-24T12:00:00.000Z', dirty: false });
  });

  it('in a clean checkout: short sha and branch, not dirty; untracked files do not count', () => {
    const repo = path.join(tmp, 'repo');
    const sha = makeRepo(repo);
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked');
    const info = collectBuildInfo(repo);
    expect(info.commit).toBe(sha);
    expect(info.branch).toBe('trunk');
    expect(info.dirty).toBe(false);
  });

  it('a modified tracked file marks the build dirty', () => {
    const repo = path.join(tmp, 'repo');
    makeRepo(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'open-walnut', version: '1.2.4' }));
    const info = collectBuildInfo(repo);
    expect(info.dirty).toBe(true);
    expect(info.version).toBe('1.2.4');
  });

  it('a nightly version stamp alone is not dirt, but any other edit still is', () => {
    const repo = path.join(tmp, 'repo');
    makeRepo(repo);
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}\n');
    git(repo, 'add', 'package-lock.json');
    git(repo, 'commit', '-q', '-m', 'lock');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'open-walnut', version: '1.2.4-nightly.20261001.1' }));
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"version":"1.2.4-nightly.20261001.1"}\n');
    const stamped = { WALNUT_VERSION_STAMPED: '1' };
    expect(collectBuildInfo(repo, new Date(), stamped).dirty).toBe(false);
    expect(collectBuildInfo(repo, new Date(), {}).dirty).toBe(true);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one');
    git(repo, 'add', 'src/a.ts');
    git(repo, 'commit', '-q', '-m', 'src');
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'two');
    expect(collectBuildInfo(repo, new Date(), stamped).dirty).toBe(true);
  });

  it('a detached HEAD has no branch', () => {
    const repo = path.join(tmp, 'repo');
    const sha = makeRepo(repo);
    git(repo, 'checkout', '-q', '--detach');
    const info = collectBuildInfo(repo);
    expect(info.commit).toBe(sha);
    expect(info.branch).toBeNull();
  });

  it('a package unpacked inside another repository does not report that repository', () => {
    const outer = path.join(tmp, 'outer');
    makeRepo(outer);
    const inner = path.join(outer, 'node_modules', 'open-walnut');
    makePackage(inner);
    const info = collectBuildInfo(inner);
    expect(info.commit).toBeNull();
    expect(info.branch).toBeNull();
  });
});

describe('writeBuildInfo', () => {
  it('writes <outDir>/build-info.json and returns the same content', () => {
    const pkg = path.join(tmp, 'pkg');
    makePackage(pkg);
    const written = writeBuildInfo(pkg);
    const onDisk = JSON.parse(fs.readFileSync(path.join(pkg, 'dist', 'build-info.json'), 'utf8'));
    expect(onDisk).toEqual(written);
    expect(fs.readdirSync(path.join(pkg, 'dist'))).toEqual(['build-info.json']);
  });
});

describe('git env mirror (ratchet)', () => {
  it('strips the same redirect vars as src/lib/git-env.ts', () => {
    expect([...SCRIPT_VARS].sort()).toEqual([...GIT_REPO_REDIRECT_VARS].sort());
  });
});
