/**
 * A pull that cannot land cleanly changes nothing and waits for the next tick.
 *
 *  - The app wrote a store after the tick's commit (the fetch can take a
 *    minute): that write is never overwritten, the pull defers, and the next
 *    tick commits the write and merges it.
 *  - A merge step that times out (2026-11-24 07:14 to 07:25: ten 30 s merge
 *    timeouts in a row on a loaded Mac, each followed by `pull -X theirs`, which
 *    overwrote live stores with the hub's older content) never runs remote-wins
 *    and leaves the tree as it was, on the object-store path and on the legacy
 *    one alike.
 *  - A deferred rewrite adoption is still a rewrite on the next tick (the fetch
 *    already moved origin), so the old chain is never merged back in.
 *  - A pull killed part way is undone before the next commit, so the pulled
 *    content is never recorded as this box's own change (review of 2026-11-24).
 *  - A git that timed out answers nothing: a `merge-base` that hung never reads
 *    as "no merge base" (which would adopt ordinary divergence as a rewrite).
 *  - A git without `merge-tree --write-tree` still adopts a rewrite: the carried
 *    chain lands, and the next tick's legacy merge joins the rest.
 *
 * A wrapper `git` on PATH injects the write during the fetch and the hang
 * during a merge, and logs every git command the pull ran.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-pull-defer'));

import {
  initSync, setRemote, sync, commitIfDirty, stageAllForCommit, resetSyncGuardForTest, setPullStepTimeoutForTest, getSyncGuardState,
  REWRITE_FROM_REF,
} from '../../src/integrations/git-sync.js';
import { mergeTreeWriteTreeSupported, setMergeTreeWriteTreeForTest } from '../../src/integrations/git-sync-merge.js';
import { setApplyInterruptForTest } from '../../src/integrations/git-sync-apply.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { log } from '../../src/logging/index.js';

const home = WALNUT_HOME;
const hub = `${home}-hub.git`;
const cloud = `${home}-cloud`;
const bin = `${home}-bin`;
const realGit = execSync('command -v git', { encoding: 'utf-8', shell: '/bin/sh' }).trim();
let originalPath: string | undefined;

function sh(cmd: string, cwd: string, env?: Record<string, string>): string {
  try {
    // The real git: these are the test's own steps, not the pull under test.
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: originalPath, ...env } }).trim();
  } catch (error) {
    const e = error as { stderr?: string };
    throw new Error(`${cmd}: ${String(e.stderr ?? '').trim()}`);
  }
}
async function write(dir: string, file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fsp.writeFile(path.join(dir, file), text);
}
function commit(dir: string, message: string, ageSec = 0): void {
  const at = `${Math.floor(Date.now() / 1000) - ageSec} +0000`;
  sh(`git add -A && git commit -q -m "${message}"`, dir, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
}
const store = (v: string, lastUpdated: string): string => `${JSON.stringify({ version: 1, lastUpdated, v }, null, 2)}\n`;

/** The git subcommands the pull ran, in order (the wrapper logs each argv). */
function gitCalls(): string[] {
  const text = fs.existsSync(path.join(bin, 'calls.log')) ? fs.readFileSync(path.join(bin, 'calls.log'), 'utf-8') : '';
  return text.split('\n').filter(Boolean);
}
/** The subcommand of a logged call (`-c key=value` options skipped). */
function subcommand(call: string): string {
  const words = call.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '-c') { i++; continue; }
    if (!words[i].startsWith('-')) return words[i];
  }
  return '';
}
/** A call that writes the working tree from another commit, or picks the remote's side wholesale. */
function remoteWinsOrTreeWrite(call: string): boolean {
  const sub = subcommand(call);
  return sub === 'pull' || sub === 'rebase' || (sub === 'merge' && !call.includes('--abort'))
    || (sub === 'reset' && call.includes('--hard')) || / -X theirs\b/.test(` ${call}`);
}

beforeEach(async () => {
  resetSyncGuardForTest();
  for (const d of [home, hub, cloud, bin]) await fsp.rm(d, { recursive: true, force: true });
  for (const d of [home, hub, bin]) await fsp.mkdir(d, { recursive: true });
  // The wrapper: logs argv; on `fetch` it may write a store (the app's write in the
  // fetch window); on a named subcommand it may hang before or after running it.
  await fsp.writeFile(path.join(bin, 'git'), `#!/bin/bash
B=${JSON.stringify(bin)}
echo "$*" >> "$B/calls.log"
sub=""
for a in "$@"; do case "$a" in -c|-*|*=*) ;; *) sub="$a"; break;; esac; done
if [ "$sub" = fetch ] && [ -f "$B/write-on-fetch" ]; then cp "$B/payload" "$(cat "$B/write-on-fetch")"; rm -f "$B/write-on-fetch"; fi
case " $* " in *" --abort "*) exec ${JSON.stringify(realGit)} "$@";; esac
if [ -f "$B/hang-match" ] && echo "$*" | grep -Eq "$(cat "$B/hang-match")"; then sleep 60; exit 1; fi
if [ -n "$sub" ] && [ -f "$B/fail-$sub" ]; then echo "refused by the test" >&2; exit 1; fi
if [ -n "$sub" ] && [ -f "$B/hang-$sub" ]; then
  if [ "$(cat "$B/hang-$sub")" = after ]; then ${JSON.stringify(realGit)} "$@"; sleep 60; exit 1; fi
  sleep 60
fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
  originalPath = process.env.PATH;
  sh('git init -q --bare -b main', hub);
  initSync();
  sh('git config user.email mac@test.local && git config user.name mac', home);
  setRemote(hub);
});

afterEach(async () => {
  process.env.PATH = originalPath;
  setPullStepTimeoutForTest(null);
  setMergeTreeWriteTreeForTest(null);
  setApplyInterruptForTest(null);
  resetSyncGuardForTest();
  vi.restoreAllMocks();
  for (const d of [hub, cloud, bin]) await fsp.rm(d, { recursive: true, force: true });
});

async function base(files: Record<string, string>): Promise<string> {
  for (const [f, t] of Object.entries(files)) await write(home, f, t);
  commit(home, 'base', 600);
  sh('git push -q -u origin main', home);
  sh(`git clone -q "${hub}" "${cloud}"`, home);
  sh('git config user.email cloud@test.local && git config user.name cloud', cloud);
  return sh('git rev-parse HEAD', home);
}
function useWrapper(): void {
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
}

/** Both sides changed the grants store; this box's version is committed and newer. */
async function conflictingStores(): Promise<{ mine: string; localHead: string }> {
  await base({ 'host-exec-grants.json': store('base', '2026-11-24T08:00:00.000Z') });
  await write(cloud, 'host-exec-grants.json', store('remote', '2026-11-24T08:10:00.000Z'));
  commit(cloud, 'cloud saves grants', 60);
  sh('git push -q origin main', cloud);
  const mine = store('local', '2026-11-24T08:20:00.000Z');
  await write(home, 'host-exec-grants.json', mine);
  commit(home, 'mac saves grants', 30);
  return { mine, localHead: sh('git rev-parse HEAD', home) };
}

describe('a pull that cannot land cleanly changes nothing', () => {
  it('a store the app wrote during the fetch: nothing applied, the write survives byte for byte, the next tick merges it', async () => {
    const baseHead = await base({ 'host-exec-grants.json': store('base', '2026-11-24T08:00:00.000Z'), 'notes/a.md': 'a0\n' });
    await write(cloud, 'host-exec-grants.json', store('remote', '2026-11-24T08:10:00.000Z'));
    await write(cloud, 'notes/a.md', 'a1\n');
    commit(cloud, 'cloud saves', 60);
    sh('git push -q origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    // The app's write lands after this tick's commit, while the fetch runs.
    const appWrite = `${store('app', '2026-11-24T08:20:00.000Z')}   `;
    await fsp.writeFile(path.join(bin, 'payload'), appWrite);
    await fsp.writeFile(path.join(bin, 'write-on-fetch'), path.join(home, 'host-exec-grants.json'));
    useWrapper();
    const warn = vi.spyOn(log.git, 'warn');

    const first = await sync();

    expect(first.pulled).toBe(0);
    expect(await fsp.readFile(path.join(home, 'host-exec-grants.json'), 'utf-8')).toBe(appWrite);
    // Nothing else was applied either: the other pulled file is still this box's.
    expect(await fsp.readFile(path.join(home, 'notes/a.md'), 'utf-8')).toBe('a0\n');
    expect(sh('git rev-parse HEAD', home)).toBe(baseHead);
    expect(warn.mock.calls.find(([m]) => m === 'git-sync: a store changed while the pull was in flight — merge deferred to the next tick')?.[1])
      .toMatchObject({ files: ['host-exec-grants.json'] });

    const second = await sync();

    expect(second.pulled).toBe(1);
    // Both sides changed the grants store: merged record by record (git-sync-records.ts), the app's version leading.
    expect(JSON.parse(await fsp.readFile(path.join(home, 'host-exec-grants.json'), 'utf-8')).v).toBe('app');
    expect(await fsp.readFile(path.join(home, 'notes/a.md'), 'utf-8')).toBe('a1\n');
    expect(sh(`git merge-base --is-ancestor ${remoteHead} HEAD && echo yes`, home)).toBe('yes');
    expect(sh('git status --porcelain', home)).toBe('');
    expect(gitCalls().filter(remoteWinsOrTreeWrite)).toEqual([]);
  }, 60_000);

  it('a merge step that times out on the object-store path: no remote-wins, the tree and HEAD as they were', async () => {
    setMergeTreeWriteTreeForTest(true);
    setPullStepTimeoutForTest(1_500);
    const { mine, localHead } = await conflictingStores();
    await fsp.writeFile(path.join(bin, 'hang-merge-tree'), 'before');
    useWrapper();

    expect((await sync()).pulled).toBe(0);

    expect(await fsp.readFile(path.join(home, 'host-exec-grants.json'), 'utf-8')).toBe(mine);
    expect(sh('git rev-parse HEAD', home)).toBe(localHead);
    expect(fs.existsSync(path.join(home, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(sh('git status --porcelain', home)).toBe('');
    expect(gitCalls().some((c) => c.includes('merge-tree'))).toBe(true);
    expect(gitCalls().filter(remoteWinsOrTreeWrite)).toEqual([]);

    // The machine recovers: the next tick merges (this box's newer write wins).
    await fsp.rm(path.join(bin, 'hang-merge-tree'));
    expect((await sync()).pulled).toBe(1);
    expect(JSON.parse(await fsp.readFile(path.join(home, 'host-exec-grants.json'), 'utf-8')).v).toBe('local');
  }, 60_000);

  it('a `git merge` killed mid-merge on the legacy path: aborted, no remote-wins, the tree and HEAD as they were', async () => {
    setMergeTreeWriteTreeForTest(false);
    setPullStepTimeoutForTest(1_500);
    const { mine, localHead } = await conflictingStores();
    // Runs the real merge (markers and MERGE_HEAD land), then hangs until killed.
    await fsp.writeFile(path.join(bin, 'hang-merge'), 'after');
    useWrapper();
    const warn = vi.spyOn(log.git, 'warn');

    expect((await sync()).pulled).toBe(0);

    expect(await fsp.readFile(path.join(home, 'host-exec-grants.json'), 'utf-8')).toBe(mine);
    expect(sh('git rev-parse HEAD', home)).toBe(localHead);
    expect(fs.existsSync(path.join(home, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(sh('git status --porcelain', home)).toBe('');
    expect(warn.mock.calls.map(([m]) => m)).toContain('git-sync: the merge timed out — merge aborted, deferred to the next tick');
    const calls = gitCalls();
    expect(calls.some((c) => /^merge --no-edit origin\/main/.test(c))).toBe(true);
    expect(calls.filter((c) => subcommand(c) === 'pull' || c.includes('-X theirs'))).toEqual([]);
  }, 60_000);

  it('a rewrite whose adoption was deferred is still a rewrite next tick: the old chain is never merged back', async () => {
    const scrubbedFrom = await base({ 'data.txt': 'v1\n', 'secret.txt': 'token\n' });
    // filter-repo style on the hub: the same commit (author date, subject) without
    // secret.txt, then a newer edit on top, force-pushed.
    sh('git rm -q secret.txt', cloud);
    const meta = sh('git log -1 --format=%ad --date=raw', cloud);
    sh('git commit -q --amend -m base', cloud, { GIT_AUTHOR_DATE: meta, GIT_COMMITTER_DATE: meta });
    await write(cloud, 'data.txt', 'v2\n');
    commit(cloud, 'cloud edit', 60);
    sh('git push -q --force origin main', cloud);
    await fsp.writeFile(path.join(bin, 'payload'), 'app\n');
    await fsp.writeFile(path.join(bin, 'write-on-fetch'), path.join(home, 'data.txt'));
    useWrapper();

    expect((await sync()).pulled).toBe(0);
    expect(await fsp.readFile(path.join(home, 'data.txt'), 'utf-8')).toBe('app\n');
    expect(fs.existsSync(path.join(home, 'secret.txt'))).toBe(true); // nothing applied
    expect(sh('git rev-parse HEAD', home)).toBe(scrubbedFrom);
    expect(sh(`git rev-parse --verify -q ${REWRITE_FROM_REF}`, home)).toBe(scrubbedFrom);

    expect((await sync()).pulled).toBe(1);

    // Adopted, not merged: the scrubbed commit is not in the history, and its file stays gone.
    expect(() => sh(`git merge-base --is-ancestor ${scrubbedFrom} HEAD`, home)).toThrow();
    expect(fs.existsSync(path.join(home, 'secret.txt'))).toBe(false);
    expect(sh('git ls-files', home).split('\n')).not.toContain('secret.txt');
    // The app's write (committed by the second tick, newer than the hub's edit) won.
    expect(await fsp.readFile(path.join(home, 'data.txt'), 'utf-8')).toBe('app\n');
    expect(() => sh(`git rev-parse --verify -q ${REWRITE_FROM_REF}`, home)).toThrow();
    expect(sh('git rev-parse main', hub)).toBe(sh('git rev-parse HEAD', home));
    expect(sh('git status --porcelain', home)).toBe('');
  }, 60_000);
});

describe('a pull that stopped or could not be asked', () => {
  it('a pull killed part way: the next tick puts the tree back before committing, so the pulled content is never recorded as this box\'s', async () => {
    await base({ 'a.json': store('base', '2026-11-24T08:00:00.000Z'), 'b.json': store('base', '2026-11-24T08:00:00.000Z') });
    await write(cloud, 'a.json', store('hub', '2026-11-24T08:10:00.000Z'));
    await write(cloud, 'b.json', store('hub', '2026-11-24T08:10:00.000Z'));
    commit(cloud, 'cloud saves', 60);
    sh('git push -q origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    const localHead = sh('git rev-parse HEAD', home);
    const v = async (f: string): Promise<string> => JSON.parse(await fsp.readFile(path.join(home, f), 'utf-8')).v;

    setApplyInterruptForTest((step) => step === 1);
    expect((await sync()).pulled).toBe(0);
    setApplyInterruptForTest(null);
    // As a dead process leaves it: one store already the hub's, the other not yet.
    expect(await v('a.json')).toBe('hub');
    expect(await v('b.json')).toBe('base');

    // The dead apply's lock is still fresh: the tick stands down, and commits nothing.
    expect((await sync()).pulled).toBe(0);
    expect(await commitIfDirty()).toBe(false);
    expect(sh('git rev-parse HEAD', home)).toBe(localHead);

    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(home, '.git', 'index.lock'), old, old);
    expect((await sync()).pulled).toBe(1);
    // A fast-forward to the hub: no auto-save of the half-applied tree came first.
    expect(sh('git rev-parse HEAD', home)).toBe(remoteHead);
    expect(await v('a.json')).toBe('hub');
    expect(await v('b.json')).toBe('hub');
    expect(sh('git status --porcelain', home)).toBe('');
  }, 60_000);

  it('a `merge-base` that times out never reads as "no merge base": no rewrite adoption, nothing moved', async () => {
    setPullStepTimeoutForTest(1_500);
    await base({ 'a.md': 'a\n' });
    await write(cloud, 'b.md', 'b\n');
    commit(cloud, 'cloud adds b', 60);
    sh('git push -q origin main', cloud);
    await write(home, 'c.md', 'c\n');
    commit(home, 'mac adds c', 30);
    const localHead = sh('git rev-parse HEAD', home);
    await fsp.writeFile(path.join(bin, 'hang-match'), '^merge-base [0-9a-f]{40} [0-9a-f]{40}$');
    useWrapper();

    expect((await sync()).pulled).toBe(0);
    expect(sh('git rev-parse HEAD', home)).toBe(localHead);
    expect(() => sh('git rev-parse --verify -q pre-rewrite-backup', home)).toThrow();

    await fsp.rm(path.join(bin, 'hang-match'));
    expect((await sync()).pulled).toBe(1);
    expect(sh('git rev-list --count --merges HEAD', home)).toBe('0');
    expect(sh('git ls-files', home).split('\n')).toEqual(expect.arrayContaining(['a.md', 'b.md', 'c.md']));
  }, 60_000);

  it('a rewrite adoption on a git without `merge-tree --write-tree`: the carried chain lands, the next tick merges the rest the legacy way', async () => {
    setMergeTreeWriteTreeForTest(false);
    await base({ 'data.txt': 'v1\n', 'secret.txt': 'token\n' });
    // The hub: the same base commit without secret.txt (a scrub), then a newer edit on top.
    sh('git rm -q secret.txt', cloud);
    const meta = sh('git log -1 --format=%ad --date=raw', cloud);
    sh('git commit -q --amend -m base', cloud, { GIT_AUTHOR_DATE: meta, GIT_COMMITTER_DATE: meta });
    const newBase = sh('git rev-parse HEAD', cloud);
    await write(cloud, 'data.txt', 'v2\n');
    commit(cloud, 'cloud edit', 60);
    sh('git push -q --force origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    // This box: its own, newer edit of the same file.
    await write(home, 'data.txt', 'mine\n');
    commit(home, 'mac edit', 10);
    useWrapper();

    expect((await sync()).pulled).toBe(1);
    expect(sh('git rev-parse HEAD^', home)).toBe(newBase);
    expect(sh('git log -1 --format=%s', home)).toBe('mac edit');
    expect(() => sh(`git rev-parse --verify -q ${REWRITE_FROM_REF}`, home)).toThrow();
    expect(fs.existsSync(path.join(home, 'secret.txt'))).toBe(false);
    // The object-store three-way merge was never asked of this git.
    expect(gitCalls().filter((c) => subcommand(c) === 'merge-tree' && !c.includes('--merge-base'))).toEqual([]);

    expect((await sync()).pulled).toBe(1);
    expect(sh('git log -1 --format=%P', home).split(' ')).toHaveLength(2);
    expect(sh(`git merge-base --is-ancestor ${remoteHead} HEAD && echo yes`, home)).toBe('yes');
    expect(await fsp.readFile(path.join(home, 'data.txt'), 'utf-8')).toBe('mine\n');
    expect(sh('git ls-files', home).split('\n')).not.toContain('secret.txt');
    expect(sh('git status --porcelain', home)).toBe('');
  }, 60_000);

  it('whether git merges in the object store: read from `git --version`, and a probe that timed out is asked again', async () => {
    const says = (version: string) => async (): Promise<{ code: number; stdout: string; stderr: string }> =>
      ({ code: 0, stdout: `${version}\n`, stderr: '' });
    setMergeTreeWriteTreeForTest(null);
    expect(await mergeTreeWriteTreeSupported(says('git version 2.37.1'))).toBe(false);
    expect(await mergeTreeWriteTreeSupported(says('git version 2.47.3'))).toBe(false); // kept for the process
    setMergeTreeWriteTreeForTest(null);
    expect(await mergeTreeWriteTreeSupported(says('git version 2.39.5 (Apple Git-154)'))).toBe(true);
    setMergeTreeWriteTreeForTest(null);
    const timesOut = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (args[0] === '--version') return { code: 0, stdout: 'a git this cannot read\n', stderr: '' };
      throw new Error('git timed out');
    };
    expect(await mergeTreeWriteTreeSupported(timesOut)).toBe(false);
    expect(await mergeTreeWriteTreeSupported(says('git version 2.40.0'))).toBe(true);
  });
});

describe('a pull that cannot be settled stops auto-commits only', () => {
  it('a person committed after a pull died part way: no file is touched, the app\'s other writes keep syncing, pulls go on, and it settles', async () => {
    await base({ 'a.json': store('base', '2026-11-24T08:00:00.000Z'), 'b.json': store('base', '2026-11-24T08:00:00.000Z') });
    await write(cloud, 'a.json', store('hub', '2026-11-24T08:10:00.000Z'));
    await write(cloud, 'b.json', store('hub', '2026-11-24T08:10:00.000Z'));
    commit(cloud, 'cloud saves', 60);
    sh('git push -q origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    const v = async (f: string): Promise<string> => JSON.parse(await fsp.readFile(path.join(home, f), 'utf-8')).v;
    setApplyInterruptForTest((step) => step === 1);
    expect((await sync()).pulled).toBe(0);
    setApplyInterruptForTest(null);
    // A person clears the lock and commits something else; the app writes a new store.
    await fsp.rm(path.join(home, '.git', 'index.lock'));
    await write(home, 'elsewhere.md', 'a person\'s note\n');
    sh('git add elsewhere.md && git commit -q -m "a person\'s commit"', home);
    await write(home, 'c.json', store('app', '2026-11-24T08:20:00.000Z'));

    const first = await sync();

    expect(first.pulled).toBe(1);
    expect(await v('a.json')).toBe('hub'); // as the dead pull left it, then the pull agreed
    expect(await v('b.json')).toBe('hub');
    expect(sh(`git merge-base --is-ancestor ${remoteHead} HEAD && echo yes`, home)).toBe('yes');
    // The app's new store was committed; the held a.json was left out of that commit.
    expect(sh('git ls-files', home).split('\n')).toContain('c.json');
    expect(sh('git log --format=%s --author=mac -- a.json', home).split('\n')).toEqual(['base']);
    expect(sh('git status --porcelain', home)).toBe('');
    expect(getSyncGuardState().heldPull).not.toBeNull();

    await sync();
    expect(getSyncGuardState().heldPull).toBeNull();
    expect(fs.existsSync(path.join(home, '.git', 'walnut-apply-held'))).toBe(false);
    expect(sh('git rev-parse main', hub)).toBe(sh('git rev-parse HEAD', home));
  }, 60_000);

  it('a pull only git can write whose branch CAS is refused: the tree is put back to the branch, nothing recorded as this box\'s', async () => {
    await base({ '.gitattributes': '*.md text\n', 'data.md': 'v1\n' });
    await write(cloud, '.gitattributes', '*.md text\n*.dat -text\n');
    await write(cloud, 'data.md', 'v2 from the hub\n');
    commit(cloud, 'cloud saves', 60);
    sh('git push -q origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    const localHead = sh('git rev-parse HEAD', home);
    await fsp.writeFile(path.join(bin, 'fail-update-ref'), '');
    useWrapper();

    expect((await sync()).pulled).toBe(0);
    expect(await fsp.readFile(path.join(home, 'data.md'), 'utf-8')).toBe('v1\n');
    expect(await fsp.readFile(path.join(home, '.gitattributes'), 'utf-8')).toBe('*.md text\n');
    expect(sh('git rev-parse HEAD', home)).toBe(localHead);
    expect(sh('git status --porcelain', home)).toBe('');
    expect(getSyncGuardState().safeMode).toBe(false);

    await fsp.rm(path.join(bin, 'fail-update-ref'));
    expect((await sync()).pulled).toBe(1);
    expect(sh('git rev-parse HEAD', home)).toBe(remoteHead);
    expect(await fsp.readFile(path.join(home, 'data.md'), 'utf-8')).toBe('v2 from the hub\n');
  }, 60_000);
});

describe('a held pull never stops sync for good (round 3 review)', () => {
  it('the hub changes a held store again: other edits keep committing, the next pull replaces the held bytes, nothing old is committed as new', async () => {
    const T0 = '2026-11-24T08:00:00.000Z';
    await base({ 'a.json': store('head', T0), 'b.json': store('head', T0) });
    await write(cloud, 'a.json', store('t1', '2026-11-24T08:10:00.000Z'));
    await write(cloud, 'b.json', store('t1', '2026-11-24T08:10:00.000Z'));
    commit(cloud, 'hub t1', 120);
    sh('git push -q origin main', cloud);
    const v = async (f: string): Promise<string> => JSON.parse(await fsp.readFile(path.join(home, f), 'utf-8')).v;

    // The pull of t1 dies after writing a.json, and a.json's backup is lost: its rollback will fail.
    setApplyInterruptForTest((step) => step === 1);
    expect((await sync()).pulled).toBe(0);
    setApplyInterruptForTest(null);
    const journal = JSON.parse(await fsp.readFile(path.join(home, '.git/walnut-apply/journal.json'), 'utf-8')) as { ops: Array<{ path: string; before: { backup?: string } }> };
    await fsp.rm(path.join(home, '.git/walnut-apply', journal.ops.find((o) => o.path === 'a.json')!.before.backup!));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(home, '.git', 'index.lock'), old, old);
    // The hub saves a.json again; the user writes a note.
    await write(cloud, 'a.json', store('t2', '2026-11-24T08:20:00.000Z'));
    commit(cloud, 'hub t2', 60);
    sh('git push -q origin main', cloud);
    const t2 = sh('git rev-parse HEAD', cloud);
    await write(home, 'notes/today.md', 'the user\'s note\n');

    const first = await sync();

    expect(first.pulled).toBe(1);
    expect(await v('a.json')).toBe('t2'); // the held bytes (t1) replaced by the hub's newer version
    expect(await v('b.json')).toBe('t1');
    expect(sh('git ls-files', home).split('\n')).toContain('notes/today.md');
    expect(sh(`git merge-base --is-ancestor ${t2} HEAD && echo yes`, home)).toBe('yes');
    expect(sh('git status --porcelain', home)).toBe('');

    await sync();

    expect(getSyncGuardState().heldPull).toBeNull();
    expect(fs.existsSync(path.join(home, '.git', 'walnut-apply-held'))).toBe(false);
    expect(sh('git rev-parse main', hub)).toBe(sh('git rev-parse HEAD', home));
    // Nothing old was committed as this box's: no commit of the Mac's touches a.json after the base.
    expect(sh('git log --format=%s --author=mac -- a.json', home).split('\n')).toEqual(['base']);
    expect(sh('git show HEAD:a.json', home)).toContain('"t2"');
  }, 60_000);

  it('staging refuses while a pull is moving the tree or stopped part way, whoever asks', async () => {
    await base({ 'a.md': 'a\n' });
    await write(home, 'b.md', 'b\n');
    await fsp.mkdir(path.join(home, '.git', 'walnut-apply'), { recursive: true });
    await fsp.writeFile(path.join(home, '.git', 'walnut-apply', 'journal.json'), '{}');

    expect(await stageAllForCommit()).toBeNull();
    expect(sh('git diff --cached --name-only', home)).toBe('');

    await fsp.rm(path.join(home, '.git', 'walnut-apply'), { recursive: true });
    expect(await stageAllForCommit()).not.toBeNull();
    expect(sh('git diff --cached --name-only', home)).toBe('b.md');
  }, 60_000);
});
