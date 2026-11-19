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
 *  - `spawn`: the synchronous part of every child process start
 *    (ChildProcess.prototype.spawn, which spawn, execFile, exec and fork all go through).
 * A call of BLOCKING_MIN_MS or more goes into a ring; one of SITE_MIN_MS or
 * more also keeps its caller (the stack at its end is still the caller's).
 * Cost per call: two performance.now() reads (about 25 ns each).
 */

import childProcess from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setSqliteCallObserver } from '../lib/sqlite.js';

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
}

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
export function noteBlockingCall(kind: BlockingKind, what: string, start: number, ms: number, site: string | null = null): void {
  if (ms < minMs) return;
  ring[nextSlot] = { kind, what, site, start, ms };
  nextSlot = (nextSlot + 1) % RING_SIZE;
}

export interface BlockingSummary {
  /** Time the recorded calls held the thread inside the span (ms; overlapping calls count once). */
  ms: number;
  /** The heaviest calls, grouped by kind, statement or command, and caller. */
  calls: Array<{ kind: BlockingKind; what: string; site?: string; n: number; ms: number; maxMs: number }>;
}

/**
 * The recorded calls that overlap [fromPerf, toPerf] (performance.now() times),
 * grouped and heaviest first; null when none did.
 */
export function blockingCallsWithin(fromPerf: number, toPerf: number, top = 5): BlockingSummary | null {
  const groups = new Map<string, { kind: BlockingKind; what: string; site: string | null; n: number; ms: number; maxMs: number }>();
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
    .map((g) => ({ kind: g.kind, what: g.what, ...(g.site ? { site: g.site } : {}), n: g.n, ms: Math.round(g.ms), maxMs: Math.round(g.maxMs) }));
  return { ms: Math.round(total), calls };
}

/** One line of SQL, short enough for a log field. */
export function sqlLabel(source: string): string {
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

function noteTimed(kind: BlockingKind, what: () => string, start: number): void {
  const ms = performance.now() - start;
  if (ms < minMs) return;
  noteBlockingCall(kind, what(), start, ms, ms >= siteMs ? callerSite(new Error().stack) : null);
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
  setSqliteCallObserver((source, start) => { noteTimed('sqlite', () => sqlLabel(source), start); });
  const proto = (childProcess as unknown as { ChildProcess?: { prototype: Record<string, unknown> } }).ChildProcess?.prototype;
  const spawn = proto?.spawn;
  if (proto && typeof spawn === 'function') {
    originalSpawn = spawn as (...args: unknown[]) => unknown;
    const orig = originalSpawn;
    proto.spawn = function timedSpawn(this: unknown, ...args: unknown[]): unknown {
      const start = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        noteTimed('spawn', () => spawnLabel(args[0]), start);
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
  if (installed) {
    setSqliteCallObserver(null);
    const proto = (childProcess as unknown as { ChildProcess?: { prototype: Record<string, unknown> } }).ChildProcess?.prototype;
    if (proto && originalSpawn) proto.spawn = originalSpawn;
  }
  originalSpawn = null;
  installed = false;
  _setBlockingThresholdsForTesting(null);
}
