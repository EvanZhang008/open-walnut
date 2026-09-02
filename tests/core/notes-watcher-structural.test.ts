/**
 * startNotesWatcher({ semantic: false }) — the structural-only mode the cloud
 * replica / no-index hosts run.
 *
 * Regression (dogfood R14, 2026-08-23): the replica skipped the watcher
 * entirely ("cloud mode: skipping semantic index init"), so a note that
 * arrived via git-sync — which never passes through a write route — was
 * invisible to the phone's notes search until the next restart's one-shot
 * drift scan. The fix keeps the NOTES_DIR fs.watch leg alive in that mode
 * (feeding the structural FTS reconciler) while the MEMORY_DIR leg, whose
 * only job is feeding the search index, stays off.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const mocks = vi.hoisted(() => ({
  scheduleNotesIndexUpdate: vi.fn(),
  resetNotesIndexer: vi.fn(),
  stopNotesIndexer: vi.fn(),
  upsertSearchV2File: vi.fn(async () => {}),
}));

vi.mock('../../src/constants.js', () =>
  createMockConstants('notes-watcher-structural-test'));
vi.mock('../../src/core/notes-indexer.js', () => ({
  scheduleNotesIndexUpdate: mocks.scheduleNotesIndexUpdate,
  resetNotesIndexer: mocks.resetNotesIndexer,
  stopNotesIndexer: mocks.stopNotesIndexer,
}));
vi.mock('../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  upsertSearchV2File: mocks.upsertSearchV2File,
}));

import { MEMORY_DIR, NOTES_DIR, WALNUT_HOME } from '../../src/constants.js';
import { startNotesWatcher } from '../../src/core/notes-watcher.js';

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

let handle: { stop: () => void } | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  await fsp.mkdir(NOTES_DIR, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
});

afterEach(async () => {
  handle?.stop();
  handle = null;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('startNotesWatcher structural-only mode', () => {
  it('semantic:false still feeds NOTES_DIR changes to the structural reconciler', async () => {
    handle = startNotesWatcher({ semantic: false });
    // fs.watch registration is synchronous, but give the platform a beat.
    await new Promise((r) => setTimeout(r, 100));
    await fsp.writeFile(path.join(NOTES_DIR, 'synced-note.md'), '# from git-sync\n');
    await waitFor(() => mocks.scheduleNotesIndexUpdate.mock.calls.length > 0);
    const paths = mocks.scheduleNotesIndexUpdate.mock.calls.map((c) => c[0]);
    expect(paths).toContain('synced-note.md');
  });

  it('semantic:false never registers the MEMORY_DIR (index) leg', async () => {
    handle = startNotesWatcher({ semantic: false });
    await new Promise((r) => setTimeout(r, 100));
    await fsp.writeFile(path.join(MEMORY_DIR, 'mem.md'), 'memory change\n');
    // The memory leg coalesces for 2s before upserting; wait past it.
    await new Promise((r) => setTimeout(r, 2500));
    expect(mocks.upsertSearchV2File).not.toHaveBeenCalled();
  });

  it('default mode keeps the memory leg (guard the fix did not regress it)', async () => {
    handle = startNotesWatcher();
    await new Promise((r) => setTimeout(r, 100));
    const memFile = path.join(MEMORY_DIR, 'mem.md');
    await fsp.writeFile(memFile, 'memory change\n');
    await waitFor(() => mocks.upsertSearchV2File.mock.calls.length > 0, 5000);
    expect(mocks.upsertSearchV2File).toHaveBeenCalledWith('memory', memFile);
  });
});
