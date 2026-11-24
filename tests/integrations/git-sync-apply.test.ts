/**
 * applyTargetToWorktree (src/integrations/git-sync-apply.ts): the one function
 * that moves the data repo's working tree to a pulled commit. Real git in a
 * temp repo; the sync-level guards are in git-sync-live-tree.test.ts and
 * git-sync-pull-defer.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import {
  ApplyInterruptedForTest, applyInFlight, applyPending, applyTargetToWorktree, recoverInterruptedApply, setApplyInterruptForTest,
  setWriteDrainForTest, type ApplyGit,
} from '../../src/integrations/git-sync-apply.js';
import { closeWrites, enterWrite, openWrites, renameGateState, setWriteGateOverdueListener } from '../../src/utils/write-gate.js';
import { writeTextFile } from '../../src/utils/fs.js';
import { execGitArgsRaw, execGitArgsStatus } from '../../src/integrations/git-sync.js';

let repo: string;
const sh = (cmd: string): string => execSync(cmd, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const at = (f: string): string => path.join(repo, f);
const put = (f: string, text: string): void => { fs.mkdirSync(path.dirname(at(f)), { recursive: true }); fs.writeFileSync(at(f), text); };
const git = (): ApplyGit => ({
  run: (args, opts) => execGitArgsStatus(args, { cwd: repo, timeout: 30_000, ...opts }),
  raw: (args, opts) => execGitArgsRaw(args, { cwd: repo, ...opts, timeout: opts?.timeout ?? 30_000 }),
});
/** Commit the tree `build` makes on top of HEAD as a side commit, leaving HEAD and the working tree alone. */
function targetCommit(build: () => void): string {
  const head = sh('git rev-parse HEAD');
  sh(`git checkout -q --detach ${head}`);
  build();
  sh('git add -A && git commit -q -m target');
  const target = sh('git rev-parse HEAD');
  sh('git checkout -q -f main');
  sh('git clean -qfd');
  return target;
}
const apply = (target: string, oldHead = sh('git rev-parse HEAD'), via: ApplyGit = git(), isMachineLocal?: (f: string) => boolean) =>
  applyTargetToWorktree(via, { repoDir: repo, branch: 'main', oldHead, target, isMachineLocal });
/** The same runner with `hook` run first for every git command (it may answer in git's place). */
const hooked = (hook: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string } | void>): ApplyGit => {
  const real = git();
  return { raw: real.raw, run: async (args, opts) => (await hook(args)) ?? real.run(args, opts) };
};
const read = (f: string): string => fs.readFileSync(at(f), 'utf-8');
const journalLeft = (): boolean => fs.existsSync(at('.git/walnut-apply'));

/** 250 stores, so the apply yields to the event loop part way (every 100 steps). */
const MANY = 250;
const many = (i: number): string => `many/f${String(i).padStart(3, '0')}.json`;
function writeMany(v: string): void {
  for (let i = 0; i < MANY; i++) put(many(i), `{"v":"${v}","i":${i}}\n`);
}
/** HEAD holds every store at "head"; returns the target commit holding them all at "target". */
function manyStores(): { head: string; target: string } {
  writeMany('head');
  sh('git add -A && git commit -q -m many');
  return { head: sh('git rev-parse HEAD'), target: targetCommit(() => writeMany('target')) };
}
/** Run `fn` on every turn of the event loop until it returns true (or the test ends). */
function everyTick(fn: () => boolean): () => void {
  let stopped = false;
  const tick = (): void => { if (!stopped && !fn()) setImmediate(tick); };
  setImmediate(tick);
  return () => { stopped = true; };
}
/** Files the apply's temp naming would leave behind, anywhere in the tree. */
const temps = (): string[] => sh('find . -path ./.git -prune -o -name ".open-walnut-*.tmp" -print').split('\n').filter(Boolean);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-apply-'));
  sh('git init -q -b main && git config user.email t@t && git config user.name t');
  put('keep.txt', 'keep v1\n');
  put('script.sh', 'echo hi\n');
  put('dir/a.txt', 'a\n');
  put('x', 'x was a file\n');
  sh('git add -A && git commit -q -m base');
});
afterEach(() => {
  setApplyInterruptForTest(null);
  setWriteDrainForTest(null);
  openWrites();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('applyTargetToWorktree', () => {
  it('lands every kind of change, keeps permissions, and leaves a clean index and no temp file', async () => {
    const target = targetCommit(() => {
      put('keep.txt', 'keep v2\n');
      fs.chmodSync(at('script.sh'), 0o755);
      fs.symlinkSync('keep.txt', at('link'));
      fs.rmSync(at('dir'), { recursive: true });
      fs.rmSync(at('x'));
      put('x/y.json', '{"now":"a dir"}\n');
      put('new/deep/n.json', '{}\n');
    });
    fs.chmodSync(at('keep.txt'), 0o640);

    const outcome = await apply(target);

    expect(outcome).toMatchObject({ status: 'applied' });
    expect(fs.readFileSync(at('keep.txt'), 'utf-8')).toBe('keep v2\n');
    expect(fs.statSync(at('keep.txt')).mode & 0o777).toBe(0o640);
    expect(fs.statSync(at('script.sh')).mode & 0o100).toBe(0o100);
    expect(fs.readlinkSync(at('link'))).toBe('keep.txt');
    expect(fs.existsSync(at('dir'))).toBe(false); // emptied by the deletion, pruned as git does
    expect(fs.readFileSync(at('x/y.json'), 'utf-8')).toBe('{"now":"a dir"}\n');
    expect(fs.statSync(at('new/deep/n.json')).mode & 0o777).toBe(0o600);
    expect(sh('git rev-parse HEAD')).toBe(target);
    expect(sh('git status --porcelain')).toBe('');
    expect(temps()).toEqual([]);
    expect(fs.existsSync(at('.git/index.lock'))).toBe(false);
  });

  it('a path the app wrote since the last commit stops the whole apply: nothing written, the branch unmoved', async () => {
    const head = sh('git rev-parse HEAD');
    const target = targetCommit(() => { put('keep.txt', 'keep v2\n'); put('dir/a.txt', 'a2\n'); });
    put('dir/a.txt', 'the app wrote this\n');

    expect(await apply(target)).toEqual({ status: 'deferred', reason: 'dirty', files: ['dir/a.txt'] });
    expect(fs.readFileSync(at('dir/a.txt'), 'utf-8')).toBe('the app wrote this\n');
    expect(fs.readFileSync(at('keep.txt'), 'utf-8')).toBe('keep v1\n');
    expect(sh('git rev-parse HEAD')).toBe(head);
    expect(temps()).toEqual([]);
  });

  it('a file already holding the target\'s version is left as it is', async () => {
    const target = targetCommit(() => put('keep.txt', 'keep v2\n'));
    put('keep.txt', 'keep v2\n');
    const ino = fs.statSync(at('keep.txt')).ino;

    expect(await apply(target)).toMatchObject({ status: 'applied', changed: 0 });
    expect(fs.statSync(at('keep.txt')).ino).toBe(ino);
    expect(sh('git status --porcelain')).toBe('');
  });

  it('an untracked file where the target adds one: an ignored one is replaced as git would, any other defers', async () => {
    put('.gitignore', 'local.cfg\n');
    sh('git add -A && git commit -q -m ignore');
    const target = targetCommit(() => {
      fs.writeFileSync(at('.gitignore'), '');
      put('local.cfg', 'tracked by the other side\n');
      put('fresh.md', 'from the hub\n');
    });
    put('local.cfg', 'machine-local residue\n');
    put('fresh.md', 'the app made this since the commit\n');

    expect(await apply(target)).toEqual({ status: 'deferred', reason: 'dirty', files: ['fresh.md'] });
    fs.rmSync(at('fresh.md'));
    expect(await apply(target)).toMatchObject({ status: 'applied', overwroteIgnored: ['local.cfg'] });
    expect(fs.readFileSync(at('local.cfg'), 'utf-8')).toBe('tracked by the other side\n');
  });

  it('another git holding the index waits its turn: nothing touched', async () => {
    const target = targetCommit(() => put('keep.txt', 'keep v2\n'));
    fs.writeFileSync(at('.git/index.lock'), '');

    expect(await apply(target)).toEqual({ status: 'deferred', reason: 'locked', files: [] });
    expect(fs.readFileSync(at('keep.txt'), 'utf-8')).toBe('keep v1\n');
    expect(fs.existsSync(at('.git/index.lock'))).toBe(true); // theirs, not ours to remove
  });

  it('the branch moved since the pull read it: deferred, nothing written', async () => {
    const target = targetCommit(() => put('keep.txt', 'keep v2\n'));
    put('other.md', 'o\n');
    sh('git add -A && git commit -q -m meanwhile');

    expect(await apply(target, sh('git rev-parse HEAD~1'))).toEqual({ status: 'deferred', reason: 'moved', files: [] });
    expect(fs.readFileSync(at('keep.txt'), 'utf-8')).toBe('keep v1\n');
  });

  it('a checkout that converts content is git\'s to write', async () => {
    put('.gitattributes', '*.txt filter=walnut-test\n');
    sh('git add -A && git commit -q -m attributes');
    const target = targetCommit(() => put('keep.txt', 'keep v2\n'));

    expect(await apply(target)).toEqual({ status: 'needs-git', reason: 'keep.txt has the filter attribute' });
    expect(fs.readFileSync(at('keep.txt'), 'utf-8')).toBe('keep v1\n');
  });
});

describe('an apply that stops part way leaves no half-applied tree', () => {
  it('a store the app writes mid-apply: every path already changed is put back, the branch stays, the next commit takes only that write', async () => {
    const { head, target } = manyStores();
    const appWrite = '{"v":"app"}\n';
    let wrote = false;
    // Fires at the first yield after the first store already holds the target's version.
    const stop = everyTick(() => {
      if (!read(many(0)).includes('"target"')) return false;
      fs.writeFileSync(at(many(200)), appWrite);
      return (wrote = true);
    });
    const outcome = await apply(target);
    stop();

    expect(wrote).toBe(true);
    expect(outcome).toMatchObject({ status: 'deferred', reason: 'raced', files: [many(200)] });
    for (let i = 0; i < MANY; i++) if (i !== 200) expect(read(many(i))).toContain('"head"');
    expect(read(many(200))).toBe(appWrite);
    expect(sh('git rev-parse HEAD')).toBe(head);
    expect(sh('git status --porcelain')).toBe(`M ${many(200)}`);
    expect(journalLeft()).toBe(false);
    expect(temps()).toEqual([]);
  });

  it('a store the app writes while the new versions are being prepared: nothing is written at all', async () => {
    const { head, target } = manyStores();
    const appWrite = '{"v":"app"}\n';
    const stop = everyTick(() => {
      if (!fs.readdirSync(at('many')).some((n) => n.startsWith('.open-walnut-'))) return false;
      fs.writeFileSync(at(many(200)), appWrite);
      return true;
    });
    const outcome = await apply(target);
    stop();

    expect(outcome).toEqual({ status: 'deferred', reason: 'dirty', files: [many(200)] });
    for (let i = 0; i < MANY; i++) if (i !== 200) expect(read(many(i))).toContain('"head"');
    expect(sh('git rev-parse HEAD')).toBe(head);
    expect(journalLeft()).toBe(false);
    expect(temps()).toEqual([]);
  });

  it('the branch CAS refused after the tree moved: every kind of step is undone', async () => {
    const head = sh('git rev-parse HEAD');
    const target = targetCommit(() => {
      put('keep.txt', 'keep v2\n');
      fs.rmSync(at('dir'), { recursive: true });
      put('fresh/deep/n.json', '{}\n');
    });
    const refusing = hooked(async (args) => (args[0] === 'update-ref' ? { code: 1, stdout: '', stderr: 'cannot lock ref' } : undefined));

    const outcome = await apply(target, head, refusing);

    expect(outcome).toMatchObject({ status: 'deferred', reason: 'moved', rollback: { failed: [], leftAlone: [] } });
    expect(read('keep.txt')).toBe('keep v1\n');
    expect(read('dir/a.txt')).toBe('a\n');
    expect(fs.existsSync(at('fresh'))).toBe(false);
    expect(sh('git rev-parse HEAD')).toBe(head);
    expect(sh('git status --porcelain')).toBe('');
    expect(journalLeft()).toBe(false);
  });

  it('a process killed mid-apply: the journal and the lock stay, and the recovery before the next commit puts every path back', async () => {
    const { head, target } = manyStores();
    setApplyInterruptForTest((step) => step === 120);
    await expect(apply(target)).rejects.toBeInstanceOf(ApplyInterruptedForTest);
    setApplyInterruptForTest(null);
    // As a dead process leaves it: the first stores already the target's.
    expect(read(many(0))).toContain('"target"');
    expect(read(many(200))).toContain('"head"');
    expect(fs.existsSync(at('.git/walnut-apply/journal.json'))).toBe(true);
    expect(fs.existsSync(at('.git/index.lock'))).toBe(true);
    expect(applyInFlight()).toBe(false);
    expect(temps().length).toBeGreaterThan(0); // the steps never reached still have theirs
    expect(applyPending(repo)).toBe(true);

    // A lock still being touched belongs to a live apply: wait.
    expect((await recoverInterruptedApply(git().run, repo)).outcome).toBe('busy');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(at('.git/index.lock'), old, old);
    expect(await recoverInterruptedApply(git().run, repo)).toMatchObject({ outcome: 'recovered', finished: false });

    for (let i = 0; i < MANY; i++) expect(read(many(i))).toContain('"head"');
    expect(sh('git rev-parse HEAD')).toBe(head);
    expect(sh('git status --porcelain')).toBe('');
    expect(journalLeft()).toBe(false);
    expect(temps()).toEqual([]);
    expect(applyPending(repo)).toBe(false);
    expect(fs.existsSync(at('.git/index.lock'))).toBe(false);
    expect(await apply(target)).toMatchObject({ status: 'applied', changed: MANY });
  });

  it('a process killed after the branch moved: the recovery only finishes the index', async () => {
    const { target } = manyStores();
    setApplyInterruptForTest((step) => step === MANY);
    await expect(apply(target)).rejects.toBeInstanceOf(ApplyInterruptedForTest);
    setApplyInterruptForTest(null);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(at('.git/index.lock'), old, old);

    expect(await recoverInterruptedApply(git().run, repo)).toMatchObject({ outcome: 'recovered', finished: true });
    for (let i = 0; i < MANY; i++) expect(read(many(i))).toContain('"target"');
    expect(sh('git rev-parse HEAD')).toBe(target);
    expect(sh('git status --porcelain')).toBe('');
  });

  it('an index that could not follow the branch: marked, and repaired by the next recovery', async () => {
    const target = targetCommit(() => put('keep.txt', 'keep v2\n'));
    const broken = hooked(async (args) => (args[0] === 'read-tree' || args[0] === 'reset' ? { code: 128, stdout: '', stderr: 'boom' } : undefined));

    expect(await apply(target, undefined, broken)).toMatchObject({ status: 'applied', indexStale: true });
    expect(sh('git rev-parse HEAD')).toBe(target);
    expect(fs.existsSync(at('.git/walnut-index-stale'))).toBe(true);

    expect((await recoverInterruptedApply(git().run, repo)).outcome).toBe('recovered');
    expect(fs.existsSync(at('.git/walnut-index-stale'))).toBe(false);
    expect(sh('git status --porcelain')).toBe('');
  });
});

describe('something untracked in the way is settled before anything is written', () => {
  it('a directory the target turns into a file, holding only ignored files: cleared as git clears it', async () => {
    put('.gitignore', '.DS_Store\n');
    put('p/x.json', '{}\n');
    sh('git add -A && git commit -q -m p');
    const target = targetCommit(() => { put('keep.txt', 'keep v2\n'); fs.rmSync(at('p'), { recursive: true }); put('p', 'now a file\n'); });
    put('p/.DS_Store', 'finder\n');
    put('p/sub/.DS_Store', 'finder\n');

    expect(await apply(target)).toMatchObject({ status: 'applied', overwroteIgnored: ['p/.DS_Store', 'p/sub/.DS_Store'] });
    expect(read('p')).toBe('now a file\n');
    expect(read('keep.txt')).toBe('keep v2\n');
    expect(sh('git status --porcelain')).toBe('');
  });

  it('a directory the target turns into a file, holding a file that is not ignored: deferred, nothing written', async () => {
    const head = sh('git rev-parse HEAD');
    const target = targetCommit(() => { put('keep.txt', 'keep v2\n'); fs.rmSync(at('dir'), { recursive: true }); put('dir', 'now a file\n'); });
    put('dir/notes.md', 'the app made this\n');

    expect(await apply(target)).toEqual({ status: 'deferred', reason: 'dirty', files: ['dir/notes.md'] });
    expect(read('keep.txt')).toBe('keep v1\n');
    expect(read('dir/a.txt')).toBe('a\n');
    expect(sh('git rev-parse HEAD')).toBe(head);
  });

  it('a file where the target needs a directory: an ignored one is cleared, any other defers with nothing written', async () => {
    put('.gitignore', 'q\n');
    sh('git add -A && git commit -q -m ignore');
    const target = targetCommit(() => {
      put('keep.txt', 'keep v2\n');
      put('.gitignore', '');
      put('q/r.json', '{}\n');
      put('s/t.json', '{}\n');
    });
    put('q', 'machine residue\n');
    put('s', 'the app made this\n');

    expect(await apply(target)).toEqual({ status: 'deferred', reason: 'dirty', files: ['s'] });
    expect(read('keep.txt')).toBe('keep v1\n');
    expect(read('q')).toBe('machine residue\n');
    fs.rmSync(at('s'));
    expect(await apply(target)).toMatchObject({ status: 'applied', overwroteIgnored: ['q'] });
    expect(read('q/r.json')).toBe('{}\n');
  });

  it('a machine-local file is never replaced or cleared, even when ignored', async () => {
    put('.gitignore', 'local.cfg\n.DS_Store\n');
    put('box/x.json', '{}\n');
    sh('git add -A && git commit -q -m ignore');
    const local = (f: string): boolean => f === 'local.cfg' || f === 'box/local.cfg';
    // The other side tracks it (forced past its ignore rule).
    const replaces = targetCommit(() => { put('keep.txt', 'keep v2\n'); put('local.cfg', 'the hub\'s\n'); sh('git add -f local.cfg'); });
    put('local.cfg', 'this machine\'s\n');

    expect(await apply(replaces, undefined, git(), local)).toMatchObject({ status: 'applied', keptLocal: ['local.cfg'] });
    expect(read('local.cfg')).toBe('this machine\'s\n');
    expect(read('keep.txt')).toBe('keep v2\n');

    const clears = targetCommit(() => { fs.rmSync(at('box'), { recursive: true }); put('box', 'now a file\n'); });
    put('box/local.cfg', 'this machine\'s\n');
    expect(await apply(clears, undefined, git(), local)).toEqual({ status: 'deferred', reason: 'dirty', files: ['box/local.cfg'] });
    expect(read('box/x.json')).toBe('{}\n');
  });
});

describe('the index lock', () => {
  it('stays fresh through a long single step, and the in-process latch is up while it is held', async () => {
    const target = targetCommit(() => put('keep.txt', 'keep v2\n'));
    let during: { ageMs: number; inFlight: boolean } | null = null;
    const slow = hooked(async (args) => {
      if (args[0] !== 'hash-object') return;
      await new Promise((r) => setTimeout(r, 2_500));
      during = { ageMs: Date.now() - fs.statSync(at('.git/index.lock')).mtimeMs, inFlight: applyInFlight() };
    });

    expect(await apply(target, undefined, slow)).toMatchObject({ status: 'applied' });
    expect(during!.ageMs).toBeLessThan(1_500);
    expect(during!.inFlight).toBe(true);
    expect(applyInFlight()).toBe(false);
    expect(fs.existsSync(at('.git/index.lock'))).toBe(false);
  });

  it('swept from under the apply and taken by another git: deferred, nothing written, their lock left alone', async () => {
    const target = targetCommit(() => put('keep.txt', 'keep v2\n'));
    const swept = hooked(async (args) => {
      if (args[0] !== 'hash-object') return;
      fs.rmSync(at('.git/index.lock'));
      fs.writeFileSync(at('.git/index.lock'), 'another git\n');
    });

    expect(await apply(target, undefined, swept)).toEqual({ status: 'deferred', reason: 'locked', files: [] });
    expect(read('keep.txt')).toBe('keep v1\n');
    expect(read('.git/index.lock')).toBe('another git\n');
  });
});

/** Kill an apply of `target` before step `step`, then age its lock as a dead process's would be. */
async function killAt(target: string, step: number): Promise<void> {
  setApplyInterruptForTest((s) => s === step);
  await expect(apply(target)).rejects.toBeInstanceOf(ApplyInterruptedForTest);
  setApplyInterruptForTest(null);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(at('.git/index.lock'), old, old);
}
const heldDirs = (): string[] => (fs.existsSync(at('.git/walnut-apply-held')) ? fs.readdirSync(at('.git/walnut-apply-held')) : []);

describe('a pull killed part way, settled by the branch\'s tree', () => {
  it('the app\'s writes after the crash are kept; every other path is put back', async () => {
    const { target } = manyStores();
    await killAt(target, 150);
    fs.writeFileSync(at('many/.tmpx'), '{"v":"app-atomic"}\n');
    fs.renameSync(at('many/.tmpx'), at(many(1)));
    fs.writeFileSync(at(many(2)), '{"v":"app-in-place, longer"}\n');
    fs.writeFileSync(at('many/.tmpy'), '{"v":"app-unreached"}\n');
    fs.renameSync(at('many/.tmpy'), at(many(200)));

    const report = await recoverInterruptedApply(git().run, repo);

    expect(report).toMatchObject({ outcome: 'recovered', finished: false });
    expect(report.rollback!.leftAlone.sort()).toEqual([many(1), many(2), many(200)]);
    expect(read(many(1))).toContain('app-atomic');
    expect(read(many(2))).toContain('app-in-place');
    expect(read(many(200))).toContain('app-unreached');
    for (const i of [0, 3, 149, 151, 249]) expect(read(many(i))).toContain('"head"');
    expect(temps()).toEqual([]);
  });

  it('the branch rewritten to the old head\'s tree under a new id (a compaction): rolled back', async () => {
    const { target } = manyStores();
    await killAt(target, 120);
    sh('git update-ref refs/heads/main "$(git commit-tree HEAD^{tree} -m compacted)"');

    expect(await recoverInterruptedApply(git().run, repo)).toMatchObject({ outcome: 'recovered', finished: false });
    for (let i = 0; i < MANY; i++) expect(read(many(i))).toContain('"head"');
    expect(sh('git status --porcelain')).toBe('');
  });

  it('a person committed the half-applied tree: no file is touched, and auto-commits wait only while HEAD lacks what the pull wrote', async () => {
    const { target } = manyStores();
    await killAt(target, 120);
    // A commit of something else: HEAD still lacks the stores the pull already wrote.
    fs.rmSync(at('.git/index.lock'));
    put('elsewhere.md', 'a person\'s note\n');
    sh('git add elsewhere.md && git commit -q -m "a person\'s commit"');

    const first = await recoverInterruptedApply(git().run, repo);
    expect(first).toMatchObject({ outcome: 'held', heldNow: { reason: 'branch-moved' } });
    expect(first.held![0].waiting).toContain(many(0));
    expect(read(many(0))).toContain('"target"'); // untouched
    expect(read(many(200))).toContain('"head"');
    expect(applyPending(repo)).toBe(true);
    expect(temps()).toEqual([]);
    expect((await recoverInterruptedApply(git().run, repo)).outcome).toBe('held'); // still

    // Once HEAD holds those bytes (here the person commits them), auto-commits resume.
    sh('git add -A && git commit -q -m "a person commits the rest"');
    const second = await recoverInterruptedApply(git().run, repo);
    expect(second.outcome).toBe('recovered');
    expect(second.released).toHaveLength(1);
    expect(heldDirs()).toEqual([]);
    expect(applyPending(repo)).toBe(false);
    expect(read(many(0))).toContain('"target"');
  });

  it('a rollback that fails is held, never given up: the backups stay, and the next pull of the same commit settles it', async () => {
    const { head, target } = manyStores();
    await killAt(target, 120);
    // One backup is gone, so that store cannot be put back.
    const journal = JSON.parse(read('.git/walnut-apply/journal.json')) as { ops: Array<{ path: string; before: { backup?: string } }> };
    const lost = journal.ops.find((o) => o.path === many(5))!;
    fs.rmSync(at(`.git/walnut-apply/${lost.before.backup}`));

    const report = await recoverInterruptedApply(git().run, repo);
    expect(report).toMatchObject({ outcome: 'held', heldNow: { reason: 'rollback-failed' } });
    expect(report.held![0].waiting).toEqual([many(5)]);
    expect(read(many(5))).toContain('"target"');
    expect(read(many(6))).toContain('"head"');
    const [id] = heldDirs();
    expect(fs.readdirSync(at(`.git/walnut-apply-held/${id}`)).filter((f) => /^b\d+$/.test(f)).length).toBeGreaterThan(100);
    expect(applyPending(repo)).toBe(true);

    expect(await apply(target, head)).toMatchObject({ status: 'applied' });
    expect((await recoverInterruptedApply(git().run, repo)).released).toEqual([id]);
    expect(applyPending(repo)).toBe(false);
  });

  it('a held store the hub changed again: the next pull replaces it (pulled content, never the user\'s), and it settles', async () => {
    const { head, target } = manyStores();
    // The hub's next save changed that store again (built first: targetCommit resets the worktree).
    const again = targetCommit(() => { writeMany('target'); put(many(5), '{"v":"hub again"}\n'); });
    await killAt(target, 120);
    const journal = JSON.parse(read('.git/walnut-apply/journal.json')) as { ops: Array<{ path: string; before: { backup?: string } }> };
    fs.rmSync(at(`.git/walnut-apply/${journal.ops.find((o) => o.path === many(5))!.before.backup}`));
    expect((await recoverInterruptedApply(git().run, repo)).held![0].waiting).toEqual([many(5)]);
    expect(read(many(5))).toBe('{"v":"target","i":5}\n'); // the held bytes: the pull's, not HEAD's

    expect(await apply(again, head)).toMatchObject({ status: 'applied' });
    expect(read(many(5))).toBe('{"v":"hub again"}\n');
    expect((await recoverInterruptedApply(git().run, repo)).outcome).toBe('recovered');
    expect(heldDirs()).toEqual([]);
    expect(sh('git status --porcelain')).toBe('');
  });

  it('a held store the app rewrote since: the app\'s write is the newest, so it is held no more', async () => {
    const { target } = manyStores();
    await killAt(target, 120);
    const journal = JSON.parse(read('.git/walnut-apply/journal.json')) as { ops: Array<{ path: string; before: { backup?: string } }> };
    fs.rmSync(at(`.git/walnut-apply/${journal.ops.find((o) => o.path === many(5))!.before.backup}`));
    const [held] = (await recoverInterruptedApply(git().run, repo)).held!;
    expect(applyPending(repo)).toBe(true);
    expect(applyPending(repo, [held.id])).toBe(false); // a caller that leaves the held paths out may stage

    await writeTextFile(at(many(5)), '{"v":"app"}\n');
    expect((await recoverInterruptedApply(git().run, repo)).released).toEqual([held.id]);
    expect(applyPending(repo)).toBe(false);
    expect(read(many(5))).toBe('{"v":"app"}\n');
  });

  it('a journal that cannot be read is held and never released by itself', async () => {
    const { target } = manyStores();
    await killAt(target, 120);
    fs.writeFileSync(at('.git/walnut-apply/journal.json'), '{"version": 1, "ops": [');

    expect(await recoverInterruptedApply(git().run, repo)).toMatchObject({ outcome: 'held', heldNow: { reason: 'unreadable' } });
    expect(read(many(0))).toContain('"target"'); // nothing touched
    expect((await recoverInterruptedApply(git().run, repo)).outcome).toBe('held');
    expect(applyPending(repo)).toBe(true);
  });
});

describe('the rename gate (write-gate.ts): an app write in flight is never overwritten', () => {
  // Writers outside the gate (about 300 rename sites) keep a window of microseconds
  // between the pull's check of a path and its rename; git's checkout had a wider one.
  const twoStores = (): { base: string; target: string } => {
    put('a.json', '{"v":"head"}\n');
    put('store.json', '{"v":"head"}\n');
    sh('git add -A && git commit -q -m stores');
    return { base: sh('git rev-parse HEAD'), target: targetCommit(() => { put('a.json', '{"v":"target"}\n'); put('store.json', '{"v":"target"}\n'); }) };
  };

  it('a rename handed to the thread pool just before the pull closes the gate: the pull sees it and writes nothing', async () => {
    const { base, target } = twoStores();
    for (let trial = 0; trial < 40; trial++) {
      sh(`git reset -q --hard ${base}`);
      const mine = `{"v":"app-${trial}"}\n`;
      fs.writeFileSync(at('.app.tmp'), mine);
      let write: Promise<void> | null = null;
      // The app's gated writer, its rename already dispatched when the pull reaches its writes.
      setApplyInterruptForTest((step) => {
        if (step === -1) {
          write = enterWrite().then(async (release) => {
            try { await fsp.rename(at('.app.tmp'), at('store.json')); } finally { release(); }
          });
        }
        return false;
      });
      const outcome = await apply(target, base);
      setApplyInterruptForTest(null);
      await write;
      expect(read('store.json')).toBe(mine);
      expect(outcome).toEqual({ status: 'deferred', reason: 'dirty', files: ['store.json'] });
      expect(read('a.json')).toBe('{"v":"head"}\n');
    }
  });

  it('a write that starts while the pull changes the tree waits, then lands on top of it', async () => {
    const { base, target } = twoStores();
    let write: Promise<void> | null = null;
    setApplyInterruptForTest((step) => {
      if (step === 1) write = writeTextFile(at('store.json'), '{"v":"app"}\n');
      return false;
    });
    expect(await apply(target, base)).toMatchObject({ status: 'applied' });
    setApplyInterruptForTest(null);
    await write;
    expect(read('store.json')).toBe('{"v":"app"}\n');
    expect(read('a.json')).toBe('{"v":"target"}\n');
  });

  it('the gate is open while the branch moves; a write that lands then survives a refused CAS', async () => {
    const head = sh('git rev-parse HEAD');
    const target = targetCommit(() => { put('keep.txt', 'keep v2\n'); put('dir/a.txt', 'a2\n'); });
    let closedDuringCas: boolean | null = null;
    const refusing = hooked(async (args) => {
      if (args[0] !== 'update-ref') return;
      closedDuringCas = renameGateState().closed;
      await writeTextFile(at('keep.txt'), 'the app wrote this\n'); // lands at once: the gate is open
      return { code: 1, stdout: '', stderr: 'cannot lock ref' };
    });

    const outcome = await apply(target, head, refusing);

    expect(closedDuringCas).toBe(false);
    expect(outcome).toMatchObject({ status: 'deferred', reason: 'moved', rollback: { leftAlone: ['keep.txt'], failed: [] } });
    expect(read('keep.txt')).toBe('the app wrote this\n');
    expect(read('dir/a.txt')).toBe('a\n');
    expect(renameGateState()).toEqual({ inFlight: 0, closed: false });
  });

  it('renames that do not finish in time: the pull writes nothing', async () => {
    const { base, target } = twoStores();
    setWriteDrainForTest(200);
    const release = await enterWrite();
    try {
      expect(await apply(target, base)).toEqual({ status: 'deferred', reason: 'busy', files: [] });
    } finally {
      release();
    }
    expect(read('store.json')).toBe('{"v":"head"}\n');
    expect(renameGateState()).toEqual({ inFlight: 0, closed: false });
  });

  it('a writer waits for a closed gate at most its bound, then goes ahead and says so', async () => {
    const waited: number[] = [];
    setWriteGateOverdueListener((ms) => waited.push(ms));
    try {
      expect(await closeWrites(1_000)).toBe(true);
      const start = Date.now();
      const release = await enterWrite(150);
      expect(Date.now() - start).toBeGreaterThanOrEqual(140);
      expect(waited).toHaveLength(1);
      release();
    } finally {
      openWrites();
      setWriteGateOverdueListener(null);
    }
  });
});
