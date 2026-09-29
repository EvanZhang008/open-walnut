/**
 * The embedder never kills a worker in the middle of a run.
 *
 * worker.terminate() (or the process exiting) while onnxruntime is inside a run
 * aborts the whole process with "libc++abi: terminating due to uncaught
 * exception of type Napi::Error" (exit 134). On 2026-09-29 the production
 * server died that way after a wake: every timer fired at once, the passage
 * lane's idle reaper among them, while a backfill embed was running. The same
 * abort ended several server shutdowns. The host now asks the worker to stop,
 * the worker finishes its run and exits on its own, and only a run that
 * outlives the grace is forced.
 *
 * The fixture (fixtures/busy-embed-worker.cjs) speaks the real worker's stop
 * protocol and marks each finished job and its own clean exit in a file, which
 * is what these tests read back. The abort itself needs the real model and
 * onnxruntime, so it was reproduced by hand, not here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmbedder, type Embedder } from '../../src/lib/hybrid-search/embedder.js';

const BUSY_WORKER = new URL('./fixtures/busy-embed-worker.cjs', import.meta.url).pathname;

let dir = '';
let embedder: Embedder | null = null;
const logs: Array<{ level: string; msg: string }> = [];

function marks(): string[] {
  const file = path.join(dir, 'marks.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function make(workerData: Record<string, unknown>, options: { stopGraceMs?: number; passageIdleMs?: number } = {}): Embedder {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-embed-stop-'));
  const knobs = { markerFile: path.join(dir, 'marks.txt'), ...workerData };
  embedder = createEmbedder(
    { modelId: 'fake/busy:' + JSON.stringify(knobs), dims: 4, workerPath: BUSY_WORKER },
    (level, msg) => { logs.push({ level, msg }); },
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

describe('embed worker stop', () => {
  it('dispose during a run lets the run finish and the worker exit on its own', async () => {
    const e = make({ holdMs: 400 });
    const run = e.embedPassages(['a slow passage']);
    run.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await e.dispose();
    // By the time dispose resolves the run has finished and the thread ended
    // itself; a terminate() would have cut it off with neither mark written.
    expect(marks()).toEqual(['done 1', 'exit-clean']);
    await expect(run).rejects.toThrow('embed worker terminated');
    expect(logs.filter((l) => l.msg.includes('did not stop in time'))).toEqual([]);
  });

  it('the idle reaper leaves a lane with a run in flight alone', async () => {
    const e = make({ holdMs: 400 }, { passageIdleMs: 100 });
    expect(await e.embedPassages(['quick one'])).toHaveLength(1);
    // The reaper armed by the first job fires while this one is still running.
    const second = await e.embedPassages(['a slow passage']);
    expect(second).toHaveLength(1);
    expect(marks()).toEqual(['done 1', 'done 2']);
  });

  it('forces a worker whose run outlives the grace', async () => {
    const e = make({ ignoreStop: true }, { stopGraceMs: 200 });
    expect(await e.embedPassages(['quick one'])).toHaveLength(1);
    const t0 = Date.now();
    await e.dispose();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(marks()).toEqual(['done 1']);
    expect(logs.filter((l) => l.msg.includes('did not stop in time'))).toHaveLength(1);
  });

  it('a stopping worker that exits late does not fail the next worker\'s run', async () => {
    const e = make({ exitDelayMs: 300, holdMs: 500 }, { passageIdleMs: 50 });
    expect(await e.embedPassages(['quick one'])).toHaveLength(1);
    // Reaped after 50 ms; that thread lingers 300 ms more before it exits,
    // in the middle of the next worker's run.
    await new Promise((r) => setTimeout(r, 120));
    await expect(e.embedPassages(['a slow two'])).resolves.toHaveLength(1);
    expect(marks()).toEqual(['done 1', 'exit-clean', 'done 2']);
    await expect(e.embedPassages(['quick three'])).resolves.toHaveLength(1);
  });
});
