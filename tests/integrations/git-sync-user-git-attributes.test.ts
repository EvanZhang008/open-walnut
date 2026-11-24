/**
 * The user's own git attributes never reach the data repo (2026-11-24).
 *
 * A personal ~/.config/git/attributes mapped `*.json` and `*.md` to a
 * syntax-aware merge driver. Git-sync's pull computes a divergence with
 * `merge-tree --write-tree`, which ran that driver on every file both sides
 * changed: over 30 s, so the merge timed out on every tick for six hours,
 * nothing synced, and every push was rejected as diverged. Where the driver
 * did finish, its merged text replaced git-sync's own per-file LWW.
 *
 * Real git, a real bare hub and a second clone, with a hostile global config
 * (GIT_CONFIG_GLOBAL) whose attributes file maps EVERY path to a merge driver
 * and a filter that leave a trace when they run, and that signs every commit
 * with a signer that always fails (a global commit.gpgsign the server cannot
 * sign with made every auto-commit fail silently).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-user-git-attributes'));

import { initSync, setRemote, sync, ensureRepo, resetSyncGuardForTest, notePullStalled, stalledPullsForTest } from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

const home = WALNUT_HOME;
let hub: string;
let cloud: string;
let userDir: string;
let trace: string;
let savedGlobal: string | undefined;

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
const store = (v: string, lastUpdated: string): string =>
  `${JSON.stringify({ version: 1, lastUpdated, v, rows: [{ id: 1, text: `row of ${v}` }] }, null, 2)}\n`;

/** Paths of every kind the data repo holds: stores, notes, memory, attachments, dotfiles. */
const SAMPLE_PATHS = [
  'tasks.json', 'host-exec-grants.json', 'boards/b.json', 'notes/n.md', 'memory/MEMORY.md',
  'artifacts/projects/P/memory/t-1/reflections/2026-11-24.json', 'config.yaml', 'attachments/a.png', '.gitignore',
];

beforeEach(async () => {
  resetSyncGuardForTest();
  hub = `${home}-hub.git`;
  cloud = `${home}-cloud`;
  userDir = `${home}-user`;
  for (const d of [home, hub, cloud, userDir]) await fsp.rm(d, { recursive: true, force: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(hub, { recursive: true });
  await fsp.mkdir(userDir, { recursive: true });
  trace = path.join(userDir, 'driver-ran');
  const driver = path.join(userDir, 'driver.sh');
  // A merge driver that "wins" every merge with its own text, and a filter that marks what it touched.
  await fsp.writeFile(driver, `#!/bin/sh\necho "$1" >> "${trace}"\nprintf 'DRIVER\\n' > "$2"\nexit 0\n`, { mode: 0o755 });
  await fsp.writeFile(path.join(userDir, 'attributes'), '* merge=trap filter=trap diff=trap\n');
  await fsp.writeFile(path.join(userDir, 'gitconfig'), [
    '[core]', `\tattributesFile = ${path.join(userDir, 'attributes')}`,
    '[merge "trap"]', '\tname = trap', `\tdriver = ${driver} %A %A`,
    '[filter "trap"]', `\tclean = sh -c 'echo clean >> "${trace}"; cat'`, `\tsmudge = sh -c 'echo smudge >> "${trace}"; cat'`,
    '[commit]', '\tgpgsign = true', '[gpg]', '\tprogram = false',
    '[user]', '\tname = mac', '\temail = mac@test.local', '',
  ].join('\n'));
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(userDir, 'gitconfig');
  sh('git init -q --bare -b main', hub);
  initSync();
  setRemote(hub);
});

afterEach(async () => {
  resetSyncGuardForTest();
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  for (const d of [hub, cloud, userDir]) await fsp.rm(d, { recursive: true, force: true });
});

/** Every attribute git resolves for `file` in the data repo, as `name: value` lines. */
function attributesOf(file: string): string[] {
  return sh(`git check-attr -a -- "${file}"`, home).split('\n').filter(Boolean);
}

describe("the user's global git attributes never apply in the data repo", () => {
  it('no path of any kind resolves an attribute from the user\'s attributes file', () => {
    // The hostile file really is in effect for git outside the data repo.
    const plain = path.join(userDir, 'plain');
    sh(`git init -q "${plain}"`, userDir);
    expect(sh('git check-attr merge -- tasks.json', plain)).toBe('tasks.json: merge: trap');
    for (const file of SAMPLE_PATHS) expect(attributesOf(file), file).toEqual([]);
    expect(sh('git config --local --get core.attributesFile', home)).toBe('');
  });

  it('a data repo made before the fix gets the settings back at the next boot, and a later boot writes nothing', async () => {
    sh('git config --local --unset core.attributesFile', home);
    sh('git config --local --unset commit.gpgsign', home);
    expect(attributesOf('tasks.json')).not.toEqual([]);
    expect(await ensureRepo()).toEqual({ available: true });
    for (const file of SAMPLE_PATHS) expect(attributesOf(file), file).toEqual([]);
    expect(sh('git config --get commit.gpgsign', home)).toBe('false');
    const config = path.join(home, '.git', 'config');
    const before = { text: await fsp.readFile(config, 'utf-8'), mtime: (await fsp.stat(config)).mtimeMs };
    expect(await ensureRepo()).toEqual({ available: true });
    expect({ text: await fsp.readFile(config, 'utf-8'), mtime: (await fsp.stat(config)).mtimeMs }).toEqual(before);
  });

  it('a setting that cannot be written leaves sync on', async () => {
    sh('git config --local --unset core.attributesFile', home);
    const lock = path.join(home, '.git', 'config.lock');
    await fsp.writeFile(lock, '');
    try {
      expect(await ensureRepo()).toEqual({ available: true });
    } finally {
      await fsp.rm(lock, { force: true });
    }
  });

  it('a diverged pull merges with git-sync\'s own LWW, never the user\'s merge driver, and the push goes through', async () => {
    await write(home, 'tasks.json', store('base', '2026-11-24T08:00:00.000Z'));
    await write(home, 'notes/n.md', 'base\n');
    commit(home, 'base', 600);
    sh('git push -q -u origin main', home);
    sh(`git clone -q "${hub}" "${cloud}"`, home);
    // The cloud box clones through the same hostile global config; it is the data repo under test only on this box.
    sh('git config --local core.attributesFile "" && git config --local commit.gpgsign false', cloud);
    await write(cloud, 'tasks.json', store('remote', '2026-11-24T08:10:00.000Z'));
    await write(cloud, 'notes/n.md', 'remote\n');
    commit(cloud, 'cloud saves', 60);
    sh('git push -q origin main', cloud);
    const remoteHead = sh('git rev-parse HEAD', cloud);
    await write(home, 'tasks.json', store('local', '2026-11-24T08:20:00.000Z'));
    await write(home, 'notes/n.md', 'local\n');
    commit(home, 'mac saves', 30);
    const localHead = sh('git rev-parse HEAD', home);

    // Earlier ticks that did not land: the pull that lands ends their streak.
    for (let i = 0; i < 3; i++) notePullStalled('the merge could not be computed: git timed out after 30000ms');
    const result = await sync();
    expect(stalledPullsForTest().ticks).toBe(0);

    expect(fs.existsSync(trace) ? await fsp.readFile(trace, 'utf-8') : '').toBe('');
    expect(result.conflicts).toBe(2);
    expect(JSON.parse(await fsp.readFile(path.join(home, 'tasks.json'), 'utf-8')).v).toBe('local');
    expect(await fsp.readFile(path.join(home, 'notes/n.md'), 'utf-8')).not.toContain('DRIVER');
    expect(sh('git log -1 --format=%P', home).split(' ')).toEqual([localHead, remoteHead]);
    expect(sh('git log -1 --format=%s', home)).toMatch(/^merge: LWW conflict resolution/);
    expect(sh('git rev-parse main', hub)).toBe(sh('git rev-parse HEAD', home));
  }, 60_000);
});
