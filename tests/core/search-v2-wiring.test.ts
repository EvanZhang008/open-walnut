/**
 * Search v2 wiring: flag gate, keyword lane adapter, event-bus incremental
 * sync (task upsert + junk-classified removal), and the markdown file sweep.
 *
 * Runs against the test-isolated OPEN_WALNUT_HOME (global-setup), so the
 * singleton index lands in a throwaway search.sqlite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventBus, EventNames } from '../../src/core/event-bus.js';
import { MEMORY_DIR } from '../../src/constants.js';
import { addTask, updateTask } from '../../src/core/task-manager.js';
import {
  getSearchV2Index,
  isSearchV2Enabled,
  resetSearchV2IndexForTests,
  searchV2Lane,
  startSearchV2Wiring,
  sweepSearchV2Files,
  type SearchV2Wiring,
} from '../../src/core/search/wiring.js';

const originalFlag = process.env.WALNUT_SEARCH_V2;

beforeAll(() => {
  process.env.WALNUT_SEARCH_V2 = '1';
  // Keyword-only in tests: the semantic lane would spawn a real worker thread
  // and load the ONNX model. The semantic layer has its own lib tests + eval.
  process.env.WALNUT_SEARCH_V2_SEMANTIC = '0';
});

afterAll(() => {
  if (originalFlag === undefined) delete process.env.WALNUT_SEARCH_V2;
  else process.env.WALNUT_SEARCH_V2 = originalFlag;
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
  it('defaults ON; WALNUT_SEARCH_V2=0 and WALNUT_DISABLE_SEARCH opt out', () => {
    expect(isSearchV2Enabled()).toBe(true);
    delete process.env.WALNUT_SEARCH_V2; // unset = on (2026-08-26 cutover)
    expect(isSearchV2Enabled()).toBe(true);
    process.env.WALNUT_DISABLE_SEARCH = '1';
    expect(isSearchV2Enabled()).toBe(false);
    delete process.env.WALNUT_DISABLE_SEARCH;
    process.env.WALNUT_SEARCH_V2 = '0';
    expect(isSearchV2Enabled()).toBe(false);
    process.env.WALNUT_SEARCH_V2 = '1';
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
