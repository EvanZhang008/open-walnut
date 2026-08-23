/**
 * Read-side self-heal in the shared JSON loader (src/utils/fs.ts).
 *
 * 2026-08-22: two data-repo JSON files were committed with git conflict markers
 * in them. readJsonFile threw `Failed to parse …` on every read, so /api/ui-prefs
 * returned 500 for hours and a bus subscriber crashed six times — while a good
 * version of the file sat one commit back in the data repo's history.
 *
 * The two halves this suite pins:
 *  - inside the data dir → restore from history, park the damaged original;
 *  - anywhere else, or with nothing recoverable → rethrow the ORIGINAL error,
 *    message shape untouched (callers and other tests match on it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readJsonFile, writeJsonFile } from '../../src/utils/fs.js';
import { resetJsonSelfHealCacheForTest } from '../../src/utils/json-conflict-recovery.js';

const MARKERED = [
  '{',
  '<<<<<<< HEAD',
  '  "theme": "dark"',
  '=======',
  '  "theme": "light"',
  '>>>>>>> origin/main',
  '}',
].join('\n');

const run = (cmd: string, cwd: string): string =>
  execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();

let dataDir: string;
let outsideDir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.OPEN_WALNUT_HOME;
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-selfheal-data-'));
  outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-selfheal-outside-'));
  process.env.OPEN_WALNUT_HOME = dataDir;
  resetJsonSelfHealCacheForTest();
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.OPEN_WALNUT_HOME;
  else process.env.OPEN_WALNUT_HOME = previousHome;
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(outsideDir, { recursive: true, force: true });
});

/** Data dir as a git repo holding one good commit of `rel`. */
async function seedRepo(rel: string, value: unknown): Promise<string> {
  run('git init -q -b main', dataDir);
  run('git config user.email t@t && git config user.name t', dataDir);
  const file = path.join(dataDir, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeJsonFile(file, value);
  run('git add -A && git commit -q -m good', dataDir);
  return file;
}

describe('readJsonFile self-heal (data dir)', () => {
  it('restores the last valid version and parks the marker-corrupted original', async () => {
    const file = await seedRepo('config/share/ui-prefs.json', { theme: 'dark', panel: 320 });
    await fsp.writeFile(file, MARKERED, 'utf-8');

    const value = await readJsonFile(file, { theme: 'fallback' } as Record<string, unknown>);
    expect(value).toEqual({ theme: 'dark', panel: 320 });

    // Live file is repaired on disk, not just in memory.
    expect(JSON.parse(await fsp.readFile(file, 'utf-8'))).toEqual({ theme: 'dark', panel: 320 });

    // Damaged original kept for forensics under a `.corrupt-<ts>` sidecar.
    const parked = (await fsp.readdir(path.dirname(file))).filter((f) => f.includes('.corrupt-'));
    expect(parked).toHaveLength(1);
    expect(await fsp.readFile(path.join(path.dirname(file), parked[0]), 'utf-8')).toBe(MARKERED);
  });

  it('heals a plain truncated file too (not only conflict markers)', async () => {
    const file = await seedRepo('tasks/store.json', { tasks: ['a', 'b'] });
    await fsp.writeFile(file, '{"tasks":["a",', 'utf-8'); // crash mid-write

    expect(await readJsonFile(file, null)).toEqual({ tasks: ['a', 'b'] });
  });

  it('concurrent readers share ONE recovery (no duplicate sidecars)', async () => {
    const file = await seedRepo('config/share/ui-prefs.json', { theme: 'dark' });
    await fsp.writeFile(file, MARKERED, 'utf-8');

    const results = await Promise.all([
      readJsonFile(file, null), readJsonFile(file, null), readJsonFile(file, null),
    ]);
    for (const r of results) expect(r).toEqual({ theme: 'dark' });
    const parked = (await fsp.readdir(path.dirname(file))).filter((f) => f.includes('.corrupt-'));
    expect(parked).toHaveLength(1);
  });

  it('rethrows the ORIGINAL parse error when history holds nothing valid', async () => {
    run('git init -q -b main', dataDir);
    run('git config user.email t@t && git config user.name t', dataDir);
    const file = path.join(dataDir, 'never-committed.json');
    await fsp.writeFile(file, MARKERED, 'utf-8');

    await expect(readJsonFile(file, null)).rejects.toThrow(`Failed to parse ${file}`);
    // Untouched: no sidecar, content preserved for a human to look at.
    expect(await fsp.readFile(file, 'utf-8')).toBe(MARKERED);
  });

  it('rethrows the ORIGINAL parse error when the data dir is not a git repo', async () => {
    const file = path.join(dataDir, 'config', 'share', 'ui-prefs.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, MARKERED, 'utf-8');

    await expect(readJsonFile(file, null)).rejects.toThrow(`Failed to parse ${file}`);
  });
});

describe('readJsonFile self-heal gate', () => {
  it('does NOT touch files outside the data dir, even inside a git repo', async () => {
    // A repo checkout that merely resembles the data dir: config files and test
    // fixtures must keep failing loudly rather than being silently rewritten.
    run('git init -q -b main', outsideDir);
    run('git config user.email t@t && git config user.name t', outsideDir);
    const file = path.join(outsideDir, 'fixture.json');
    await writeJsonFile(file, { good: true });
    run('git add -A && git commit -q -m good', outsideDir);
    await fsp.writeFile(file, MARKERED, 'utf-8');

    await expect(readJsonFile(file, null)).rejects.toThrow(`Failed to parse ${file}`);
    expect(await fsp.readFile(file, 'utf-8')).toBe(MARKERED);
    expect((await fsp.readdir(outsideDir)).filter((f) => f.includes('.corrupt-'))).toHaveLength(0);
  });

  it('keeps the untouched behaviours: missing file and empty file both fall back', async () => {
    await seedRepo('config/share/ui-prefs.json', { theme: 'dark' });
    const missing = path.join(dataDir, 'absent.json');
    expect(await readJsonFile(missing, { fallback: true })).toEqual({ fallback: true });

    const empty = path.join(dataDir, 'empty.json');
    await fsp.writeFile(empty, '   \n', 'utf-8');
    expect(await readJsonFile(empty, { fallback: true })).toEqual({ fallback: true });
  });
});
