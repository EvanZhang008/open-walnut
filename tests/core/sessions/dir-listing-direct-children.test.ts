/**
 * A local listing always returns the asked folder's own children; its time budget bounds only the
 * preload of deeper levels (2026-11-11 review: on a loaded Mac `~/` read "No matches" while
 * `~/p` listed the same folders).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listLocalDirs, LOCAL_BFS_BUDGET_MS } from '../../../src/core/sessions/dir-listing.js';

let tmp = '';
afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('listLocalDirs past its budget', () => {
  it('still lists every direct child, and stops preloading deeper', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-listing-'));
    for (const name of ['Documents', 'projects', '.cache']) fs.mkdirSync(path.join(tmp, name, 'inner'), { recursive: true });
    // The clock jumps past the budget right after the walk starts: a readdir slowed by load.
    const start = Date.now();
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (calls++ < 1 ? start : start + LOCAL_BFS_BUDGET_MS + 1_000));
    const listing = await listLocalDirs(`${tmp}/`, 2);
    expect(listing.exists).toBe(true);
    const names = listing.dirs.map((d) => d.slice(tmp.length + 1)).sort();
    expect(names).toEqual(['.cache', 'Documents', 'projects']);
  });

  it('with time to spare, preloads the next level as before', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-listing-'));
    fs.mkdirSync(path.join(tmp, 'projects', 'app'), { recursive: true });
    const listing = await listLocalDirs(`${tmp}/`, 2);
    expect(listing.dirs.map((d) => d.slice(tmp.length + 1)).sort()).toEqual(['projects', 'projects/app']);
  });
});
