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
const waits = (env: Record<string, string> = {}) => {
  const t0 = Date.now()
  const r = spawnSync('bash', ['-c', `. "${LIB}"; walnut_tsc_wait "$1"`, '_', repo], {
    env: { ...process.env, WALNUT_TSC_DONE_DIR: done, WALNUT_TSC_DONE_POLL_SECS: '1', ...env }, encoding: 'utf8',
  })
  return { ok: r.status === 0, out: r.stdout, ms: Date.now() - t0 }
}
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

  it('waits for a check another machine is running on that commit, and only for that', () => {
    const head = git('rev-parse', 'HEAD')
    mkdirSync(join(done, 'pending'), { recursive: true })
    // Nothing pending: no wait at all.
    expect(waits().ok).toBe(false)
    expect(waits().out).toBe('')
    // Pending, and its record comes 2 s later: the wait ends with a skip.
    writeFileSync(join(done, 'pending', head), '')
    execFileSync('bash', ['-c', `(sleep 2; : > "${join(done, head)}") > /dev/null 2>&1 &`])
    const r = waits({ WALNUT_TSC_DONE_WAIT_SECS: '20' })
    expect(r.ok).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(1_000)
    expect(r.out).toMatch(/another machine is checking commit/)
    rmSync(join(done, head))
    // Pending with no result: the wait runs out and says so.
    const t = waits({ WALNUT_TSC_DONE_WAIT_SECS: '2' })
    expect(t.ok).toBe(false)
    expect(t.out).toMatch(/no result for .* after 2s; checking here/)
    // The mark goes (that check failed): the wait ends at once.
    execFileSync('bash', ['-c', `(sleep 4; rm -f "${join(done, 'pending', head)}") > /dev/null 2>&1 &`])
    const g = waits({ WALNUT_TSC_DONE_WAIT_SECS: '20' })
    expect(g.ok).toBe(false)
    expect(g.ms).toBeLessThan(15_000)
    expect(g.out).toMatch(/gave no pass/)
    // An old mark is not believed.
    writeFileSync(join(done, 'pending', head), '')
    expect(waits({ WALNUT_TSC_PENDING_MAX_SECS: '0' }).out).toBe('')
    rmSync(join(done, 'pending', head))
  }, 60_000)
});
