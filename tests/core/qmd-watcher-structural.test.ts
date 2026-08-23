/**
 * startQmdWatcher({ semantic: false }) — the structural-only mode the cloud
 * replica / no-qmd hosts run.
 *
 * Regression (dogfood R14, 2026-08-23): the replica skipped the watcher
 * entirely ("cloud mode: skipping QMD semantic index init"), so a note that
 * arrived via git-sync — which never passes through a write route — was
 * invisible to the phone's notes search until the next restart's one-shot
 * drift scan. The fix keeps the NOTES_DIR fs.watch leg alive in that mode
 * (feeding the structural FTS reconciler) while the MEMORY_DIR leg, whose
 * only job is semantic embedding, stays off.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const mocks = vi.hoisted(() => ({
  scheduleNotesIndexUpdate: vi.fn(),
  resetNotesIndexer: vi.fn(),
  stopNotesIndexer: vi.fn(),
  dispatchQmdIncrementalIndex: vi.fn(async () => {}),
}));

vi.mock('../../src/constants.js', () =>
  createMockConstants('qmd-watcher-structural-test'));
vi.mock('../../src/core/notes-indexer.js', () => ({
  scheduleNotesIndexUpdate: mocks.scheduleNotesIndexUpdate,
  resetNotesIndexer: mocks.resetNotesIndexer,
  stopNotesIndexer: mocks.stopNotesIndexer,
}));
vi.mock('../../src/core/qmd-dispatcher.js', () => ({
  dispatchQmdIncrementalIndex: mocks.dispatchQmdIncrementalIndex,
}));

import { MEMORY_DIR, NOTES_DIR, WALNUT_HOME } from '../../src/constants.js';
import { startQmdWatcher } from '../../src/core/qmd-watcher.js';

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

describe('startQmdWatcher structural-only mode', () => {
  it('semantic:false still feeds NOTES_DIR changes to the structural reconciler', async () => {
    handle = startQmdWatcher({ semantic: false });
    // fs.watch registration is synchronous, but give the platform a beat.
    await new Promise((r) => setTimeout(r, 100));
    await fsp.writeFile(path.join(NOTES_DIR, 'synced-note.md'), '# from git-sync\n');
    await waitFor(() => mocks.scheduleNotesIndexUpdate.mock.calls.length > 0);
    const paths = mocks.scheduleNotesIndexUpdate.mock.calls.map((c) => c[0]);
    expect(paths).toContain('synced-note.md');
  });

  it('semantic:false never registers the MEMORY_DIR (embedding) leg', async () => {
    handle = startQmdWatcher({ semantic: false });
    await new Promise((r) => setTimeout(r, 100));
    await fsp.writeFile(path.join(MEMORY_DIR, 'mem.md'), 'memory change\n');
    // The memory leg debounces 2s before dispatching; wait past it.
    await new Promise((r) => setTimeout(r, 2500));
    expect(mocks.dispatchQmdIncrementalIndex).not.toHaveBeenCalled();
  });

  it('default mode keeps the memory leg (guard the fix did not regress it)', async () => {
    handle = startQmdWatcher();
    await new Promise((r) => setTimeout(r, 100));
    await fsp.writeFile(path.join(MEMORY_DIR, 'mem.md'), 'memory change\n');
    await waitFor(() => mocks.dispatchQmdIncrementalIndex.mock.calls.length > 0, 5000);
    expect(mocks.dispatchQmdIncrementalIndex).toHaveBeenCalledWith({ memory: true });
  });
});
