/**
 * The glanceable git state (createGitStatus in src/providers/git-diff-core.ts),
 * run against REAL repositories: the branch, changed paths, +/- lines and the
 * commits not pushed, as session rows show them. The same factory runs in the
 * server (local sessions) and in both daemon twins (`git.status`); the source
 * twin inlines its text, so one case rebuilds it from `toString()` alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitStatus, type ExecFn, type GitStatusDeps } from '../../src/providers/git-diff-core.js';

const exec: ExecFn = (argv, cwd) => new Promise((resolve) => {
  execFile(argv[0]!, argv.slice(1), { cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
    resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0 });
  });
});

const readText: GitStatusDeps['readText'] = async (abs, max) => {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > max) return { tooBig: true };
    return { text: fs.readFileSync(abs, 'utf-8') };
  } catch { return null; }
};

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

function repo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

beforeAll(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-core-'))); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('createGitStatus', () => {
  it('a clean branch tracking its upstream: no changes, nothing ahead or behind', async () => {
    const remote = path.join(root, 'clean-remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const dir = repo('clean');
    write(dir, 'a.txt', 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'first');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const [st] = await createGitStatus({ exec, readText }).status([dir]);
    expect(st).toMatchObject({ repoRoot: dir, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, files: 0, insertions: 0, deletions: 0 });
    expect(st!.head).toMatch(/^[0-9a-f]{9}$/);
  });

  it('counts staged, unstaged, untracked and renamed paths, with their +/- lines', async () => {
    const remote = path.join(root, 'dirty-remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const dir = repo('dirty');
    write(dir, 'keep.txt', 'a\nb\nc\n');
    write(dir, 'old-name.txt', 'moved\n');
    write(dir, 'staged.txt', 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'first');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    write(dir, 'keep.txt', 'a\nB\nc\nd\n');           // unstaged: +2 -1
    write(dir, 'staged.txt', 'x\ny\n');               // staged: +1
    git(dir, 'add', 'staged.txt');
    git(dir, 'mv', 'old-name.txt', 'new-name.txt');   // a rename record carries two paths
    write(dir, 'src/new file.ts', 'l1\nl2\nl3');      // untracked, no final newline: 3 lines
    write(dir, 'bin.dat', 'a\u0000b');                // untracked binary: no lines
    const [st] = await createGitStatus({ exec, readText }).status([dir]);
    expect(st).toMatchObject({ branch: 'main', files: 5, untracked: 2, conflicted: 0, ahead: 0 });
    // keep +2 -1, staged +1, the rename (no-renames numstat) +1 -1, untracked +3
    expect(st!.insertions).toBe(7);
    expect(st!.deletions).toBe(2);
    expect(st!.linesPartial).toBeUndefined();
  });

  it('commits not pushed: ahead of the upstream, or of every remote when there is no upstream', async () => {
    const remote = path.join(root, 'ahead-remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const dir = repo('ahead');
    write(dir, 'a.txt', '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'one');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    write(dir, 'a.txt', '2\n');
    git(dir, 'commit', '-qam', 'two');
    write(dir, 'a.txt', '3\n');
    git(dir, 'commit', '-qam', 'three');
    const s = createGitStatus({ exec, readText });
    expect((await s.status([dir]))[0]).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 });

    git(dir, 'checkout', '-q', '-b', 'feature/x');
    write(dir, 'a.txt', '4\n');
    git(dir, 'commit', '-qam', 'four');
    // A new branch tracks nothing: the commits no remote has are the unpushed ones.
    expect((await s.status([dir]))[0]).toMatchObject({ branch: 'feature/x', upstream: null, ahead: 3, behind: null });
  });

  it('a repo with no remote, a detached HEAD and a repo with no commits yet', async () => {
    const local = repo('local-only');
    write(local, 'a.txt', '1\n');
    git(local, 'add', '.');
    git(local, 'commit', '-qm', 'one');
    git(local, 'commit', '-q', '--allow-empty', '-m', 'two');
    const s = createGitStatus({ exec, readText });
    expect((await s.status([local]))[0]).toMatchObject({ branch: 'main', upstream: null, ahead: null, behind: null });

    git(local, 'checkout', '-q', '--detach', 'HEAD~1');
    expect((await s.status([local]))[0]).toMatchObject({ branch: null, ahead: null });

    const fresh = repo('fresh');
    write(fresh, 'staged.txt', 'a\nb\n');
    git(fresh, 'add', 'staged.txt');
    write(fresh, 'loose.txt', 'c\n');
    expect((await s.status([fresh]))[0]).toMatchObject({ branch: 'main', head: null, files: 2, untracked: 1, insertions: 3, deletions: 0 });
  });

  it('dedupes directories of one repo, skips what is no repo, and marks lines it could not count', async () => {
    const dir = repo('many');
    write(dir, 'a.txt', '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'one');
    write(dir, 'big.txt', 'x\n'.repeat(10));
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const small: GitStatusDeps['readText'] = async (abs, _max) => readText!(abs, 4);
    const res = await createGitStatus({ exec, readText: small }).status([path.join(dir, 'missing'), plain, dir, dir]);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ repoRoot: dir, files: 1, untracked: 1, insertions: 0, linesPartial: true });
  });

  it('never writes the index (so never takes index.lock), even with a stat-dirty tracked file', async () => {
    const dir = repo('locks')
    write(dir, 'a.txt', '1\n')
    write(dir, 'b.txt', 'b\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'one')
    write(dir, 'a.txt', '2\n')
    // Same content, new mtime: a refreshing command would rewrite the index for it.
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(path.join(dir, 'b.txt'), later, later)
    const index = path.join(dir, '.git', 'index')
    const before = fs.statSync(index)
    const calls: string[][] = []
    const [st] = await createGitStatus({ exec: (argv, cwd) => { calls.push(argv); return exec(argv, cwd) }, readText }).status([dir])
    const after = fs.statSync(index)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(st).toMatchObject({ files: 1, insertions: 1, deletions: 1 })
    for (const argv of calls) expect(argv.slice(0, 2)).toEqual(['git', '--no-optional-locks'])
  })

  it('a staged file edited again before the first commit is counted once', async () => {
    const dir = repo('first-commit')
    write(dir, 'a.txt', 'one\n')
    git(dir, 'add', 'a.txt')
    write(dir, 'a.txt', 'one\ntwo\n')
    const [st] = await createGitStatus({ exec, readText }).status([dir])
    expect(st).toMatchObject({ head: null, files: 1, insertions: 2, deletions: 0 })
  })

  it('a branch whose remote branch is gone still counts the commits no remote has', async () => {
    const remote = path.join(root, 'gone-remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    const dir = repo('gone')
    write(dir, 'a.txt', '1\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'one')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'push', '-q', '-u', 'origin', 'main')
    git(dir, 'checkout', '-q', '-b', 'topic')
    git(dir, 'push', '-q', '-u', 'origin', 'topic')
    write(dir, 'a.txt', '2\n')
    git(dir, 'commit', '-qam', 'two')
    git(dir, 'push', '-q', 'origin', '--delete', 'topic')
    git(dir, 'fetch', '-q', '--prune')
    const [st] = await createGitStatus({ exec, readText }).status([dir])
    expect(st).toMatchObject({ branch: 'topic', upstream: 'origin/topic', ahead: 1, behind: null })
  })

  it('untracked lines are counted within a byte budget, then marked partial', async () => {
    const dir = repo('budget')
    write(dir, 'a.txt', '1\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'one')
    for (let i = 0; i < 6; i++) write(dir, `big${i}.txt`, 'x\n'.repeat(60_000)) // 120 KB each
    const [st] = await createGitStatus({ exec, readText }).status([dir])
    expect(st!.untracked).toBe(6)
    expect(st!.linesPartial).toBe(true)
    expect(st!.insertions).toBeLessThan(6 * 60_000)
    expect(st!.insertions).toBeGreaterThan(0)
  })

  it('rebuilt from its own text (as the source twin inlines it), it answers the same', async () => {
    const dir = repo('twin');
    write(dir, 'a.txt', '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'one');
    write(dir, 'a.txt', '1\n2\n');
    write(dir, 'b.txt', 'b\n');
    const rebuilt = new Function('return (' + createGitStatus.toString() + ')')() as typeof createGitStatus;
    const a = await createGitStatus({ exec, readText }).status([dir]);
    const b = await rebuilt({ exec, readText }).status([dir]);
    expect(b).toEqual(a);
    expect(a[0]).toMatchObject({ files: 2, insertions: 2, deletions: 0 });
  });
});
