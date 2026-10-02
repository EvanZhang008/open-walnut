/**
 * The embedder never kills a worker in the middle of a run, and a worker that
 * dies takes only itself.
 *
 * Ending onnxruntime while it is inside a run aborts its process with
 * "libc++abi: terminating due to uncaught exception of type Napi::Error"
 * (exit 134). While the worker was a worker THREAD, that process was the host:
 * on 2026-09-29 the production server died after a wake (every timer fired at
 * once, the passage lane's idle reaper among them, while a backfill embed was
 * running), and on 2026-10-02 a CI test process died when a model load outlived
 * the stop grace and the thread was forced. The host now asks the worker to
 * stop, the worker finishes its run and exits on its own, only a run that
 * outlives the grace is killed, and the worker is a child process, so neither
 * a kill nor an abort can reach the host.
 *
 * The fixture (fixtures/busy-embed-worker.cjs) speaks the real worker's stop
 * protocol and marks each finished job and its own clean exit in a file, which
 * is what these tests read back. The real worker's own exits, and hosts that are
 * separate processes, are in hybrid-search-embed-worker-process.test.ts. The
 * abort itself needs the real model and onnxruntime, so it was reproduced by
 * hand; a worker killing itself mid-run stands in for it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmbedder, type Embedder } from '../../src/lib/hybrid-search/embedder.js';

const BUSY_WORKER = new URL('./fixtures/busy-embed-worker.cjs', import.meta.url).pathname;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

  it('kills a worker whose run outlives the grace, and only the worker', async () => {
    const e = make({ ignoreStop: true, markPid: true }, { stopGraceMs: 200 });
    expect(await e.embedPassages(['quick one'])).toHaveLength(1);
    const pid = Number(marks()[0].split(' ')[1]);
    expect(pid).not.toBe(process.pid);
    const t0 = Date.now();
    await e.dispose();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(marks()).toEqual([`pid ${pid}`, 'done 1']);
    expect(logs.filter((l) => l.msg.includes('did not stop in time'))).toHaveLength(1);
    // dispose resolves only once the worker is gone.
    expect(alive(pid)).toBe(false);
  });

  it('a worker that dies in the middle of a run takes only itself', async () => {
    const e = make({ dieOnSlow: true, holdMs: 2000 });
    expect(await e.embedPassages(['quick one'])).toHaveLength(1);
    await expect(e.embedPassages(['a slow passage'])).rejects.toThrow('embed worker exited (SIGKILL)');
    // This process is still here, and the lane starts a fresh worker.
    await expect(e.embedPassages(['quick two'])).resolves.toHaveLength(1);
    await expect(e.embedQuery('quick query', 10_000)).resolves.toMatchObject({ source: 'worker' });
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
