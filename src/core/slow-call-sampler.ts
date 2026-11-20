/**
 * Slow-call sampler: where the loop thread sat during one slow SQLite call or
 * child start, from the OS (macOS `sample`), not from JavaScript.
 *
 * The blocking-call ledger (blocking-calls.ts) names the call that held the
 * loop, and its wait sample says the thread was off the CPU: on the Mac a
 * one-row session INSERT that costs 0.03 ms took 0.3 to 2.5 s, 33 times in 3 h,
 * with 38 ms of CPU among them all (2026-11-19). Neither says what the thread
 * waited on inside the call: a file lock, a disk read, a mutex another thread
 * holds. While the loop thread is stuck it can run nothing, so a watcher thread
 * reads the ledger's shared "call running now" stamp every 50 ms (on its own loop, so the main thread being stuck does not stop it); once one call
 * has run SAMPLE_AFTER_MS it runs `sample <pid> 0.5` (at most once per
 * SAMPLE_GAP_MS and SAMPLE_MAX times per boot), which stops the process for a moment per sample and writes
 * every thread's stack, the system library frames named (libsqlite3,
 * libsystem_kernel). The loop logs `loop thread sampled in a slow call` with
 * the main thread's leaf frames and the ledger's call when it turns again.
 * Files: <log dir>/stall-samples/sample-*.txt, the newest SAMPLE_KEEP kept.
 * macOS only; WALNUT_STALL_SAMPLE=0 turns it off.
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { LOG_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import { blockingCallsWithin, currentCallBuffer } from './blocking-calls.js';

/** A call running this long is sampled (ms). */
export const SAMPLE_AFTER_MS = 250;
/** At most one sample in this long (ms): each stops the process for a moment per stack it takes. */
export const SAMPLE_GAP_MS = 10 * 60_000;
/** At most this many samples in one server's life: past it the watcher only counts. */
export const SAMPLE_MAX = 12;
const SAMPLE_SECONDS = 0.5;
const SAMPLE_KEEP = 30;

export interface SampleFrame { frame: string; n: number; sqlite?: string }

/**
 * The main thread's leaf frames in a macOS `sample` report, heaviest first:
 * where it was when each stack was taken, with the nearest libsqlite3 frame
 * above it (the statement step that led there).
 */
export function parseSampleMainThread(text: string, top = 6): SampleFrame[] {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => /\bThread_\d+\b.*com\.apple\.main-thread/.test(l));
  if (i < 0) return [];
  const headerDepth = (/^\s*/.exec(lines[i]) ?? [''])[0].length;
  const frames: Array<{ depth: number; n: number; fn: string; lib: string }> = [];
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    if (/^\s*\d+\s+Thread_\d+/.test(line) && (/^\s*/.exec(line) ?? [''])[0].length <= headerDepth) break;
    const m = /^([\s+!:|]*)(\d+)\s+(.+?)\s+\(in ([^)]+)\)/.exec(line);
    if (m) frames.push({ depth: m[1].length, n: Number(m[2]), fn: m[3].trim(), lib: m[4].trim() });
  }
  const leaves = new Map<string, SampleFrame>();
  const chain: Array<{ depth: number; fn: string; lib: string }> = [];
  frames.forEach((f, k) => {
    while (chain.length && chain[chain.length - 1].depth >= f.depth) chain.pop();
    chain.push(f);
    const next = frames[k + 1];
    if (next && next.depth > f.depth) return;
    const key = `${f.fn} (${f.lib})`;
    const sqlite = [...chain].reverse().find((p) => /libsqlite3/.test(p.lib) && p !== f)?.fn;
    const got = leaves.get(key) ?? { frame: key, n: 0, ...(sqlite ? { sqlite } : {}) };
    got.n += f.n;
    leaves.set(key, got);
  });
  // A leaf under a SQLite frame is the call's own wait: those first, then the rest (the loop's idle kevent after it).
  return [...leaves.values()].sort((a, b) => Number(!!b.sqlite) - Number(!!a.sqlite) || b.n - a.n).slice(0, top);
}

/**
 * The watcher thread's body; runs in a Worker built from its source, so it
 * imports nothing and reaches the built-in modules through
 * process.getBuiltinModule (a bundler rewrites a `require` it sees).
 */
function watchThread(parse: (text: string) => unknown): void {
  const get = (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule;
  const { workerData: w, parentPort } = get('worker_threads');
  const { execFile } = get('child_process');
  const fs = get('fs');
  const nodePath = get('path');
  const now = new Float64Array(w.buffer);
  let seen = 0;
  let last = -Infinity;
  let taken = 0;
  let sampling = false;
  setInterval(() => {
    const start = now[0];
    const perfStart = now[2];
    if (sampling || !start || start === seen || Date.now() - start < w.afterMs) return;
    seen = start;
    const kind = now[1] === 2 ? 'spawn' : 'sqlite';
    if (taken >= w.max || Date.now() - last < w.gapMs) {
      parentPort.postMessage({ skipped: taken >= w.max ? 'max' : 'gap', kind });
      return;
    }
    taken += 1;
    last = Date.now();
    sampling = true;
    const heldMs = Date.now() - start;
    const done = (file: string | null, error?: string) => {
      let top: unknown = [];
      try {
        if (file && !error) top = parse(fs.readFileSync(file, 'utf8'));
        const kept = (fs.readdirSync(w.dir) as string[]).filter((f) => f.startsWith('sample-')).sort();
        for (const f of kept.slice(0, Math.max(0, kept.length - w.keep))) fs.rmSync(nodePath.join(w.dir, f), { force: true });
      } catch (e) {
        error ??= String((e as Error)?.message ?? e);
      }
      sampling = false;
      parentPort.postMessage({ perfStart, kind, heldMs, file, top, error });
    };
    try {
      fs.mkdirSync(w.dir, { recursive: true });
      const file = nodePath.join(w.dir, `sample-${new Date().toISOString().replace(/[:.]/g, '')}-${w.pid}.txt`);
      execFile(w.bin, [String(w.pid), String(w.seconds), '-mayDie', '-file', file], { timeout: (w.seconds + 15) * 1000 },
        (err: Error | null) => done(file, err ? String(err.message ?? err) : undefined));
    } catch (e) {
      done(null, String((e as Error)?.message ?? e));
    }
  }, 50);
}

let watcher: Worker | null = null;
let watcherOnline: Promise<void> = Promise.resolve();
const skipped = { gap: 0, max: 0 };
/** Slow calls the watcher saw but did not sample (the gap or the per-boot cap). */
export function slowCallSamplerSkips(): Readonly<typeof skipped> { return { ...skipped }; }

export interface SlowCallSamplerOptions {
  dir?: string;
  afterMs?: number;
  gapMs?: number;
  /** The sampler program (tests pass a stand-in). */
  bin?: string;
  platform?: NodeJS.Platform;
  max?: number;
}

/**
 * Start the watcher thread (idempotent). Returns false where `sample` is not
 * there (any OS but macOS). The ledger must be installed for calls to be seen.
 */
export function startSlowCallSampler(options: SlowCallSamplerOptions = {}): boolean {
  if (watcher) return true;
  if ((options.platform ?? process.platform) !== 'darwin') return false;
  const source = `const parse = ${parseSampleMainThread.toString()};\n(${watchThread.toString()})(parse);`;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      buffer: currentCallBuffer(), pid: process.pid, dir: options.dir ?? path.join(LOG_DIR, 'stall-samples'),
      afterMs: options.afterMs ?? SAMPLE_AFTER_MS, gapMs: options.gapMs ?? SAMPLE_GAP_MS,
      seconds: SAMPLE_SECONDS, keep: SAMPLE_KEEP, bin: options.bin ?? '/usr/bin/sample', max: options.max ?? SAMPLE_MAX,
    },
  });
  worker.unref();
  watcherOnline = new Promise<void>((resolve) => { worker.once('online', () => resolve()); worker.once('error', () => resolve()); });
  worker.on('message', (m: { skipped?: 'gap' | 'max'; perfStart: number; kind: string; heldMs: number; file: string | null; top: SampleFrame[]; error?: string }) => {
    if (m.skipped) { skipped[m.skipped] += 1; return; }
    // The call that began at the stamped start (the ring keeps the same performance clock), the outer one first.
    const call = blockingCallsWithin(m.perfStart, m.perfStart + 0.5, 8)?.calls.sort((a, b) => b.maxMs - a.maxMs)[0];
    log.web.warn('loop thread sampled in a slow call', {
      kind: m.kind, heldMsAtSample: m.heldMs,
      ...(call ? { call: call.what, callMs: call.maxMs, ...(call.site ? { site: call.site } : {}), ...(call.wait ? { wait: call.wait } : {}) } : {}),
      top: m.top, file: m.file, ...(m.error ? { error: m.error } : {}),
    });
  });
  worker.on('error', (err) => log.web.warn('the stack sampler stopped', { error: String(err) }));
  watcher = worker;
  return true;
}

/** Resolves once the watcher thread runs (tests: a call made before it is not seen). */
export function slowCallSamplerOnline(): Promise<void> { return watcherOnline; }

/** Tests: stop the watcher thread. */
export async function _stopSlowCallSamplerForTesting(): Promise<void> {
  const w = watcher;
  watcher = null;
  watcherOnline = Promise.resolve();
  skipped.gap = 0;
  skipped.max = 0;
  if (w) await w.terminate();
}
