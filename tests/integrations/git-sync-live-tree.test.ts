/**
 * A pull never lets a live store hold something no writer wrote (2026-11-24).
 *
 * The server reads and writes the JSON stores in the data repo's working tree
 * while git-sync pulls. At 08:39 that morning `git merge` ran in the live tree:
 * host-exec-grants.json held conflict markers for seconds, three tasks'
 * host_exec reads were refused, and the web layer "self-healed" a marker-filled
 * board from HEAD mid-merge. `pull --rebase` and `reset --hard` had the same
 * shape: for a moment a file held the hub's older version, or nothing, or half.
 *
 * Each case runs a reader in a tight loop on the files the pull touches, the
 * whole time the pull runs, and fails on ANY read that is not one of the whole
 * versions a writer wrote. Real git, a real bare hub and a second clone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-live-tree'));

import { initSync, setRemote, sync, gitPullWalnut, resetSyncGuardForTest } from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';

const home = WALNUT_HOME;
let hub: string;
let cloud: string;

function sh(cmd: string, cwd: string, env?: Record<string, string>): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    throw new Error(`${cmd}: ${String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim()}`);
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
const store = (v: string, lastUpdated: string, pad = 0): string =>
  `${JSON.stringify({ version: 1, lastUpdated, v, rows: Array.from({ length: pad }, (_, i) => ({ i, text: `row ${i} of ${v}` })) }, null, 2)}\n`;

/**
 * Read `files` (repo-relative) in a tight loop until stopped. A read that fails,
 * or returns text `whole` does not accept, is recorded as bad.
 */
function watch(files: string[], whole: (file: string, text: string) => boolean) {
  let running = true;
  const bad: string[] = [];
  const seen = new Map<string, Set<string>>(files.map((f) => [f, new Set<string>()]));
  let reads = 0;
  const loop = (async () => {
    while (running) {
      for (const file of files) {
        try {
          const text = await fsp.readFile(path.join(home, file), 'utf-8');
          reads++;
          if (whole(file, text)) seen.get(file)!.add(text);
          else bad.push(`${file}: ${JSON.stringify(text.slice(0, 120))}`);
        } catch (error) {
          bad.push(`${file}: read failed (${(error as NodeJS.ErrnoException).code})`);
        }
      }
      await new Promise((r) => setImmediate(r));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { bad, seen, reads };
    },
  };
}

beforeEach(async () => {
  resetSyncGuardForTest();
  hub = `${home}-hub.git`;
  cloud = `${home}-cloud`;
  for (const d of [home, hub, cloud]) await fsp.rm(d, { recursive: true, force: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(hub, { recursive: true });
  sh('git init -q --bare -b main', hub);
  initSync();
  sh('git config user.email mac@test.local && git config user.name mac', home);
  setRemote(hub);
});

afterEach(async () => {
  resetSyncGuardForTest();
  for (const d of [hub, cloud]) await fsp.rm(d, { recursive: true, force: true });
});

/** Commit `files` on this box as the shared base, push it, and clone the "cloud box". */
async function base(files: Record<string, string>): Promise<void> {
  for (const [f, t] of Object.entries(files)) await write(home, f, t);
  commit(home, 'base', 600);
  sh('git push -q -u origin main', home);
  sh(`git clone -q "${hub}" "${cloud}"`, home);
  sh('git config user.email cloud@test.local && git config user.name cloud', cloud);
}

const parses = (text: string): boolean => {
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

describe('a pull never exposes a half-merged, older or missing store', () => {
  it('both sides changed the same JSON stores: every read parses, LWW picks the newer write, the merge keeps both parents', async () => {
    await base({
      'host-exec-grants.json': store('base', '2026-11-24T08:00:00.000Z', 200),
      'boards/b.json': store('base', '2026-11-24T08:00:00.000Z', 200),
    });
    // The hub: an older grants write, a newer board write.
    await write(cloud, 'host-exec-grants.json', store('remote', '2026-11-24T08:10:00.000Z', 210));
    await write(cloud, 'boards/b.json', store('remote', '2026-11-24T08:30:00.000Z', 210));
    commit(cloud, 'cloud saves', 60);
    sh('git push -q origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    // This box: the newer grants write, an older board write.
    await write(home, 'host-exec-grants.json', store('local', '2026-11-24T08:20:00.000Z', 220));
    await write(home, 'boards/b.json', store('local', '2026-11-24T08:20:00.000Z', 220));
    commit(home, 'mac saves', 30);
    const localHead = sh('git rev-parse HEAD', home);
    const events: unknown[] = [];
    bus.subscribe('web-ui', (e) => { if (e.name === 'sync:conflict-resolved') events.push(e.data); });

    const reader = watch(['host-exec-grants.json', 'boards/b.json'], (_f, t) => parses(t));
    try {
      const result = await sync();
      expect(result.conflicts).toBe(2);
    } finally {
      const { bad, reads } = await reader.stop();
      bus.unsubscribe('web-ui');
      expect(bad).toEqual([]);
      expect(reads).toBeGreaterThan(10);
    }
    expect(JSON.parse(await fsp.readFile(path.join(home, 'host-exec-grants.json'), 'utf-8')).v).toBe('local');
    expect(JSON.parse(await fsp.readFile(path.join(home, 'boards/b.json'), 'utf-8')).v).toBe('remote');
    const parents = sh('git log -1 --format=%P', home).split(' ');
    expect(parents).toEqual([localHead, remoteHead]);
    expect(sh('git log -1 --format=%s', home)).toBe('merge: LWW conflict resolution (2 files)');
    expect(sh('git status --porcelain', home)).toBe('');
    expect(events).toEqual([{ files: ['boards/b.json', 'host-exec-grants.json'], winner: 'remote', losingCommit: localHead }]);
    // The hub got the merge: both boxes now hold the same history.
    expect(sh('git rev-parse main', hub)).toBe(sh('git rev-parse HEAD', home));
  }, 60_000);

  it('a clean divergence never shows the hub\'s older version of a file this box changed, and stays linear', async () => {
    await base({ 'tasks.json': store('base', '2026-11-24T08:00:00.000Z', 300), 'notes/n.md': 'n0\n' });
    await write(cloud, 'notes/n.md', 'n1\n');
    commit(cloud, 'cloud edits a note', 60);
    sh('git push -q origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    await write(home, 'tasks.json', store('local', '2026-11-24T08:20:00.000Z', 300));
    commit(home, 'mac saves tasks', 40);
    await write(home, 'other.json', store('local-2', '2026-11-24T08:21:00.000Z'));
    commit(home, 'mac saves other', 30);

    const mine = await fsp.readFile(path.join(home, 'tasks.json'), 'utf-8');
    const reader = watch(['tasks.json'], (_f, t) => t === mine);
    try {
      await sync();
    } finally {
      const { bad } = await reader.stop();
      expect(bad).toEqual([]);
    }
    expect(await fsp.readFile(path.join(home, 'notes/n.md'), 'utf-8')).toBe('n1\n');
    // Linear: the two local commits sit on the hub's head, one parent each.
    expect(sh('git rev-list --count --merges HEAD', home)).toBe('0');
    expect(sh('git rev-parse HEAD~2', home)).toBe(remoteHead);
    expect(sh('git log --format=%s -2', home).split('\n')).toEqual(['mac saves other', 'mac saves tasks']);
    expect(sh('git status --porcelain', home)).toBe('');
  }, 60_000);

  it('a fast-forward never shows a missing or partial file, and keeps the file\'s permission bits', async () => {
    const before = store('base', '2026-11-24T08:00:00.000Z', 20_000);
    await base({ 'conversations/c1.json': before, 'gone/old.md': 'old\n' });
    await fsp.chmod(path.join(home, 'conversations/c1.json'), 0o640);
    const after = store('remote', '2026-11-24T08:30:00.000Z', 24_000);
    await write(cloud, 'conversations/c1.json', after);
    await write(cloud, 'fresh/new.md', 'new\n');
    sh('git rm -q gone/old.md', cloud);
    commit(cloud, 'cloud saves a conversation', 60);
    sh('git push -q origin main', cloud);

    const reader = watch(['conversations/c1.json'], (_f, t) => t === before || t === after);
    try {
      expect((await sync()).pulled).toBe(1);
    } finally {
      const { bad } = await reader.stop();
      expect(bad).toEqual([]);
    }
    expect(await fsp.readFile(path.join(home, 'conversations/c1.json'), 'utf-8')).toBe(after);
    expect((await fsp.stat(path.join(home, 'conversations/c1.json'))).mode & 0o777).toBe(0o640);
    expect(await fsp.readFile(path.join(home, 'fresh/new.md'), 'utf-8')).toBe('new\n');
    expect((await fsp.stat(path.join(home, 'fresh/new.md'))).mode & 0o777).toBe(0o600);
    await expect(fsp.stat(path.join(home, 'gone'))).rejects.toThrow(); // the emptied dir went too
    expect(sh('git rev-parse HEAD', home)).toBe(sh('git rev-parse HEAD', cloud));
    expect(sh('git status --porcelain', home)).toBe('');
  }, 60_000);

  it('gitPullWalnut\'s fast-forward goes through the same apply: whole files only', async () => {
    const before = store('base', '2026-11-24T08:00:00.000Z', 20_000);
    await base({ 'conversations/c1.json': before });
    const after = store('remote', '2026-11-24T08:30:00.000Z', 24_000);
    await write(cloud, 'conversations/c1.json', after);
    commit(cloud, 'cloud saves a conversation', 60);
    sh('git push -q origin main', cloud);

    const reader = watch(['conversations/c1.json'], (_f, t) => t === before || t === after);
    try {
      await gitPullWalnut();
    } finally {
      const { bad } = await reader.stop();
      expect(bad).toEqual([]);
    }
    expect(await fsp.readFile(path.join(home, 'conversations/c1.json'), 'utf-8')).toBe(after);
    expect(sh('git rev-parse HEAD', home)).toBe(sh('git rev-parse HEAD', cloud));
    expect(sh('git status --porcelain', home)).toBe('');
  }, 60_000);

  it('a rewrite adoption never shows a missing or partial file, and carries the local commit', async () => {
    const before = store('base', '2026-11-24T08:00:00.000Z', 20_000);
    await base({ 'conversations/c1.json': before });
    // The hub: a newer conversation store, then a compaction of it to a fresh root,
    // cut before this box's next commit (so that commit is carried across).
    const after = store('remote', '2026-11-24T08:30:00.000Z', 24_000);
    await write(cloud, 'conversations/c1.json', after);
    commit(cloud, 'cloud saves a conversation', 60);
    const cut = `${Math.floor(Date.now() / 1000) - 30} +0000`;
    const newRoot = sh('git commit-tree HEAD^{tree} -m compacted', cloud, { GIT_COMMITTER_DATE: cut, GIT_AUTHOR_DATE: cut });
    sh(`git push -q --force origin ${newRoot}:refs/heads/main`, cloud);
    // This box: a later local commit on another file.
    await write(home, 'mine.md', 'mine\n');
    commit(home, 'mac work', 0);
    const oldHead = sh('git rev-parse HEAD', home);

    const reader = watch(['conversations/c1.json'], (_f, t) => t === before || t === after);
    try {
      expect((await sync()).pulled).toBe(1);
    } finally {
      const { bad } = await reader.stop();
      expect(bad).toEqual([]);
    }
    expect(await fsp.readFile(path.join(home, 'conversations/c1.json'), 'utf-8')).toBe(after);
    expect(await fsp.readFile(path.join(home, 'mine.md'), 'utf-8')).toBe('mine\n');
    expect(sh('git rev-parse HEAD^', home)).toBe(newRoot);
    expect(sh('git rev-parse pre-rewrite-backup', home)).toBe(oldHead);
    expect(sh('git status --porcelain', home)).toBe('');
  }, 60_000);
});
