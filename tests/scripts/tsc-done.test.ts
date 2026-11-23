import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// dev-prod.sh skips its web/ type check only for a commit another tool already checked, and only
// while the tree it builds is that commit unchanged (scripts/lib/tsc-done.sh).
const LIB = resolve(__dirname, '../../scripts/lib/tsc-done.sh');
let dir = '';
let repo = '';
let done = '';
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const skips = () =>
  spawnSync('bash', ['-c', `. "${LIB}"; walnut_tsc_done "$1"`, '_', repo], {
    env: { ...process.env, WALNUT_TSC_DONE_DIR: done },
  }).status === 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsc-done-'));
  repo = join(dir, 'repo');
  done = join(dir, 'done');
  mkdirSync(join(repo, 'web'), { recursive: true });
  mkdirSync(done);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'web', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('tsc-done', () => {
  it('checks a commit with no record', () => {
    expect(skips()).toBe(false);
  });
  it('skips the commit a record names, with its tree unchanged (ignored files aside)', () => {
    writeFileSync(join(done, git('rev-parse', 'HEAD')), '');
    mkdirSync(join(repo, 'web', 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'web', 'node_modules', 'x.js'), '');
    expect(skips()).toBe(true);
  });
  it('checks again when web/ has a change or a new file', () => {
    writeFileSync(join(repo, 'web', 'a.ts'), 'export const a = 2;\n');
    expect(skips()).toBe(false);
    git('checkout', '-q', '--', 'web/a.ts');
    writeFileSync(join(repo, 'web', 'b.ts'), 'export const b = 1;\n');
    expect(skips()).toBe(false);
    rmSync(join(repo, 'web', 'b.ts'));
    expect(skips()).toBe(true);
  });
  it('checks a later commit', () => {
    writeFileSync(join(repo, 'web', 'c.ts'), 'export const c = 1;\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'next');
    expect(skips()).toBe(false);
  });
});
