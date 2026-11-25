/**
 * Temp copies a killed git merge leaves in the data repo never sync, and old ones go (2026-11-24).
 *
 * A personal merge driver timed out 251 times inside git-sync's merge-tree. Each stopped merge left
 * git's three `.merge_file_XXXXXX` temp copies of the file at the data repo's root, 777 of them
 * (3.2 GiB), and the next auto-save committed every one, so they synced to every host.
 *
 * The class guard runs real git: a merge driver that blocks, the merge stopped the way git-sync
 * stops one (a group SIGTERM, then a group SIGKILL), and then EVERY file the stopped git left in the
 * worktree must be ignored by the data repo's .gitignore and named as the sweep knows it. A git that
 * starts leaving a new kind of temp file fails here, whatever it calls it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';
import { waitFor } from '../helpers/poll-wait.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-git-temp-leftovers'));

import { ensureRepo, GITIGNORE_CONTENT, resetSyncGuardForTest } from '../../src/integrations/git-sync.js';
import {
  GIT_TEMP_IGNORE_LINES, GIT_TEMP_STALE_MS, GIT_TEMP_UNTRACK_PER_SWEEP, isGitTempLeftoverName, sweepGitTempLeftovers,
} from '../../src/integrations/git-sync-temp-leftovers.js';
import { WALNUT_HOME } from '../../src/constants.js';

const home = WALNUT_HOME;
const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function sh(cmd: string, cwd = home): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ENV } }).trim();
}
function commitAll(message: string): void {
  sh(`git add -A && git -c user.name=t -c user.email=t@t.local commit -q -m "${message}"`);
}
const leftoversOnDisk = (): string[] => fs.readdirSync(home).filter((n) => n.startsWith('.merge_file_')).sort();
const age = (file: string, ms: number): void => {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(path.join(home, file), at, at);
};

beforeEach(async () => {
  resetSyncGuardForTest();
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.mkdir(home, { recursive: true });
  sh('git init -q -b main');
});

describe('a merge git-sync stops leaves nothing the data repo would commit', () => {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`every file a merge stopped by ${signal} leaves is ignored and swept`, async () => {
      await fsp.writeFile(path.join(home, '.gitignore'), GITIGNORE_CONTENT);
      const started = path.join(`${home}-driver-started`);
      await fsp.rm(started, { force: true });
      // The driver says it started, then blocks until the merge is stopped.
      sh(`git config merge.block.driver 'touch "${started}"; exec sleep 600'`);
      await fsp.writeFile(path.join(home, '.git', 'info', 'attributes'), '* merge=block\n');
      await fsp.writeFile(path.join(home, 'tasks.json'), '{"v":"base"}\n');
      commitAll('base');
      sh('git checkout -q -b other');
      await fsp.writeFile(path.join(home, 'tasks.json'), '{"v":"other"}\n');
      commitAll('other');
      sh('git checkout -q main');
      await fsp.writeFile(path.join(home, 'tasks.json'), '{"v":"main"}\n');
      commitAll('main');

      // The way git-sync's git helpers run and stop git: its own process group, killed whole.
      const child = spawn('git', ['merge-tree', '--write-tree', 'main', 'other'], {
        cwd: home, detached: true, stdio: 'ignore', env: { ...process.env, ...ENV },
      });
      const closed = new Promise((resolve) => child.on('close', resolve));
      await waitFor(() => fs.existsSync(started), 20_000, 'the merge driver to start');
      process.kill(-child.pid!, signal);
      await closed;

      const left = leftoversOnDisk();
      // git 2.39 to 2.47 leave all three temps on either signal: the case this guards.
      expect(left.length).toBeGreaterThan(0);
      const unignored = sh('git ls-files -o --exclude-standard');
      expect(unignored, 'a file the stopped merge left would be committed').toBe('');
      for (const name of sh('git ls-files -o -i --exclude-standard').split('\n').filter(Boolean)) {
        expect(isGitTempLeftoverName(name), `${name} is not a name the sweep removes`).toBe(true);
      }

      for (const name of left) age(name, GIT_TEMP_STALE_MS + 1_000);
      const sweep = await sweepGitTempLeftovers(home, async (args) => sh(`git ${args}`));
      expect(sweep.removed.sort()).toEqual(left);
      expect(leftoversOnDisk()).toEqual([]);
    }, 60_000);
  }
});

describe('an install that already committed them heals at boot', () => {
  it('untracks and removes stale leftovers, keeps a fresh one, and gains the ignore line', async () => {
    // An older .gitignore, without the line.
    const old = GITIGNORE_CONTENT.split('\n').filter((l) => !GIT_TEMP_IGNORE_LINES.includes(l)).join('\n');
    await fsp.writeFile(path.join(home, '.gitignore'), old);
    await fsp.writeFile(path.join(home, 'tasks.json'), '{}\n');
    for (const name of ['.merge_file_AbC123', '.merge_file_x9Y8z7']) {
      await fsp.writeFile(path.join(home, name), `copy of a store ${name}\n`);
    }
    // Not git's names: the sweep never touches them.
    await fsp.writeFile(path.join(home, '.merge_file_notes'), 'mine\n');
    await fsp.mkdir(path.join(home, 'notes'), { recursive: true });
    await fsp.writeFile(path.join(home, 'notes', '.merge_file_Q1w2E3'), 'a note\n');
    commitAll('auto-save');
    expect(sh('git ls-files')).toContain('.merge_file_AbC123');
    age('.merge_file_AbC123', GIT_TEMP_STALE_MS + 1_000);
    age('.merge_file_x9Y8z7', GIT_TEMP_STALE_MS + 1_000);
    // A merge still running: written a minute ago.
    await fsp.writeFile(path.join(home, '.merge_file_Fresh1'), 'in use\n');
    age('.merge_file_Fresh1', 60_000);

    const result = await ensureRepo();
    expect(result.available).toBe(true);

    expect(fs.readFileSync(path.join(home, '.gitignore'), 'utf-8').split('\n')).toEqual(expect.arrayContaining(GIT_TEMP_IGNORE_LINES));
    expect(leftoversOnDisk()).toEqual(['.merge_file_Fresh1', '.merge_file_notes']);
    const tracked = sh('git ls-files').split('\n');
    expect(tracked).not.toContain('.merge_file_AbC123');
    expect(tracked).not.toContain('.merge_file_x9Y8z7');
    // Root only: a note of that name is the user's and still syncs.
    expect(tracked).toContain('notes/.merge_file_Q1w2E3');
    expect(sh('git check-ignore -q notes/.merge_file_Q1w2E3 || echo synced')).toBe('synced');
    // The removal is staged for the next auto-save; the history still holds the copies.
    expect(sh('git diff --cached --name-status')).toContain('D\t.merge_file_AbC123');
    expect(sh('git log --all --format=%H -- .merge_file_AbC123')).not.toBe('');
    // The fresh one stays out of the next commit.
    expect(sh('git check-ignore .merge_file_Fresh1')).toBe('.merge_file_Fresh1');
  });

  it('a leftover whose untrack fails stays on disk, so the index never points at a deleted file', async () => {
    await fsp.writeFile(path.join(home, '.merge_file_Keep01'), 'x\n');
    commitAll('auto-save');
    age('.merge_file_Keep01', GIT_TEMP_STALE_MS + 1_000);
    const sweep = await sweepGitTempLeftovers(home, async (args) => (args.startsWith('rm ') ? null : sh(`git ${args}`)));
    expect(sweep.removed).toEqual([]);
    expect(leftoversOnDisk()).toEqual(['.merge_file_Keep01']);
  });
  it('untracks at most one batch per sweep, so staged deletions never reach the torn-worktree count', async () => {
    const count = GIT_TEMP_UNTRACK_PER_SWEEP * 2 + 5;
    const names = Array.from({ length: count }, (_, i) => `.merge_file_${String(i).padStart(6, '0')}`);
    for (const name of names) await fsp.writeFile(path.join(home, name), 'x\n');
    commitAll('auto-save');
    for (const name of names) age(name, GIT_TEMP_STALE_MS + 1_000);
    // An untracked stale one is removed whatever the batch.
    await fsp.writeFile(path.join(home, '.merge_file_Untrk1'), 'x\n');
    age('.merge_file_Untrk1', GIT_TEMP_STALE_MS + 1_000);
    const run = async (args: string): Promise<string | null> => sh(`git ${args}`);

    const first = await sweepGitTempLeftovers(home, run);
    expect(first.untracked).toHaveLength(GIT_TEMP_UNTRACK_PER_SWEEP);
    expect(first.removed).toHaveLength(GIT_TEMP_UNTRACK_PER_SWEEP + 1);
    expect(sh('git status --porcelain').split('\n').filter(Boolean)).toHaveLength(GIT_TEMP_UNTRACK_PER_SWEEP);
    commitAll('auto-save');
    await sweepGitTempLeftovers(home, run);
    commitAll('auto-save');
    const third = await sweepGitTempLeftovers(home, run);
    expect(third.untracked).toHaveLength(5);
    expect(leftoversOnDisk()).toEqual([]);
  });

  it('a failed listing of the index deletes nothing', async () => {
    await fsp.writeFile(path.join(home, '.merge_file_List01'), 'x\n');
    commitAll('auto-save');
    age('.merge_file_List01', GIT_TEMP_STALE_MS + 1_000);
    const sweep = await sweepGitTempLeftovers(home, async (args) => (args.startsWith('ls-files') ? null : sh(`git ${args}`)));
    expect(sweep.removed).toEqual([]);
    expect(leftoversOnDisk()).toEqual(['.merge_file_List01']);
  });
});
