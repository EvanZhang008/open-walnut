/**
 * Unit tests for the shared git-diff algorithm (src/providers/git-diff-core.ts).
 *
 * This is the EXACT code that runs host-side in both worlds: in-process for local
 * sessions, and inside the daemon's `git.diff` RPC for remote ones. We drive it
 * with MOCK exec/readText primitives (no real git) so we can assert the algorithm
 * — base-rev resolution, name-status parsing, untracked union, rename handling,
 * added/deleted short-circuits — deterministically and fast.
 *
 * Would these pass with the feature reverted? No: they assert the precise git
 * command sequence + the {repoRoot,files} contract the daemon RPC returns.
 */
import { describe, it, expect } from 'vitest';
import { computeGitDiff, GitDiffError, type ExecFn, type ReadTextFn } from '../../src/providers/git-diff-core.js';

const REPO = '/repo/app';

/** Build a mock exec that answers a scripted map of "argv joined by space" → result. */
function mockExec(routes: Record<string, { stdout?: string; stderr?: string; code?: number }>): { exec: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const exec: ExecFn = async (argv) => {
    const key = argv.join(' ');
    calls.push(key);
    const r = routes[key];
    if (!r) return { stdout: '', stderr: `unexpected: ${key}`, code: 1 };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
  };
  return { exec, calls };
}

const mockRead = (files: Record<string, string>): ReadTextFn => async (abs) => files[abs] ?? '';

describe('computeGitDiff', () => {
  it('returns null when cwd is not a git repo', async () => {
    const { exec } = mockExec({ 'git rev-parse --show-toplevel': { code: 128, stderr: 'not a git repo' } });
    const res = await computeGitDiff('uncommitted', '/tmp/x', exec, mockRead({}));
    expect(res).toBeNull();
  });

  it('uncommitted: diffs working tree vs HEAD, fills before from git show + after from working tree', async () => {
    const { exec, calls } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO + '\n' },
      'git diff --name-status -z HEAD': { stdout: 'M\0src/app.ts\0' },
      'git ls-files --others --exclude-standard -z': { stdout: '' },
      'git show HEAD:src/app.ts': { stdout: 'const v = 1;\n' },
    });
    const res = await computeGitDiff('uncommitted', REPO, exec, mockRead({ [REPO + '/src/app.ts']: 'const v = 2;\n' }));
    expect(res).not.toBeNull();
    expect(res!.repoRoot).toBe(REPO);
    expect(res!.files).toHaveLength(1);
    expect(res!.files[0]).toMatchObject({ relPath: 'src/app.ts', before: 'const v = 1;\n', after: 'const v = 2;\n', status: 'modified' });
    // base rev was HEAD (not HEAD~1 / upstream)
    expect(calls).toContain('git diff --name-status -z HEAD');
  });

  it('previous: uses HEAD~1 as the base rev', async () => {
    const { exec, calls } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git diff --name-status -z HEAD~1': { stdout: 'M\0a.txt\0' },
      'git ls-files --others --exclude-standard -z': { stdout: '' },
      'git show HEAD~1:a.txt': { stdout: 'old\n' },
    });
    const res = await computeGitDiff('previous', REPO, exec, mockRead({ [REPO + '/a.txt']: 'new\n' }));
    expect(res!.files[0]).toMatchObject({ before: 'old\n', after: 'new\n' });
    expect(calls).toContain('git diff --name-status -z HEAD~1');
  });

  it('remote: resolves @{upstream} and uses it as the base rev', async () => {
    const { exec } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': { stdout: 'origin/main\n' },
      'git diff --name-status -z origin/main': { stdout: 'M\0a.txt\0' },
      'git ls-files --others --exclude-standard -z': { stdout: '' },
      'git show origin/main:a.txt': { stdout: 'pushed\n' },
    });
    const res = await computeGitDiff('remote', REPO, exec, mockRead({ [REPO + '/a.txt']: 'local\n' }));
    expect(res!.files[0]).toMatchObject({ before: 'pushed\n', after: 'local\n' });
  });

  it('remote: falls back to origin/<branch> when there is no upstream', async () => {
    const { exec, calls } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': { code: 128, stderr: 'no upstream' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
      'git diff --name-status -z origin/feature': { stdout: '' },
      'git ls-files --others --exclude-standard -z': { stdout: '' },
    });
    const res = await computeGitDiff('remote', REPO, exec, mockRead({}));
    expect(res!.files).toEqual([]);
    expect(calls).toContain('git diff --name-status -z origin/feature');
  });

  it('throws GitDiffError when the base rev cannot be diffed (e.g. HEAD~1 missing)', async () => {
    const { exec } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git diff --name-status -z HEAD~1': { code: 128, stderr: "fatal: ambiguous argument 'HEAD~1'" },
    });
    await expect(computeGitDiff('previous', REPO, exec, mockRead({}))).rejects.toBeInstanceOf(GitDiffError);
  });

  it('includes untracked files as "added" (no git show, before empty), deduped against tracked', async () => {
    const { exec, calls } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git diff --name-status -z HEAD': { stdout: 'M\0tracked.ts\0' },
      'git ls-files --others --exclude-standard -z': { stdout: 'scratch.txt\0tracked.ts\0' }, // tracked.ts dup ignored
      'git show HEAD:tracked.ts': { stdout: 'old\n' },
    });
    const res = await computeGitDiff('uncommitted', REPO, exec,
      mockRead({ [REPO + '/tracked.ts']: 'new\n', [REPO + '/scratch.txt']: 'junk\n' }));
    const byPath = Object.fromEntries(res!.files.map((f) => [f.relPath, f]));
    expect(byPath['scratch.txt']).toMatchObject({ status: 'added', before: '', after: 'junk\n' });
    expect(byPath['tracked.ts']).toMatchObject({ status: 'modified', before: 'old\n', after: 'new\n' });
    // never tried to `git show` the untracked file
    expect(calls).not.toContain('git show HEAD:scratch.txt');
  });

  it('added file → empty before, no git show; deleted file → empty after, no working-tree read', async () => {
    const reads: string[] = [];
    const readText: ReadTextFn = async (abs) => { reads.push(abs); return abs.endsWith('added.ts') ? 'fresh\n' : ''; };
    const { exec, calls } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git diff --name-status -z HEAD': { stdout: 'A\0added.ts\0D\0gone.ts\0' },
      'git ls-files --others --exclude-standard -z': { stdout: '' },
      'git show HEAD:gone.ts': { stdout: 'was-here\n' },
    });
    const res = await computeGitDiff('uncommitted', REPO, exec, readText);
    const byPath = Object.fromEntries(res!.files.map((f) => [f.relPath, f]));
    expect(byPath['added.ts']).toMatchObject({ status: 'added', before: '', after: 'fresh\n' });
    expect(byPath['gone.ts']).toMatchObject({ status: 'deleted', before: 'was-here\n', after: '' });
    expect(calls).not.toContain('git show HEAD:added.ts'); // added → no before blob
    expect(reads).not.toContain(REPO + '/gone.ts');        // deleted → no working-tree read
  });

  it('rename: status=renamed, oldRelPath set, before from the OLD path, after from the new path', async () => {
    const { exec } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git diff --name-status -z HEAD': { stdout: 'R100\0old/name.ts\0new/name.ts\0' },
      'git ls-files --others --exclude-standard -z': { stdout: '' },
      'git show HEAD:old/name.ts': { stdout: 'body\n' },
    });
    const res = await computeGitDiff('uncommitted', REPO, exec, mockRead({ [REPO + '/new/name.ts']: 'body\n' }));
    expect(res!.files[0]).toMatchObject({ relPath: 'new/name.ts', oldRelPath: 'old/name.ts', before: 'body\n', after: 'body\n', status: 'renamed' });
  });

  it('sorts files by relPath', async () => {
    const { exec } = mockExec({
      'git rev-parse --show-toplevel': { stdout: REPO },
      'git diff --name-status -z HEAD': { stdout: 'M\0z.ts\0M\0a.ts\0M\0m.ts\0' },
      'git ls-files --others --exclude-standard -z': { stdout: '' },
      'git show HEAD:z.ts': { stdout: '1' }, 'git show HEAD:a.ts': { stdout: '1' }, 'git show HEAD:m.ts': { stdout: '1' },
    });
    const res = await computeGitDiff('uncommitted', REPO, exec, mockRead({}));
    expect(res!.files.map((f) => f.relPath)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });
});
