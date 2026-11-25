/**
 * A big file's chunks and their ids, worked out on a worker thread.
 *
 * A backup run reads every big file that changed, and the SQLite snapshots change on every run
 * (2026-11-25 on the Mac: usage, sessions and the notes index, about 2.5 GB, every 8 to 20
 * minutes). Cutting them (chunker.ts findCut, a JavaScript loop over every byte) and keying every
 * chunk (an HMAC over every byte) ran on the server's event loop: in the live stall profiles,
 * findCut and blobId were 11 s of 395 s of loop CPU. The worker reads the file, cuts it by the
 * same rule and ids each chunk; the run then reads from the file only the chunks the repository
 * lacks (backup-run.ts), so a mostly unchanged snapshot costs the loop almost nothing.
 *
 * The source is static JavaScript with the cut rule's numbers written in (a bundled build needs
 * no second file); tests/core/backup/repo-chunk-worker.test.ts proves its cuts equal chunker.ts's.
 * Any failure answers null, and the run cuts the file itself as before.
 */
import { Worker } from 'node:worker_threads';
import { AVG_CHUNK, GEAR, MASK_LOOSE, MASK_STRICT, MAX_CHUNK, MIN_CHUNK } from './chunker.js';

/** One file's chunks in order: [length, id]. */
export interface ChunkMap { size: number; chunks: Array<[number, string]> }

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const { createHmac } = require('node:crypto');
const MIN_CHUNK = ${MIN_CHUNK}, AVG_CHUNK = ${AVG_CHUNK}, MAX_CHUNK = ${MAX_CHUNK};
const MASK_STRICT = ${MASK_STRICT} >>> 0, MASK_LOOSE = ${MASK_LOOSE} >>> 0;
const GEAR = Uint32Array.from(${JSON.stringify([...GEAR])});
function findCut(buf) {
  const end = buf.length;
  if (end <= MIN_CHUNK) return end;
  const limit = Math.min(end, MAX_CHUNK);
  const normal = Math.min(limit, AVG_CHUNK);
  let h = 0;
  let i = MIN_CHUNK;
  for (; i < normal; i++) {
    h = ((h << 1) + GEAR[buf[i]]) >>> 0;
    if ((h & MASK_STRICT) === 0) return i + 1;
  }
  for (; i < limit; i++) {
    h = ((h << 1) + GEAR[buf[i]]) >>> 0;
    if ((h & MASK_LOOSE) === 0) return i + 1;
  }
  return limit;
}
parentPort.on('message', async ({ file, mac }) => {
  try {
    const key = Buffer.from(mac);
    const chunks = [];
    let size = 0;
    const emit = (c) => { chunks.push([c.length, createHmac('sha256', key).update(c).digest('hex')]); };
    // The same cuts as chunker.ts chunkStream: cut only once MAX_CHUNK bytes are pending.
    let parts = [];
    let pendingBytes = 0;
    for await (const b of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
      if (!b.length) continue;
      size += b.length;
      parts.push(b);
      pendingBytes += b.length;
      if (pendingBytes < 2 * MAX_CHUNK) continue;
      let p = parts.length === 1 ? parts[0] : Buffer.concat(parts, pendingBytes);
      while (p.length >= MAX_CHUNK) { const len = findCut(p); emit(p.subarray(0, len)); p = p.subarray(len); }
      parts = p.length ? [Buffer.from(p)] : [];
      pendingBytes = p.length;
    }
    let p = parts.length === 1 ? parts[0] : Buffer.concat(parts, pendingBytes);
    while (p.length > 0) { const len = findCut(p); emit(p.subarray(0, len)); p = p.subarray(len); }
    parentPort.postMessage({ ok: true, size, chunks });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
});
`;

const IDLE_MS = 15_000;
/** A file read slower than about 5 MB/s is given up on (the run then cuts it itself). */
const deadlineMs = (bytes: number) => 60_000 + bytes / 5_000;

let worker: Worker | null = null;
let idle: NodeJS.Timeout | null = null;
/** One file at a time: a run reads its files in turn. */
let chain: Promise<unknown> = Promise.resolve();

function drop(w: Worker): void {
  if (worker === w) worker = null;
  void w.terminate().catch(() => {});
}

function run(file: string, mac: Buffer, bytes: number): Promise<ChunkMap | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      if (idle) { clearTimeout(idle); idle = null; }
      w = worker ??= new Worker(WORKER_SOURCE, { eval: true, execArgv: [] });
    } catch { resolve(null); return; }
    const done = (answer: ChunkMap | null, broken: boolean) => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      if (broken) drop(w);
      else {
        w.unref();
        idle = setTimeout(() => { idle = null; drop(w); }, IDLE_MS);
        idle.unref?.();
      }
      resolve(answer);
    };
    const onMessage = (m: { ok?: boolean; size?: number; chunks?: Array<[number, string]> }) =>
      done(m?.ok === true && typeof m.size === 'number' && Array.isArray(m.chunks) ? { size: m.size, chunks: m.chunks } : null, false);
    const onError = () => done(null, true);
    const onExit = () => done(null, true);
    const timer = setTimeout(() => done(null, true), deadlineMs(bytes));
    timer.unref?.();
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    w.ref();
    try { w.postMessage({ file, mac }); } catch { done(null, true); }
  });
}

/** The chunks of `file` and their ids (HMAC-SHA256 under `mac`), or null when the worker could not tell. */
export function chunkMapOffLoop(file: string, mac: Buffer, bytes: number): Promise<ChunkMap | null> {
  const job = chain.then(() => run(file, mac, bytes));
  chain = job.catch(() => null);
  return job;
}

/** For tests: end the worker now. */
export async function _stopChunkWorkerForTesting(): Promise<void> {
  if (idle) { clearTimeout(idle); idle = null; }
  const w = worker;
  worker = null;
  if (w) await w.terminate().catch(() => {});
}
