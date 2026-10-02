/**
 * A watcher's 'error' event must never reach the process as an uncaught exception.
 *
 * Regression (CI browser shard, 2026-10-02): on Linux Node runs a recursive
 * fs.watch in JS and reads every folder that appears; a note's `.lock` dir was
 * gone by the time it was read, the watcher emitted 'error' with nobody
 * listening, and the server exited (`uncaughtException: ENOENT: scandir
 * '.../Nested List.md.lock'`), failing every test after it.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('notes-watcher-errors-test'));
vi.mock('../../src/core/notes-indexer.js', () => ({
  scheduleNotesIndexUpdate: vi.fn(),
  resetNotesIndexer: vi.fn(),
  stopNotesIndexer: vi.fn(),
}));
vi.mock('../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  upsertSearchV2File: vi.fn(async () => {}),
}));

import { MEMORY_DIR, NOTES_DIR, WALNUT_HOME } from '../../src/constants.js';
import { hearWatchErrors, startNotesWatcher } from '../../src/core/notes-watcher.js';

const ROOT = path.resolve(__dirname, '../..');
const enoent = () => Object.assign(new Error("ENOENT: no such file or directory, scandir 'Nested List.md.lock'"), { code: 'ENOENT' });

let handle: { stop: () => void } | null = null;

beforeEach(async () => {
  await fsp.mkdir(NOTES_DIR, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
});

afterEach(async () => {
  handle?.stop();
  handle = null;
  vi.restoreAllMocks();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('notes watcher errors', () => {
  it('both recursive watchers hear their errors, so a vanished folder is not a crash', () => {
    const fakes: EventEmitter[] = [];
    vi.spyOn(fs, 'watch').mockImplementation((() => {
      const w = Object.assign(new EventEmitter(), { close: () => {} });
      fakes.push(w);
      return w;
    }) as unknown as typeof fs.watch);
    handle = startNotesWatcher();
    expect(fakes).toHaveLength(2);
    for (const w of fakes) {
      // Without a listener, EventEmitter#emit('error') throws: the uncaught exception.
      expect(() => w.emit('error', enoent())).not.toThrow();
      expect(() => w.emit('error', Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }))).not.toThrow();
    }
  });

  it('hearWatchErrors returns the same watcher with a listener on it', () => {
    const w = new EventEmitter() as unknown as fs.FSWatcher;
    expect(hearWatchErrors(w, NOTES_DIR)).toBe(w);
    expect(w.listenerCount('error')).toBe(1);
  });

  it('a folder gone between its stat and its read does not kill the process (the Linux race)', async () => {
    // Linux's JS recursive watcher: an event on a watched folder stats it (still there),
    // then reads it (gone). Forced here by failing that read; this is exactly the
    // `scandir '...md.lock'` CI hit. macOS watches natively and never reads, so there
    // the test only proves nothing else breaks.
    let armed = false;
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (armed && String(p).endsWith('.md.lock')) throw enoent();
      return (real as (...a: unknown[]) => unknown).call(fs, p, ...rest);
    }) as typeof fs.readdirSync);
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      handle = startNotesWatcher();
      const lock = path.join(NOTES_DIR, 'Nested List.md.lock');
      fs.mkdirSync(lock);
      await new Promise((r) => setTimeout(r, 300));
      armed = true;
      fs.writeFileSync(path.join(lock, 'pid'), '1');
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      armed = false;
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });
});

describe('every fs.watch in the server listens for errors', () => {
  it('each file that calls fs.watch attaches an error listener per watcher', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(ROOT, 'src', f))
    let checked = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
      const watches = (text.match(/\bfs\.watch\(/g) ?? []).length;
      if (!watches) continue;
      checked++;
      const heard = (text.match(/\.on\(\s*'error'/g) ?? []).length + (text.match(/hearWatchErrors\(fs\.watch\(/g) ?? []).length;
      expect(heard, path.relative(ROOT, file)).toBeGreaterThanOrEqual(watches);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
