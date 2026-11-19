import { Worker } from 'node:worker_threads';

/**
 * Load a module once in a throwaway worker thread, so the files it reads and
 * the native library it opens are in memory before the loop thread loads it.
 *
 * A first `require` is synchronous: every file read and the dlopen of a native
 * library run on the calling thread. On the Mac under memory pressure the
 * first sharp load (libvips, about 20 MB) held the server's loop 4.1 s
 * (2026-11-19 01:25Z: 99% of the hold in sharp's require, 225 page-ins, 144 ms
 * of CPU). After a worker has loaded it, the loop thread's own load reads
 * from memory (measured on Linux: 116 ms in the worker, then 41 ms on the
 * main thread, which went on running timers meanwhile).
 *
 * Resolves true when the worker loaded it, false when it could not (the
 * caller loads it anyway and reports that error as before) or took longer
 * than `timeoutMs`. Never rejects.
 */
export function warmModuleOffThread(entry: string, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WARM_WORKER, { eval: true, workerData: { entry } });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => { /* already gone */ });
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    worker.on('message', (m: { ok?: boolean }) => settle(m?.ok === true));
    worker.on('error', () => settle(false));
    worker.on('exit', () => settle(false));
  });
}

const WARM_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
try {
  require(workerData.entry)
  parentPort.postMessage({ ok: true })
} catch (error) {
  parentPort.postMessage({ ok: false })
}
`;
