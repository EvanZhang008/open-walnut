/**
 * The embedder gives a model copy back when nothing uses it.
 *
 * Each worker lane holds a full model copy (measured +2.2 GB of footprint for
 * the default model). The query lane used to stay for the life of the process
 * although production saw queries in 54 of 1314 minutes; it is now released
 * after an idle time and respawned by the next query. The passage lane used to
 * wait out a 5 min idle timer after every backfill pass, with passes ~10 min
 * apart, so it stayed about half the time; the pass now releases it on drain.
 *
 * The worker is the stop-protocol fixture (fixtures/busy-embed-worker.cjs):
 * "done <id>" per finished job, "exit-clean" when a worker process ends itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmbedder, type Embedder, type EmbedderOptions } from '../../src/lib/hybrid-search/embedder.js';

const BUSY_WORKER = new URL('./fixtures/busy-embed-worker.cjs', import.meta.url).pathname;

let dir = '';
let embedder: Embedder | null = null;
const logs: string[] = [];

function marks(): string[] {
  const file = path.join(dir, 'marks.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
const exits = () => marks().filter((m) => m === 'exit-clean').length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Generous: each worker is a forked process, slow to start on a loaded machine.
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
}

function make(options: EmbedderOptions, workerData: Record<string, unknown> = {}): Embedder {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-embed-idle-'));
  const knobs = { markerFile: path.join(dir, 'marks.txt'), ...workerData };
  embedder = createEmbedder(
    { modelId: 'fake/busy:' + JSON.stringify(knobs), dims: 4, workerPath: BUSY_WORKER },
    (_level, msg) => { logs.push(msg); },
    options,
  );
  return embedder;
}

afterEach(async () => {
  await embedder?.dispose();
  embedder = null;
  logs.length = 0;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('query lane idle release', () => {
  it('releases the query worker after the idle time and respawns it for the next query', async () => {
    const e = make({ queryIdleMs: 150 });
    expect((await e.embedQuery('first query', 5_000))?.source).toBe('worker');
    expect(exits()).toBe(0);
    await until(() => exits() === 1);
    expect(exits()).toBe(1);
    expect(logs).toContain('hybrid-search: query embed worker released after idle');
    // A cached query still answers without a worker; a new one spawns it again.
    expect((await e.embedQuery('first query', 5_000))?.source).toBe('cache');
    expect(exits()).toBe(1);
    expect((await e.embedQuery('second query', 5_000))?.source).toBe('worker');
    expect(marks().filter((m) => m.startsWith('done'))).toHaveLength(2);
  });

  it('a query in flight when the timer fires keeps its worker', async () => {
    const e = make({ queryIdleMs: 100 }, { holdMs: 500 });
    expect((await e.embedQuery('quick one', 5_000))?.source).toBe('worker');
    const slow = await e.embedQuery('a slow query', 5_000); // spans the idle time
    expect(slow?.source).toBe('worker');
    expect(exits()).toBe(0);
    await until(() => exits() === 1);
    expect(exits()).toBe(1);
  });

  it('every new query restarts the idle clock', async () => {
    const e = make({ queryIdleMs: 300 });
    for (let i = 0; i < 4; i++) {
      await e.embedQuery(`query ${i}`, 5_000);
      await sleep(150);
    }
    expect(exits()).toBe(0);
    await until(() => exits() === 1);
    expect(exits()).toBe(1);
  });

  it('queryIdleMs 0 keeps the worker resident', async () => {
    const e = make({ queryIdleMs: 0 });
    await e.embedQuery('resident', 5_000);
    await sleep(400);
    expect(exits()).toBe(0);
  });
});

describe('passage lane release at the end of a pass', () => {
  it('stops an idle passage worker at once', async () => {
    const e = make({ passageIdleMs: 60_000 });
    expect(await e.embedPassages(['one'])).toHaveLength(1);
    expect(await e.releasePassageWorker()).toBe(true);
    expect(exits()).toBe(1);
    expect(await e.releasePassageWorker()).toBe(false); // nothing left to stop
    // The next pass simply spawns it again.
    expect(await e.embedPassages(['two'])).toHaveLength(1);
  });

  it('never stops a passage run in flight', async () => {
    const e = make({ passageIdleMs: 60_000 }, { holdMs: 400 });
    const run = e.embedPassages(['a slow passage']);
    await sleep(100);
    expect(await e.releasePassageWorker()).toBe(false);
    expect(await run).toHaveLength(1);
    expect(exits()).toBe(0);
  });

  it('leaves the query worker alone', async () => {
    const e = make({ passageIdleMs: 60_000, queryIdleMs: 0 });
    await e.embedQuery('a query', 5_000);
    await e.embedPassages(['a passage']);
    await e.releasePassageWorker();
    expect(exits()).toBe(1);
    expect((await e.embedQuery('another query', 5_000))?.source).toBe('worker');
    expect(exits()).toBe(1);
  });
});
