/**
 * A store of records merges record by record when both sides of a pull changed
 * it (src/integrations/git-sync-records.ts), instead of one side's whole file.
 *
 * The case it exists for: a leader switch leaves two machines that each wrote
 * host-exec-grants.json. One revoked a grant, the other added one later. The
 * per-file LWW kept the newer file whole and the revoke was gone. Both pull
 * paths (the object-store merge and the legacy in-tree merge of a git before
 * 2.38) must keep every grant either side has, with a revoke on either side
 * winning. Real git, a bare hub and a second clone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-record-merge'));

import { execGitArgsStatus, initSync, setRemote, sync, resetSyncGuardForTest } from '../../src/integrations/git-sync.js';
import { setMergeTreeWriteTreeForTest } from '../../src/integrations/git-sync-merge.js';
import { mergeRecords } from '../../src/integrations/git-sync-records.js';
import { WALNUT_HOME } from '../../src/constants.js';

const home = WALNUT_HOME;
const hub = `${home}-hub.git`;
const cloud = `${home}-cloud`;

function sh(cmd: string, cwd: string, env?: Record<string, string>): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
  } catch (error) {
    throw new Error(`${cmd}: ${String((error as { stderr?: string }).stderr ?? '').trim()}`);
  }
}
function commit(dir: string, message: string, ageSec: number): void {
  const at = `${Math.floor(Date.now() / 1000) - ageSec} +0000`;
  sh(`git add -A && git commit -q -m "${message}"`, dir, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
}
const grant = (id: string, extra: Record<string, unknown> = {}) => ({ id, taskId: `task-${id}`, host: 'devbox', grantedAt: 1, runs: 0, ...extra });
const grants = (lastUpdated: string, list: unknown[]): string =>
  `${JSON.stringify({ version: 1, lastUpdated, grants: list, asks: [] }, null, 2)}\n`;
const file = (): string => path.join(home, 'host-exec-grants.json');

beforeEach(async () => {
  resetSyncGuardForTest();
  for (const d of [home, hub, cloud]) await fsp.rm(d, { recursive: true, force: true });
  for (const d of [home, hub]) await fsp.mkdir(d, { recursive: true });
  sh('git init -q --bare -b main', hub);
  initSync();
  sh('git config user.email mac@test.local && git config user.name mac', home);
  setRemote(hub);
});
afterEach(async () => {
  setMergeTreeWriteTreeForTest(null);
  resetSyncGuardForTest();
  for (const d of [hub, cloud]) await fsp.rm(d, { recursive: true, force: true });
});

describe('host-exec-grants.json changed on both sides', () => {
  it.each([
    ['the object-store merge', null],
    ['the legacy merge of a git before 2.38', false],
  ] as const)('%s keeps every grant either side has, and the revoke wins', async (_name, writeTree) => {
    setMergeTreeWriteTreeForTest(writeTree);
    await fsp.writeFile(file(), grants('2026-11-24T08:00:00.000Z', [grant('g1')]));
    commit(home, 'base', 600);
    sh('git push -q -u origin main', home);
    sh(`git clone -q "${hub}" "${cloud}"`, home);
    sh('git config user.email cloud@test.local && git config user.name cloud', cloud);
    // The hub (the newer file): a new grant. This box (the older file): the revoke.
    await fsp.writeFile(path.join(cloud, 'host-exec-grants.json'), grants('2026-11-24T08:30:00.000Z', [grant('g1'), grant('g2')]));
    commit(cloud, 'cloud grants g2', 60);
    sh('git push -q origin main', cloud);
    await fsp.writeFile(file(), grants('2026-11-24T08:20:00.000Z', [grant('g1', { revokedAt: 1_700_000_000_000 })]));
    commit(home, 'mac revokes g1', 30);

    const result = await sync();

    expect(result.pulled).toBe(1);
    const merged = JSON.parse(await fsp.readFile(file(), 'utf-8')) as { version: number; lastUpdated: string; grants: Array<{ id: string; revokedAt?: number }> };
    expect(merged.grants.map((g) => g.id).sort()).toEqual(['g1', 'g2']);
    expect(merged.grants.find((g) => g.id === 'g1')!.revokedAt).toBe(1_700_000_000_000);
    expect(merged.grants.find((g) => g.id === 'g2')!.revokedAt).toBeUndefined();
    expect(merged.version).toBe(1);
    // A fresh clock: the merge is the newest write of the file.
    expect(Date.parse(merged.lastUpdated)).toBeGreaterThan(Date.parse('2026-11-24T08:30:00.000Z'));
    expect(sh('git log -1 --format=%B', home)).toContain('records merged: host-exec-grants.json');
    expect(sh('git log -1 --format=%P', home).split(' ')).toHaveLength(2);
    expect(sh('git status --porcelain', home)).toBe('');
    expect(sh('git rev-parse main', hub)).toBe(sh('git rev-parse HEAD', home));
  }, 60_000);
});

describe('mergeRecords', () => {
  it('only for a registered path, both sides present, both readable', async () => {
    const run = (args: string[], opts?: { input?: string }) => execGitArgsStatus(args, { cwd: home, timeout: 30_000, ...opts });
    const blob = (text: string): string => `100644 ${sh(`printf '%s' '${text}' | git hash-object -w --stdin`, home)}`;
    const good = blob('{"grants":[],"asks":[]}');
    const broken = blob('{"grants": [');
    expect(await mergeRecords(run, 'host-exec-grants.json', good, good)).toMatch(/^100644 [0-9a-f]{40}$/);
    expect(await mergeRecords(run, 'host-exec-grants.json', good, broken)).toBeNull(); // LWW decides it
    expect(await mergeRecords(run, 'host-exec-grants.json', good, undefined)).toBeNull(); // a side deleted it
    expect(await mergeRecords(run, 'tasks.json', good, good)).toBeNull(); // no record merge registered
  });
});
