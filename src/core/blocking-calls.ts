/**
 * Blocking-call ledger: the synchronous calls that held the loop thread, so a
 * probe-late line (event-loop-monitor.ts) names what ran in its hold.
 *
 * The probe says THAT the loop was held; the stall recorder keeps a CPU profile
 * only for long holds. A hold of 0.3 to 1.5 s left nothing that named code
 * (2026-11-18 19:14: four holds of 279 to 632 ms in 15 s, every request about
 * 1.5 s slow, no profile). The kept profiles of longer holds said where the
 * thread sat: a synchronous SQLite write (3 of 5 holds, 2.1 to 2.4 s in one
 * INSERT), child_process spawn (6 to 21%), a synchronous module load.
 *
 * Two kinds of call are timed at their one choke point each:
 *  - `sqlite`: every statement and transaction through src/lib/sqlite.ts
 *    (the observer installed by installBlockingCallTiming);
 *  - `spawn`: the synchronous part of every asynchronous child process start
 *    (ChildProcess.prototype.spawn, which spawn, execFile, exec and fork all go
 *    through). Not timed: spawnSync, execSync, execFileSync and Bun.spawn,
 *    which do not pass there; a hold in one of those shows in the CPU profile.
 * A call of BLOCKING_MIN_MS or more goes into a ring; one of SITE_MIN_MS or
 * more also keeps its caller (the stack at its end is still the caller's).
 * Cost per call: two performance.now() reads (about 25 ns each); a write also
 * reads its thread CPU and the process context switches (about 1.3 us).
 */

import childProcess from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setSqliteCallObserver } from '../lib/sqlite.js';
import { log } from '../logging/index.js';

/** Calls shorter than this are not kept (ms). */
export const BLOCKING_MIN_MS = 20;
/** Calls this long or longer also keep their caller (ms). */
export const SITE_MIN_MS = 100;
const RING_SIZE = 512;
let minMs = BLOCKING_MIN_MS;
let siteMs = SITE_MIN_MS;

export type BlockingKind = 'sqlite' | 'spawn';

interface Entry {
  kind: BlockingKind;
  what: string;
  site: string | null;
  /** performance.now() at the call's start. */
  start: number;
  ms: number;
  /** Sampled for writes: this thread's CPU in the call, and the process's context switches in it. */
  wait?: CallWait;
}

/**
 * What a slow write spent its time on. `cpuMs` far under its wall time means
 * the thread was off the CPU: waiting in the call (`voluntary` switches: a
 * lock's sleep, a disk read) or ready but not run (`involuntary`: the machine
 * was short of CPU). Counts are the whole process's, so other threads add some.
 */
export interface CallWait { cpuMs: number; voluntary: number; involuntary: number }

const ring: Array<Entry | undefined> = new Array(RING_SIZE);
let nextSlot = 0;

/** The ledger's own frames and the wrappers it times through, by function name
 *  (a compiled binary has one file, /$bunfs/root/walnut, so names are what tell them apart). */
const OWN_FRAMES = new Set(['noteTimed', 'timed', 'timedSpawn', 'each', 'guarded', 'transaction', 'run', 'get', 'all', 'exec', 'getNow', 'allNow',
  'spawn', 'execFile', 'fork', 'Promise', 'new Promise', 'ChildProcess']);
const OWN_FILES = /node:|bun:|\(native\)|\/lib\/sqlite(?:-guards)?\.[cm]?[jt]s|\/core\/blocking-calls\.[cm]?[jt]s/;

/**
 * The caller of a call that just ended, from the stack at its end: the first
 * three frames past the ledger's own and the wrappers (and the unnamed frames
 * right after them).
 */
export function callerSite(stack: string | undefined): string | null {
  if (!stack) return null;
  const frames: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const t = line.trim();
    if (!t.startsWith('at ')) continue;
    // "at fn (/path/file.ts:12:3)" | "at /path/file.ts:12:3" | "at fn (native)"
    const m = /^at (?:(.+?) \()?(.*?)(?::(\d+):\d+)?\)?$/.exec(t);
    const fn = m?.[1]?.replace(/^(?:async |Object\.|SqliteStatement\.|SqliteDatabase\.)/, '') ?? '';
    const where = m?.[2] ?? t.slice(3);
    if (OWN_FILES.test(t)) continue;
    if (frames.length === 0 && (fn === '' || fn === '<anonymous>' || OWN_FRAMES.has(fn))) continue;
    const file = where.split('/').pop() ?? where;
    const at = m?.[3] ? `${file}:${m[3]}` : file;
    frames.push(fn && fn !== '<anonymous>' ? `${fn} ${at}` : at);
    if (frames.length >= 3) break;
  }
  return frames.length > 0 ? frames.join(' < ') : null;
}

/** Record one call that ran synchronously on this thread. */
export function noteBlockingCall(kind: BlockingKind, what: string, start: number, ms: number, site: string | null = null, wait?: CallWait): void {
  if (ms < minMs) return;
  ring[nextSlot] = { kind, what, site, start, ms, ...(wait ? { wait } : {}) };
  nextSlot = (nextSlot + 1) % RING_SIZE;
}

export interface BlockingSummary {
  /** Time the recorded calls held the thread inside the span (ms; overlapping calls count once). */
  ms: number;
  /** The heaviest calls, grouped by kind, statement or command, and caller. */
  calls: Array<{ kind: BlockingKind; what: string; site?: string; n: number; ms: number; maxMs: number; wait?: CallWait }>;
}

/**
 * The recorded calls that overlap [fromPerf, toPerf] (performance.now() times),
 * grouped and heaviest first; null when none did.
 */
export function blockingCallsWithin(fromPerf: number, toPerf: number, top = 5): BlockingSummary | null {
  const groups = new Map<string, { kind: BlockingKind; what: string; site: string | null; n: number; ms: number; maxMs: number; wait?: CallWait }>();
  const spans: Array<[number, number]> = [];
  for (const e of ring) {
    if (!e) continue;
    const end = e.start + e.ms;
    if (end < fromPerf || e.start > toPerf) continue;
    const from = Math.max(e.start, fromPerf);
    const to = Math.min(end, toPerf);
    const inSpan = to - from;
    if (inSpan <= 0) continue;
    spans.push([from, to]);
    const key = `${e.kind}\u0000${e.what}\u0000${e.site ?? ''}`;
    const g = groups.get(key) ?? { kind: e.kind, what: e.what, site: e.site, n: 0, ms: 0, maxMs: 0 };
    g.n += 1;
    g.ms += inSpan;
    if (e.ms > g.maxMs) g.maxMs = e.ms;
    if (e.wait) {
      const w = g.wait ?? { cpuMs: 0, voluntary: 0, involuntary: 0 };
      w.cpuMs += e.wait.cpuMs; w.voluntary += e.wait.voluntary; w.involuntary += e.wait.involuntary;
      g.wait = w;
    }
    groups.set(key, g);
  }
  if (groups.size === 0) return null;
  // A transaction holds its own statements: the total counts held time once.
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curFrom = spans[0][0];
  let curTo = spans[0][1];
  for (const [from, to] of spans.slice(1)) {
    if (from <= curTo) { if (to > curTo) curTo = to; continue; }
    total += curTo - curFrom;
    curFrom = from;
    curTo = to;
  }
  total += curTo - curFrom;
  const calls = [...groups.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, top)
    .map((g) => ({
      kind: g.kind, what: g.what, ...(g.site ? { site: g.site } : {}), n: g.n, ms: Math.round(g.ms), maxMs: Math.round(g.maxMs),
      ...(g.wait ? { wait: { ...g.wait, cpuMs: Math.round(g.wait.cpuMs) } } : {}),
    }));
  return { ms: Math.round(total), calls };
}

/** One line of SQL, short enough for a log field. */
export function sqlLabel(source: string): string {
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

function noteTimed(kind: BlockingKind, what: () => string, start: number, before?: Sample | null): CallWait | undefined {
  const ms = performance.now() - start;
  if (ms < minMs) return undefined;
  const wait = before ? waitSince(before) : undefined;
  noteBlockingCall(kind, what(), start, ms, ms >= siteMs ? callerSite(new Error().stack) : null, wait);
  return wait;
}

interface Sample { cpuUs: number; voluntary: number; involuntary: number }
interface Token { start: number; before: Sample | null }

function sampleNow(): Sample | null {
  try {
    const cpu = process.threadCpuUsage();
    const ru = process.resourceUsage();
    return { cpuUs: cpu.user + cpu.system, voluntary: ru.voluntaryContextSwitches, involuntary: ru.involuntaryContextSwitches };
  } catch {
    return null;
  }
}

function waitSince(before: Sample): CallWait | undefined {
  const now = sampleNow();
  if (!now) return undefined;
  return { cpuMs: (now.cpuUs - before.cpuUs) / 1000, voluntary: now.voluntary - before.voluntary, involuntary: now.involuntary - before.involuntary };
}

/**
 * A write that waited this long, with its thread mostly off the CPU, looks for
 * the other processes that have the database open: one holding the write lock
 * keeps this thread in SQLite's busy wait. At most once a minute.
 */
const HOLDERS_MIN_MS = 100;
const HOLDERS_GAP_MS = 60_000;
let lastHoldersAt = 0;

function lookForHolders(file: string, what: string, ms: number, wait: CallWait): void {
  if (process.platform === 'win32' || file === ':memory:' || file === '') return;
  const now = Date.now();
  if (now - lastHoldersAt < HOLDERS_GAP_MS) return;
  lastHoldersAt = now;
  childProcess.execFile('lsof', ['-F', 'pc', '--', file, `${file}-wal`], { timeout: 5_000 }, (_err, stdout) => {
    const others: string[] = [];
    let pid = '';
    for (const line of String(stdout ?? '').split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1);
      else if (line.startsWith('c') && pid && pid !== String(process.pid)) others.push(`${pid} ${line.slice(1)}`);
    }
    log.web.warn('sqlite: slow write, the processes that had the database open', {
      file: path.basename(file), what: sqlLabel(what), ms: Math.round(ms), wait, others: [...new Set(others)],
    });
  });
}

let installed = false;
let originalSpawn: ((...args: unknown[]) => unknown) | null = null;

/**
 * Time SQLite calls and child process starts on this thread (idempotent). The
 * server calls this at boot next to the event-loop monitor.
 */
export function installBlockingCallTiming(): void {
  if (installed) return;
  installed = true;
  setSqliteCallObserver({
    begin: (writes): Token => ({ start: performance.now(), before: writes ? sampleNow() : null }),
    end: (source, token, _writes, file) => {
      const t = token as Token;
      const wait = noteTimed('sqlite', () => sqlLabel(source), t.start, t.before);
      const ms = performance.now() - t.start;
      if (wait && ms >= HOLDERS_MIN_MS && wait.cpuMs < ms / 4) lookForHolders(file, source, ms, wait);
    },
  });
  const proto = (childProcess as unknown as { ChildProcess?: { prototype: Record<string, unknown> } }).ChildProcess?.prototype;
  const spawn = proto?.spawn;
  if (proto && typeof spawn === 'function') {
    originalSpawn = spawn as (...args: unknown[]) => unknown;
    const orig = originalSpawn;
    proto.spawn = function timedSpawn(this: unknown, ...args: unknown[]): unknown {
      const start = performance.now();
      const before = sampleNow();
      try {
        return orig.apply(this, args);
      } finally {
        try { noteTimed('spawn', () => spawnLabel(args[0]), start, before); } catch { /* timing never changes the start */ }
      }
    };
  }
}

function spawnLabel(options: unknown): string {
  const o = options as { file?: unknown; args?: unknown } | undefined;
  const file = typeof o?.file === 'string' ? o.file : '?';
  const args = Array.isArray(o?.args) ? (o.args as unknown[]).slice(1, 4).map(String) : [];
  const label = [file.split('/').pop() ?? file, ...args].join(' ');
  return label.length > 90 ? `${label.slice(0, 90)}…` : label;
}

/** Tests: keep shorter calls (a child start takes a few ms on an idle machine). */
export function _setBlockingThresholdsForTesting(next: { minMs: number; siteMs: number } | null): void {
  minMs = next?.minMs ?? BLOCKING_MIN_MS;
  siteMs = next?.siteMs ?? SITE_MIN_MS;
}

/** Tests: undo installBlockingCallTiming and empty the ring. */
export function _resetBlockingCallsForTesting(): void {
  ring.fill(undefined);
  nextSlot = 0;
  lastHoldersAt = 0;
  if (installed) {
    setSqliteCallObserver(null);
    const proto = (childProcess as unknown as { ChildProcess?: { prototype: Record<string, unknown> } }).ChildProcess?.prototype;
    if (proto && originalSpawn) proto.spawn = originalSpawn;
  }
  originalSpawn = null;
  installed = false;
  _setBlockingThresholdsForTesting(null);
}
