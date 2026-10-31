/**
 * The matching rules that decide which local commits a rewrite left out
 * (src/integrations/git-sync-rewrite-carry.ts). The repo-level cases, the
 * 2026-10-28 incident included, are in git-sync-compaction-coordination.test.ts.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  carryLocalCommits, findRewriteAnchor, type ChainCommit, type GitStatusRunner,
} from '../../src/integrations/git-sync-rewrite-carry.js';
import { execGitArgsStatus } from '../../src/integrations/git-sync.js';

const c = (hash: string, tree: string, t: number, subject = hash): ChainCommit =>
  ({ hash, tree, authorAt: t, committerAt: t, subject });

describe('findRewriteAnchor', () => {
  it('matches by tree: the newest local commit whose tree the new chain holds', () => {
    const local = [c('l3', 'T3', 300), c('l2', 'T2', 200), c('l1', 'T1', 100)];
    const remote = [c('r2', 'T2', 200, 'compacted'), c('r1', 'T1', 100)];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l2', remote: 'r2', by: 'tree' });
  });

  it('a tree that recurs on the new chain maps to its newest commit there', () => {
    const local = [c('l2', 'T1', 200)];
    const remote = [c('r3', 'T1', 300), c('r1', 'T1', 100)];
    expect(findRewriteAnchor(local, remote)?.remote).toBe('r3');
  });

  it('matches by author date and subject when a scrub changed the tree', () => {
    const local = [c('l3', 'T3', 300), c('l2', 'T2', 200, 'auto-save 07:00'), c('l1', 'T1', 100)];
    const remote = [c('r2', 'T2-scrubbed', 200, 'auto-save 07:00'), c('r1', 'T1-scrubbed', 100)];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l2', remote: 'r2', by: 'author-date' });
  });

  it('the same subject at another time is not a match', () => {
    const local = [c('l2', 'T2', 200, 'auto-save'), c('l1', 'T1', 100, 'auto-save')];
    const remote = [c('r1', 'R1', 150, 'auto-save')];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l1', remote: 'r1', by: 'time' });
  });

  it('falls back to time: the newest local commit no newer than the newest rewritten one', () => {
    const local = [c('l3', 'T3', 500), c('l2', 'T2', 300), c('l1', 'T1', 100)];
    const remote = [c('r1', 'R1', 400)];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l2', remote: 'r1', by: 'time' });
  });

  it('no anchor when every local commit is newer than the whole new chain, or a chain is empty', () => {
    expect(findRewriteAnchor([c('l1', 'T1', 500)], [c('r1', 'R1', 400)])).toBeNull();
    expect(findRewriteAnchor([], [c('r1', 'R1', 400)])).toBeNull();
    expect(findRewriteAnchor([c('l1', 'T1', 500)], [])).toBeNull();
  });
});

// git before 2.40 has no `merge-tree --merge-base` (Ubuntu 22.04 ships 2.34): the
// replay then runs file by file and must land on the same trees.
// The machine's own git may predate 2.40 too; then the "modern" run is file by file as well.
const gitHasMergeTreeBase = (() => {
  const m = /(\d+)\.(\d+)/.exec(execSync('git --version', { encoding: 'utf-8' }));
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 40));
})();

describe('carryLocalCommits without merge-tree --merge-base', () => {
  let repo: string;
  const sh = (cmd: string, env?: Record<string, string>) =>
    execSync(cmd, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
  const write = (f: string, v: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), v); };
  const run: GitStatusRunner = (args, opts) => execGitArgsStatus(args, { cwd: repo, timeout: 30_000, ...opts });
  /** A git that refuses merge-tree's options the way an old one does. */
  const oldGit: GitStatusRunner = async (args, opts) => (args.includes('merge-tree')
    ? { code: 129, stdout: '', stderr: "error: unknown option `merge-base'" } : run(args, opts));
  const index = () => path.join(repo, '.git', 'carry-test.index');

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-file-level-'));
    sh('git init -q -b main && git config user.email t@t && git config user.name t');
    write('a.txt', 'a\n'); write('c.txt', 'c\n'); write('store.json', '{"lastUpdated":"2026-01-01T00:00:00Z"}\n');
    sh('git add -A && git commit -q -m base');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  /** The rewritten chain: a fresh root with base's tree, then `extra` on top. */
  function rewrite(extra?: () => void): string {
    const root = sh('git commit-tree HEAD^{tree} -m compacted');
    if (!extra) return root;
    sh(`git checkout -q --detach ${root}`);
    extra();
    sh('git add -A && git commit -q -m upstream', { GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 600} +0000` });
    const tip = sh('git rev-parse HEAD');
    sh('git checkout -q main');
    return tip;
  }

  function localWork(): string {
    write('a.txt', 'a local\n'); write('b/new.txt', 'new\n');
    sh('git add -A && git commit -q -m one');
    sh('git rm -q c.txt && git commit -q -m two');
    return sh('git rev-parse HEAD');
  }

  it('lands on the same tree as merge-tree for a clean replay, and says it ran file by file', async () => {
    const tip = rewrite();
    const head = localWork();
    const modern = await carryLocalCommits(run, head, tip, index());
    const fallback = await carryLocalCommits(oldGit, head, tip, index());
    expect(modern.fileLevel).toBe(!gitHasMergeTreeBase);
    expect(fallback.fileLevel).toBe(true);
    expect(fallback.replayed).toBe(2);
    expect(sh(`git rev-parse ${fallback.head}^{tree}`)).toBe(sh(`git rev-parse ${modern.head}^{tree}`));
    expect(sh(`git rev-parse ${fallback.head}^{tree}`)).toBe(sh('git rev-parse HEAD^{tree}'));
    expect(sh(`git log --format=%s -2 ${fallback.head}`).split('\n')).toEqual(['two', 'one']);
  });

  it('a file both changed: the fallback resolves it as merge-tree does, and keeps the new chain\'s other changes', async () => {
    const base = sh('git rev-parse HEAD');
    // A rebuilt chain no local commit matches, already holding a newer store and a file of its own.
    sh(`git checkout -q --detach ${base}`);
    write('up.txt', 'up\n'); write('store.json', '{"lastUpdated":"2026-09-01T00:00:00Z","v":"remote"}\n');
    sh('git add -A');
    const tip = sh(`git commit-tree ${sh('git write-tree')} -m rebuilt`, { GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 600} +0000` });
    sh('git checkout -q -f main');
    write('store.json', '{"lastUpdated":"2026-02-01T00:00:00Z","v":"local"}\n'); write('a.txt', 'a local\n');
    sh('git add -A && git commit -q -m mine');
    const head = sh('git rev-parse HEAD');
    // base is what the hub had before: the replay starts there, onto the rebuilt tip.
    const modern = await carryLocalCommits(run, head, tip, index(), base);
    const fallback = await carryLocalCommits(oldGit, head, tip, index(), base);
    for (const r of [modern, fallback]) {
      expect(r.anchor?.by).toBe('published');
      expect(sh(`git show ${r.head}:up.txt`)).toBe('up');
      expect(sh(`git show ${r.head}:a.txt`)).toBe('a local');
      expect(JSON.parse(sh(`git show ${r.head}:store.json`)).v).toBe('remote');
      expect(r.keptRemote).toContain('store.json');
    }
    expect(sh(`git rev-parse ${fallback.head}^{tree}`)).toBe(sh(`git rev-parse ${modern.head}^{tree}`));
  });
});
