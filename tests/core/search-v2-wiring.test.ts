/**
 * Search wiring: the enable gate, keyword lane adapter, event-bus incremental
 * sync (task upsert + junk-classified removal), and the markdown file sweep.
 *
 * Runs against the test-isolated OPEN_WALNUT_HOME (global-setup), so the
 * singleton index lands in a throwaway search.sqlite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventBus, EventNames } from '../../src/core/event-bus.js';
import { MEMORY_DIR } from '../../src/constants.js';
import { addTask, updateTask } from '../../src/core/task-manager.js';
import {
  embedModelCacheDir,
  getSearchV2Index,
  isSearchV2Enabled,
  resetSearchV2IndexForTests,
  searchV2Lane,
  startSearchV2Wiring,
  sweepSearchV2Files,
  type SearchV2Wiring,
} from '../../src/core/search/wiring.js';

beforeAll(() => {
  // Keyword-only in tests: the semantic lane would spawn a real worker thread
  // and load the ONNX model. The semantic layer has its own lib tests + eval.
  process.env.WALNUT_SEARCH_V2_SEMANTIC = '0';
});

afterAll(() => {
  delete process.env.WALNUT_SEARCH_V2_SEMANTIC;
  resetSearchV2IndexForTests();
});

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(check()).toBe(true);
}

describe('isSearchV2Enabled', () => {
  it('indexing is always on; only WALNUT_DISABLE_SEARCH opts out', () => {
    // There is no engine flag any more (the QMD stack is gone): the index IS
    // the engine, so the only question left is whether this host indexes at all.
    expect(isSearchV2Enabled()).toBe(true);
    process.env.WALNUT_DISABLE_SEARCH = '1';
    expect(isSearchV2Enabled()).toBe(false);
    delete process.env.WALNUT_DISABLE_SEARCH;
    expect(isSearchV2Enabled()).toBe(true);
  });
});

describe('searchV2Lane', () => {
  it('returns scored hits with raw doc text for snippets', async () => {
    const index = getSearchV2Index();
    index.upsert({
      kind: 'task',
      ref: 't-lane-1',
      title: 'Fix AcmeEventOperator reconciler',
      summary: '',
      note: 'The reconciler loops on missing CRDs and never converges.',
      meta: '',
      updatedAt: Date.now(),
    });
    const hits = await searchV2Lane('event operator reconciler', { kinds: ['task'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe('t-lane-1');
    expect(hits[0].text).toContain('never converges');
    expect(hits[0].components.coverage).toBeGreaterThan(0);
  });

  it('filters by kind', async () => {
    const index = getSearchV2Index();
    index.upsert({
      kind: 'memory',
      ref: '/tmp/fake-memory.md',
      title: 'AcmeEventOperator lore',
      updatedAt: Date.now(),
    });
    const hits = await searchV2Lane('AcmeEventOperator', { kinds: ['memory'] });
    expect(hits.every((h) => h.kind === 'memory')).toBe(true);
  });
});

describe('event-bus incremental sync', () => {
  let bus: EventBus;
  let wiring: SearchV2Wiring;

  afterEach(async () => {
    await wiring?.stop();
  });

  it('indexes a created task and removes it when it turns junk-titled', async () => {
    bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    const index = getSearchV2Index();

    const { task } = await addTask({ title: 'Wire the flux capacitor sync', project: 'marina' });
    bus.emit(EventNames.TASK_CREATED, { task }, ['*'], { source: 'test' });
    await waitFor(() => index.getDoc('task', task.id) !== null);
    expect(index.getDoc('task', task.id)?.title).toContain('flux capacitor');

    // Junk-classified title → serializer returns null → doc leaves the index.
    const { task: junked } = await updateTask(task.id, { title: 'Burst message echo test 7' });
    bus.emit(EventNames.TASK_UPDATED, { task: junked }, ['*'], { source: 'test' });
    await waitFor(() => index.getDoc('task', task.id) === null);
  });

  it('removes a deleted task from the index', async () => {
    bus = new EventBus();
    wiring = startSearchV2Wiring(bus);
    const index = getSearchV2Index();

    // Title must NOT trip isLedgerJunk (no "probe"/"echo test" words).
    const { task } = await addTask({ title: 'Deletable v2 sync target', project: 'marina' });
    bus.emit(EventNames.TASK_CREATED, { task }, ['*'], { source: 'test' });
    await waitFor(() => index.getDoc('task', task.id) !== null);

    // A delete event for an id no longer in tasks.json → remove path. The
    // task still exists on disk here, but TASK_DELETED enqueues 'delete' and
    // syncTasks re-reads: simulate the post-delete state via the real API.
    const { deleteTask } = await import('../../src/core/task-manager.js');
    await deleteTask(task.id);
    bus.emit(EventNames.TASK_DELETED, { task: { id: task.id } }, ['*'], { source: 'test' });
    await waitFor(() => index.getDoc('task', task.id) === null);
  });
});

describe('sweepSearchV2Files', () => {
  it('upserts new/changed markdown and removes deleted files', async () => {
    const index = getSearchV2Index();
    const dir = path.join(MEMORY_DIR, 'sweep-probe');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'sweep-target.md');
    await fsp.writeFile(file, '# Sweep target doc\n\nQuasar alignment notes.');

    const first = await sweepSearchV2Files();
    expect(first.changed).toBeGreaterThanOrEqual(1);
    expect(index.getDoc('memory', file)?.title).toBe('Sweep target doc');

    // Unchanged mtime → no re-upsert of this file.
    const second = await sweepSearchV2Files();
    expect(second.changed).toBe(0);

    await fsp.rm(file);
    const third = await sweepSearchV2Files();
    expect(third.removed).toBeGreaterThanOrEqual(1);
    expect(index.getDoc('memory', file)).toBeNull();
  });
});

describe('embedModelCacheDir', () => {
  it('lives under the ignored cache/ dir and moves a legacy root models/ over exactly once', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-embed-cache-'));
    try {
      // Fresh install: nothing to migrate, the path is simply cache/models.
      expect(embedModelCacheDir(home)).toBe(path.join(home, 'cache', 'models'));
      expect(fs.existsSync(path.join(home, 'cache', 'models'))).toBe(false);

      // Upgrade from a root-level models/ (the layout that leaked into git).
      await fsp.mkdir(path.join(home, 'models', 'onnx-community', 'm'), { recursive: true });
      await fsp.writeFile(path.join(home, 'models', 'onnx-community', 'm', 'model.onnx'), 'weights');
      expect(embedModelCacheDir(home)).toBe(path.join(home, 'cache', 'models'));
      expect(fs.existsSync(path.join(home, 'models'))).toBe(false);
      expect(await fsp.readFile(path.join(home, 'cache', 'models', 'onnx-community', 'm', 'model.onnx'), 'utf-8')).toBe('weights');

      // Both present (a stale root dir reappearing): the cache/ copy wins, the root dir is left alone.
      await fsp.mkdir(path.join(home, 'models'), { recursive: true });
      expect(embedModelCacheDir(home)).toBe(path.join(home, 'cache', 'models'));
      expect(fs.existsSync(path.join(home, 'models'))).toBe(true);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});
