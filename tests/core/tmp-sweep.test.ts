/**
 * Orphan atomic-write temp-file sweeper (src/core/tmp-sweep.ts).
 *
 * The bug it prevents: writeJsonFile() writes `.open-walnut-<hex>.tmp` beside its
 * target and renames it, so a killed process leaves the .tmp behind in a DATA
 * dir. The 30s auto-save then stages it, and a concurrent write removing it
 * mid-`git add` kills the commit with `fatal: unable to stat` — wedging the whole
 * auto-commit loop (2026-08-09).
 *
 * The two properties that matter: stale orphans go, and anything that might be an
 * IN-FLIGHT write (young .tmp) or real user data stays.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-tmp-sweep'));

import { sweepOrphanAtomicTmpFiles } from '../../src/core/tmp-sweep.js';
import { WALNUT_HOME, SYNC_DIR, TASKS_DIR, MEMORY_DIR } from '../../src/constants.js';

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);

/** Write a file and (optionally) backdate its mtime past the 1h age gate. */
async function makeFile(dir: string, name: string, stale: boolean): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const full = path.join(dir, name);
  await fsp.writeFile(full, 'x');
  if (stale) await fsp.utimes(full, TWO_HOURS_AGO, TWO_HOURS_AGO);
  return full;
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

describe('sweepOrphanAtomicTmpFiles', () => {
  beforeEach(async () => {
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('deletes stale orphans across every swept directory', async () => {
    const orphans = await Promise.all([
      makeFile(WALNUT_HOME, '.open-walnut-a1b2c3d4e5f60718.tmp', true),
      makeFile(SYNC_DIR, '.open-walnut-deadbeef.tmp', true),
      makeFile(TASKS_DIR, '.open-walnut-0123456789abcdef.tmp', true),
      makeFile(path.join(TASKS_DIR, 'outbox'), '.open-walnut-ff00.tmp', true),
      makeFile(MEMORY_DIR, '.open-walnut-abc123.tmp', true),
      makeFile(path.join(WALNUT_HOME, 'sessions'), '.open-walnut-cafe01.tmp', true),
      makeFile(path.join(WALNUT_HOME, 'sessions', 'transcripts'), '.open-walnut-beef02.tmp', true),
    ]);

    const removed = await sweepOrphanAtomicTmpFiles();

    expect(removed.sort()).toEqual([...orphans].sort());
    for (const o of orphans) expect(await exists(o)).toBe(false);
  });

  it('keeps a young .tmp — it may be an in-flight write by another process', async () => {
    const fresh = await makeFile(SYNC_DIR, '.open-walnut-99887766.tmp', false);
    const removed = await sweepOrphanAtomicTmpFiles();
    expect(removed).toEqual([]);
    expect(await exists(fresh)).toBe(true);
  });

  it('only matches the exact atomic-write shape, never real data files', async () => {
    const keep = await Promise.all([
      makeFile(WALNUT_HOME, 'tasks.json', true),
      makeFile(WALNUT_HOME, 'config.yaml', true),
      // Similar-but-different names: no hex body, wrong prefix, wrong extension.
      makeFile(WALNUT_HOME, '.open-walnut-.tmp', true),
      makeFile(WALNUT_HOME, '.open-walnut-zzzz.tmp', true),
      makeFile(WALNUT_HOME, 'open-walnut-abc123.tmp', true),
      makeFile(WALNUT_HOME, '.open-walnut-abc123.tmp.bak', true),
    ]);

    const removed = await sweepOrphanAtomicTmpFiles();

    expect(removed).toEqual([]);
    for (const k of keep) expect(await exists(k)).toBe(true);
  });

  it('does not recurse — notes/ and plugin node_modules must never be scanned', async () => {
    // A .tmp nested below a swept dir stays: the sweep is non-recursive by design
    // (WALNUT_HOME holds an entire Obsidian vault; a deep scan on every boot
    // would be tens of thousands of stats).
    const nested = await makeFile(
      path.join(WALNUT_HOME, 'notes', 'housing'),
      '.open-walnut-1a2b3c.tmp',
      true,
    );
    const removed = await sweepOrphanAtomicTmpFiles();
    expect(removed).toEqual([]);
    expect(await exists(nested)).toBe(true);
  });

  it('never throws when the directories do not exist (fresh install)', async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await expect(sweepOrphanAtomicTmpFiles()).resolves.toEqual([]);
  });
});
