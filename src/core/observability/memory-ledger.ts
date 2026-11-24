/**
 * Memory ledger: what the server process holds, by holder, against a budget.
 *
 * Why this exists (2026-11-20): the live server sat at 3 to 4 GB RSS minutes after a
 * restart while a heap snapshot of the same data showed about 340 MB of live objects.
 * Nothing said which cache held what, so every memory question started with a heap dump
 * of a copy. Each in-memory cache that can grow with the user's data registers here with
 * a budget; the health tick logs one `memory sample` line every SAMPLE_EVERY_MS (process,
 * JS engine, every holder) and a warn when a holder is over its budget, and
 * GET /api/system/memory answers the same report on demand.
 *
 * A holder's read() must be cheap (a counter the cache already keeps, or one pass over a
 * few thousand rows): it runs on the event loop at every sample.
 */

import path from 'node:path';
import { log } from '../../logging/index.js';
import { LOG_DIR } from '../../constants.js';
import { physFootprintMb } from './footprint.js';

export interface MemoryHolderReading {
  /** Entries held (rows, sessions, nodes). */
  entries: number;
  /** JS string characters held; counted as 2 bytes each (a string with any non-Latin-1 character is UTF-16). */
  chars?: number;
  /** Bytes held, when the holder knows them directly (buffers). */
  bytes?: number;
}

export interface MemoryHolder {
  /** Stable name: `<module>.<cache>`. */
  name: string;
  /** Most this holder should ever hold, in bytes (estimated as above). Over it is a bug. */
  budgetBytes: number;
  read(): MemoryHolderReading;
}

export interface MemoryHolderRow {
  name: string;
  entries: number;
  bytes: number;
  budgetBytes: number;
  overBudget: boolean;
}

const holders = new Map<string, MemoryHolder>();

/** Register (or replace, by name) a holder. Returns its unregister. */
export function registerMemoryHolder(holder: MemoryHolder): () => void {
  holders.set(holder.name, holder);
  return () => { if (holders.get(holder.name) === holder) holders.delete(holder.name); };
}

export function memoryHolderNames(): string[] {
  return [...holders.keys()].sort();
}

/**
 * Characters of every string reachable from `value` (arrays and plain objects, `depth`
 * levels down): an estimate of a record cache's text, one pass, no allocation.
 */
export function stringCharsOf(value: unknown, depth = 4): number {
  if (typeof value === 'string') return value.length;
  if (depth <= 0 || value === null || typeof value !== 'object') return 0;
  let n = 0;
  if (Array.isArray(value)) {
    for (const v of value) n += stringCharsOf(v, depth - 1);
    return n;
  }
  for (const k in value as Record<string, unknown>) {
    n += k.length + stringCharsOf((value as Record<string, unknown>)[k], depth - 1);
  }
  return n;
}

/**
 * stringCharsOf over every `step`-th row, scaled back up: a record cache of thousands of rows is
 * estimated in a fraction of a full walk (the sample runs on the event loop every 10 min).
 */
export function sampledStringChars(rows: readonly unknown[] | null | undefined, step = 8): number {
  if (!rows || rows.length === 0) return 0;
  if (rows.length <= step * 4) return stringCharsOf(rows as unknown[]);
  let n = 0;
  let seen = 0;
  for (let i = 0; i < rows.length; i += step) { n += stringCharsOf(rows[i], 3); seen++; }
  return Math.round((n / seen) * rows.length);
}

function bytesOf(r: MemoryHolderReading): number {
  return Math.round(r.bytes ?? (r.chars ?? 0) * 2);
}

/** Every holder's reading, biggest first. A holder whose read throws reads as empty. */
export function readMemoryHolders(): MemoryHolderRow[] {
  const rows: MemoryHolderRow[] = [];
  for (const h of holders.values()) {
    let r: MemoryHolderReading = { entries: 0 };
    try { r = h.read(); } catch { /* a holder mid-reset: count it as empty this time */ }
    const bytes = bytesOf(r);
    rows.push({ name: h.name, entries: r.entries, bytes, budgetBytes: h.budgetBytes, overBudget: bytes > h.budgetBytes });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

const MB = 1048576;
const mb = (n: number | undefined): number | undefined => (n === undefined ? undefined : Math.round(n / MB));

export interface ProcessMemoryMb {
  rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number;
  /** The physical footprint (Activity Monitor's Memory), where it can be read (macOS). */
  footprintMb?: number;
}

/** This process's memory in whole MB: the one place every report and log line reads it. */
export function processMemoryMb(): ProcessMemoryMb {
  const m = process.memoryUsage();
  const footprintMb = physFootprintMb();
  return {
    rssMb: mb(m.rss)!, heapUsedMb: mb(m.heapUsed)!, heapTotalMb: mb(m.heapTotal)!,
    externalMb: mb(m.external)!, arrayBuffersMb: mb(m.arrayBuffers)!,
    ...(footprintMb !== null ? { footprintMb } : {}),
  };
}

/**
 * The reading the collection asks and the burst lines go by: the footprint where it can be read,
 * else RSS. On macOS RSS also counts pages the allocator already freed (footprint.ts): a nudge or
 * a burst line on those collects nothing and names nothing.
 */
export function memoryReadingMb(): number {
  return physFootprintMb() ?? rssOnlyMb();
}

interface JscModule {
  heapStats(): { heapSize: number; heapCapacity: number; extraMemorySize: number; objectCount: number; objectTypeCounts: Record<string, number> };
  memoryUsage(): { current: number; peak: number; currentCommit: number; peakCommit: number };
}
let jsc: JscModule | null | undefined;
async function loadJsc(): Promise<JscModule | null> {
  if (jsc !== undefined) return jsc;
  try {
    // Bun only; under Node (some tests) there is no such module.
    jsc = (await import('bun:jsc' as string)) as unknown as JscModule;
  } catch {
    jsc = null;
  }
  return jsc;
}

export interface MemoryReport {
  uptimeSec: number;
  process: ProcessMemoryMb;
  /** The JS engine's allocator (Bun): what it holds now and its high-water mark. */
  engine?: { currentMb: number; peakMb: number; currentCommitMb: number; peakCommitMb: number };
  /** Only with `heap: true`: walks the whole heap (tens of ms per million objects). */
  heap?: { liveMb: number; capacityMb: number; extraMb: number; objects: number; topTypes: Array<[string, number]> };
  /** Set when `heap` was asked for but not walked (one walk a minute, one at a time). */
  heapSkipped?: string;
  holders: Array<MemoryHolderRow & { mb: number; budgetMb: number }>;
  holdersMb: number;
}

/** The report GET /api/system/memory answers. */
export async function memoryReport(opts: { heap?: boolean } = {}, now = Date.now()): Promise<MemoryReport> {
  const rows = readMemoryHolders();
  const report: MemoryReport = {
    uptimeSec: Math.round(process.uptime()),
    process: processMemoryMb(),
    holders: rows.map((r) => ({ ...r, mb: Math.round((r.bytes / MB) * 10) / 10, budgetMb: Math.round(r.budgetBytes / MB) })),
    holdersMb: Math.round(rows.reduce((n, r) => n + r.bytes, 0) / MB),
  };
  const j = await loadJsc();
  if (j) {
    const u = j.memoryUsage();
    report.engine = { currentMb: mb(u.current)!, peakMb: mb(u.peak)!, currentCommitMb: mb(u.currentCommit)!, peakCommitMb: mb(u.peakCommit)! };
    if (opts.heap && now - lastHeapWalkAt < HEAP_WALK_EVERY_MS) {
      report.heapSkipped = `the heap was walked ${Math.round((now - lastHeapWalkAt) / 1000)} s ago; one walk a minute`;
    } else if (opts.heap) {
      lastHeapWalkAt = now;
      const h = j.heapStats();
      report.heap = {
        liveMb: mb(h.heapSize)!, capacityMb: mb(h.heapCapacity)!, extraMb: mb(h.extraMemorySize)!, objects: h.objectCount,
        topTypes: Object.entries(h.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 20),
      };
    }
  }
  return report;
}

/** heapStats() walks every object on the event loop (about 50 ms per million): at most one a minute. */
const HEAP_WALK_EVERY_MS = 60_000;
let lastHeapWalkAt = -Infinity;

const sampleNotes = new Map<string, () => string>();
/** A short note a module adds to every `memory sample` line (what it moved lately). Returns its unregister. */
export function registerSampleNote(name: string, read: () => string): () => void {
  sampleNotes.set(name, read);
  return () => { if (sampleNotes.get(name) === read) sampleNotes.delete(name); };
}

/**
 * Who copies a whole store: one call in `every` notes the functions that asked (the stack frames
 * above the copy), and the most frequent ride every `memory sample` line as `<name>By`, scaled back
 * to calls. 2026-11-24: the session store handed out 12.4M copied rows in 21 minutes (about 1,650
 * copies of the whole table) and nothing said which readers asked. Returns the note to call per copy.
 */
export function copyCallerCounter(name: string, every = 32, frames = 3): () => void {
  const counts = new Map<string, number>();
  let seq = 0;
  registerSampleNote(`${name}By`, () => [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v * every}`).join(' '));
  return () => {
    if (++seq % every !== 0) return;
    // Frame 0 is "Error", 1 this note, 2 the copying function: the callers start at 3.
    const names = (new Error().stack ?? '').split('\n').slice(3, 3 + frames)
      .map((l) => /^\s*at (?:async )?([\w$.<>]+) \(/.exec(l)?.[1] ?? '?');
    const key = names.join('<');
    if (!counts.has(key) && counts.size >= 100) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
}

/** How often the health tick logs a sample. */
export const SAMPLE_EVERY_MS = 10 * 60_000;
/** A holder over budget re-warns at most this often. */
const OVER_BUDGET_REWARN_MS = 60 * 60_000;
let lastSampleAt = 0;
const overWarnedAt = new Map<string, number>();

/**
 * Health-monitor tick hook (every 30 s): one `memory sample` line per SAMPLE_EVERY_MS,
 * and a warn for each holder over its budget (once an hour while it stays over).
 */
export function sampleMemory(now = Date.now()): void {
  if (now - lastSampleAt < SAMPLE_EVERY_MS) return;
  lastSampleAt = now;
  const rows = readMemoryHolders();
  log.obs.info('memory sample', {
    ...processMemoryMb(),
    uptimeSec: Math.round(process.uptime()),
    holdersMb: Math.round(rows.reduce((n, r) => n + r.bytes, 0) / MB),
    top: rows.slice(0, 8).map((r) => `${r.name}=${Math.round(r.bytes / MB)}MB/${r.entries}`).join(' '),
    ...Object.fromEntries([...sampleNotes].map(([name, read]) => {
      try { return [name, read()]; } catch { return [name, 'unreadable']; }
    })),
  });
  for (const r of rows) {
    if (!r.overBudget) { overWarnedAt.delete(r.name); continue; }
    const last = overWarnedAt.get(r.name) ?? 0;
    if (now - last < OVER_BUDGET_REWARN_MS) continue;
    overWarnedAt.set(r.name, now);
    log.obs.warn('memory holder over budget', { holder: r.name, mb: Math.round(r.bytes / MB), budgetMb: Math.round(r.budgetBytes / MB), entries: r.entries });
  }
}

// ── A collection when the process is big ─────────────────────────────────
//
// Most of what the live server holds at its peaks is garbage the engine has not
// collected yet: big list answers, voice drafts (up to 4 MB of base64 each), history
// tails. On a copy of the maintainer's data RSS stayed at 1.3 GB for 80 s after a burst
// of list calls and fell to 0.85 GB once a collection ran (2026-11-20). The engine sizes
// its next collection from the machine's RAM, so on a 48 GB Mac it waits long. When RSS
// is over GC_NUDGE_RSS_MB, the health tick asks for a collection, at most every
// GC_NUDGE_EVERY_MS. Bun.gc(false) asks for it asynchronously: the marking runs beside
// the event loop, never a synchronous full stop. WALNUT_GC_NUDGE=0 turns it off.
//
// A footprint still climbing a gigabyte past the last nudge's reading is asked again at the
// next tick, without waiting out the interval (2026-11-23: a nudge at 3.4 GB, then 8.0 GB
// half a minute later and 11.3 GB at the next allowed nudge three minutes on, 12.8 GB at the
// peak; back to 4.2 GB once the work eased).
export const GC_NUDGE_RSS_MB = 1536;
export const GC_NUDGE_EVERY_MS = 3 * 60_000;
// 2026-11-24, after the caches that cut the steady footprint to 1.3 to 2.3 GB: the bursts left
// still climbed 2 to 3 GB in 4 to 6 s (2.3 to 5.0 GB, 13:53), and one ask brought each back to
// about 2.2 GB, so the ask comes at half a gigabyte of rise and may come again after 5 s.
export const GC_NUDGE_RISE_MB = 512;
/** The fast probe asks again at most this often. */
export const GC_NUDGE_MIN_GAP_MS = 5_000;
let lastNudgeAt = -Infinity;
/** The lowest reading since the last ask (or since start): a rise is measured from here. */
let troughMb = Infinity;
let nudgedFromMb: number | null = null;

type GcFn = (sync: boolean) => void;
function bunGc(): GcFn | null {
  const b = (globalThis as { Bun?: { gc?: GcFn } }).Bun;
  return typeof b?.gc === 'function' ? b.gc.bind(b) : null;
}

/**
 * Health-tick hook (every 30 s): ask the engine for a collection when the process is
 * over GC_NUDGE_RSS_MB, and log what the last one gave back at the next tick.
 */
export function nudgeGcUnderPressure(now = Date.now(), gc: GcFn | null = bunGc(), rssMb = memoryReadingMb()): void {
  if (process.env.WALNUT_GC_NUDGE === '0' || !gc) return;
  settleNudge(rssMb);
  troughMb = Math.min(troughMb, rssMb);
  if (rssMb < GC_NUDGE_RSS_MB) return;
  if (now - lastNudgeAt < GC_NUDGE_EVERY_MS && rssMb - troughMb < GC_NUDGE_RISE_MB) return;
  askGc(now, gc, rssMb, 'tick');
}

/**
 * Fast-probe hook (every BURST_PROBE_EVERY_MS): ask for a collection as soon as the footprint is
 * GC_NUDGE_RISE_MB over its lowest reading since the last ask, at most every GC_NUDGE_MIN_GAP_MS.
 * The engine lets garbage reach about twice the live heap before it collects on its own: a heap
 * snapshot of the live server at 3.9 GB (2026-11-23 19:48) held 0.9 GB reachable and 2.2 GB
 * unreachable, 2.0 GB of it strings; a burst climbs 1 to 2 GB in 4 s, so the 30 s tick asked
 * after the peak. On a 2 GB live heap a burst of parsing peaked at 4.2 to 4.6 GB without the
 * ask and 3.5 to 3.8 GB with it, at the same throughput.
 */
export function nudgeGcOnRise(now = Date.now(), gc: GcFn | null = bunGc(), rssMb = memoryReadingMb()): boolean {
  if (process.env.WALNUT_GC_NUDGE === '0' || !gc) return false;
  troughMb = Math.min(troughMb, rssMb);
  if (rssMb < GC_NUDGE_RSS_MB || rssMb - troughMb < GC_NUDGE_RISE_MB || now - lastNudgeAt < GC_NUDGE_MIN_GAP_MS) return false;
  settleNudge(rssMb);
  askGc(now, gc, rssMb, 'rise');
  return true;
}

function askGc(now: number, gc: GcFn, rssMb: number, via: 'tick' | 'rise'): void {
  lastNudgeAt = now;
  troughMb = rssMb;
  nudgedFromMb = rssMb;
  nudgedVia = via;
  gc(false);
}

let nudgedVia: 'tick' | 'rise' = 'tick';
/** Log what the last ask gave back, read at the next reading after it. */
function settleNudge(rssMb: number): void {
  if (nudgedFromMb === null) return;
  log.obs.info('memory gc nudge', { beforeMb: nudgedFromMb, afterMb: rssMb, freedMb: nudgedFromMb - rssMb, ...(nudgedVia === 'rise' ? { via: 'rise' } : {}) });
  nudgedFromMb = null;
}

// ── What was running when memory jumped ────────────────────────────────────
//
// The live server jumps from about 2 GB to 4 to 9 GB for a minute or so a few times an
// hour (2026-11-21: 9,007 MB at 09:38, back to 2.6 GB after a collection), with no stall,
// no big HTTP answer and nothing in the logs that lines up. The jump is garbage something
// built in a burst; what built it is whatever was in flight. Modules that run work which
// can allocate a lot register a context reader (requests in flight, daemon file reads in
// flight), and the health tick logs one `memory burst` line with all of them and the
// process and engine numbers when the footprint rose by BURST_RISE_MB over the lowest
// reading of the last BURST_WINDOW_MS. At most one line per BURST_EVERY_MS, except a new
// peak BURST_RISE_MB past the last line's reading, which is logged too: 2026-11-23 the line
// at 00:12 (3.1 GB) held off the climb to 12.8 GB at 00:27, and the peak named nothing.
// A peak past BURST_HEAP_WALK_MB also says what the heap holds by type (one walk, at most
// one an hour: a second or two of the loop at that size), so the line tells live objects
// from memory the allocator keeps.
export const BURST_RISE_MB = 1024;
export const BURST_WINDOW_MS = 3 * 60_000;
export const BURST_EVERY_MS = 15 * 60_000;
export const BURST_HEAP_WALK_MB = 6144;
export const BURST_HEAP_WALK_EVERY_MS = 60 * 60_000;

const burstContexts = new Map<string, () => unknown>();
/** Register what a module has in flight, read only when a burst is logged. Returns its unregister. */
export function registerBurstContext(name: string, read: () => unknown): () => void {
  burstContexts.set(name, read);
  return () => { if (burstContexts.get(name) === read) burstContexts.delete(name); };
}

const burstHooks = new Set<(b: { rssMb: number; riseMb: number }) => void>();
/** Called on each logged burst (the stall recorder keeps its CPU profile window). Returns its stop. */
export function onMemoryBurst(fn: (b: { rssMb: number; riseMb: number }) => void): () => void {
  burstHooks.add(fn);
  return () => { burstHooks.delete(fn); };
}

const recentRss: Array<{ at: number; rssMb: number }> = [];
let lastBurstAt = -Infinity;
let lastBurstRssMb = Infinity;
let lastBurstHeapWalkAt = -Infinity;
let lastBurstHeapWalkRssMb = Infinity;

/** Health-tick hook (every 30 s): log what was in flight when the footprint jumped. */
export async function watchMemoryBurst(now = Date.now(), rssMb = memoryReadingMb()): Promise<boolean> {
  while (recentRss.length > 0 && now - recentRss[0]!.at > BURST_WINDOW_MS) recentRss.shift();
  const low = recentRss.reduce((m, r) => Math.min(m, r.rssMb), rssMb);
  recentRss.push({ at: now, rssMb });
  if (rssMb - low < BURST_RISE_MB) return false;
  const newPeak = now - lastBurstAt < BURST_EVERY_MS;
  if (newPeak && rssMb - lastBurstRssMb < BURST_RISE_MB) return false;
  lastBurstAt = now;
  lastBurstRssMb = rssMb;
  const context: Record<string, unknown> = {};
  for (const [name, read] of burstContexts) {
    try { context[name] = read(); } catch (err) { context[name] = `unreadable: ${err instanceof Error ? err.message : String(err)}`; }
  }
  // The engine's own allocator counters are free; process numbers say strings (external) or
  // buffers. A heap walk stops the loop, so only a big peak takes one, at most once an hour.
  const j = await loadJsc();
  const u = j?.memoryUsage();
  let heap: { liveMb?: number; extraMb?: number; objects: number; topTypes: Array<[string, number]> } | undefined;
  // Inside the hour a peak twice the last walk's walks again: 2026-11-23 the walk at 6.7 GB
  // (22:14) held off the one at 15.7 GB (22:43), whose heap was the one that said something.
  if (j && rssMb >= BURST_HEAP_WALK_MB
    && (now - lastBurstHeapWalkAt >= BURST_HEAP_WALK_EVERY_MS || rssMb >= lastBurstHeapWalkRssMb * 2)) {
    lastBurstHeapWalkAt = now;
    lastBurstHeapWalkRssMb = rssMb;
    lastHeapWalkAt = now;
    const h = j.heapStats();
    heap = {
      liveMb: mb(h.heapSize), extraMb: mb(h.extraMemorySize), objects: h.objectCount,
      topTypes: Object.entries(h.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
  }
  log.obs.warn('memory burst', {
    // lowMb, riseMb and readingMb are the footprint where it can be read (memoryReadingMb).
    ...processMemoryMb(), readingMb: rssMb, lowMb: low, riseMb: rssMb - low, uptimeSec: Math.round(process.uptime()),
    ...(newPeak ? { newPeak: true } : {}),
    holdersMb: Math.round(readMemoryHolders().reduce((n, r) => n + r.bytes, 0) / MB),
    ...(u ? { engineMb: mb(u.current), engineCommitMb: mb(u.currentCommit) } : {}), ...(heap ? { heap } : {}), context,
  });
  for (const fn of burstHooks) { try { fn({ rssMb, riseMb: rssMb - low }); } catch { /* a hook never stops the line */ } }
  return true;
}

// The health tick runs every 30 s (longer when idle), so it saw the jump after its peak:
// 2026-11-23 17:09 the Mac's footprint went 0.9 to 5.8 GB and back to 3.8 GB in 30 s, and the
// tick's line read 3.2 GB with nothing left in flight. A probe reads RSS every
// BURST_PROBE_EVERY_MS (one cheap call) and runs the same check, so a rise is caught within
// seconds of crossing BURST_RISE_MB, with what was in flight then. WALNUT_MEMORY_PROBE=0 turns it off.
export const BURST_PROBE_EVERY_MS = 2_000;

function rssOnlyMb(): number {
  const rss = (process.memoryUsage as unknown as { rss?: () => number }).rss;
  return mb(typeof rss === 'function' ? rss() : process.memoryUsage().rss)!;
}

/** Start the fast burst probe; returns its stop. */
export function startMemoryBurstProbe(everyMs = BURST_PROBE_EVERY_MS, readRssMb: () => number = memoryReadingMb): () => void {
  if (process.env.WALNUT_MEMORY_PROBE === '0') return () => {};
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    const now = Date.now();
    const rssMb = readRssMb();
    nudgeGcOnRise(now, bunGc(), rssMb);
    void watchMemoryBurst(now, rssMb).catch(() => false).finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── A heap snapshot on request ───────────────────────────────────────────
//
// The ledger names what each registered cache holds; a heap snapshot names everything
// else. On 2026-11-21 the live server held about 1.5 GB of live objects right after a
// collection (1.2 GB of it strings) while its registered caches came to about 200 MB,
// and a copy of the same data held about 340 MB: what the rest is can only be read from
// a snapshot of the live process. Writing one stops the event loop for a few seconds
// (about 1.3 s per million objects measured on a copy) and needs memory of the size of
// the file, so it runs only when asked from this machine, at most every SNAPSHOT_EVERY_MS.
// The file holds everything the process holds, tokens included, and can be hundreds of MB:
// it goes to the runtime dir beside the stall recorder's CPU profiles, outside the data
// folder that backups and git sync copy, readable by this account only
// (tests/core/observability/process-dumps-stay-out-of-data.test.ts).
export const SNAPSHOT_EVERY_MS = 30 * 60_000;
export const HEAP_SNAPSHOT_DIR = path.join(LOG_DIR, 'heap-snapshots');
let lastSnapshotAt = -Infinity;

type SnapshotFn = () => string;
function bunSnapshot(): SnapshotFn | null {
  const b = (globalThis as { Bun?: { generateHeapSnapshot?: (format: 'v8') => unknown } }).Bun;
  return typeof b?.generateHeapSnapshot === 'function' ? () => b.generateHeapSnapshot!('v8') as string : null;
}

export type HeapSnapshotResult =
  | { ok: true; path: string; bytes: number; ms: number }
  | { ok: false; reason: string };

/** Write a V8-format heap snapshot of this process into `dir`. One per SNAPSHOT_EVERY_MS. */
export async function writeHeapSnapshot(dir: string = HEAP_SNAPSHOT_DIR, now = Date.now(), snap: SnapshotFn | null = bunSnapshot()): Promise<HeapSnapshotResult> {
  if (!snap) return { ok: false, reason: 'this runtime cannot write a heap snapshot' };
  if (now - lastSnapshotAt < SNAPSHOT_EVERY_MS) {
    return { ok: false, reason: `a snapshot was written ${Math.round((now - lastSnapshotAt) / 60_000)} min ago; one every ${SNAPSHOT_EVERY_MS / 60_000} min` };
  }
  lastSnapshotAt = now;
  const { default: fsp } = await import('node:fs/promises');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const before = processMemoryMb();
  const t0 = Date.now();
  const text = snap();
  const ms = Date.now() - t0;
  const file = path.join(dir, `heap-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${process.pid}.heapsnapshot`);
  await fsp.writeFile(file, text, { mode: 0o600 });
  log.obs.warn('heap snapshot written', { path: file, bytes: text.length, ms, rssMb: before.rssMb, heapUsedMb: before.heapUsedMb });
  return { ok: true, path: file, bytes: text.length, ms };
}

/** Reset sampler state (tests only). */
export function _resetMemoryLedgerForTesting(): void {
  lastSampleAt = 0;
  lastHeapWalkAt = -Infinity;
  lastNudgeAt = -Infinity;
  nudgedFromMb = null;
  overWarnedAt.clear();
  lastSnapshotAt = -Infinity;
  lastBurstAt = -Infinity;
  lastBurstRssMb = Infinity;
  lastBurstHeapWalkAt = -Infinity;
  lastBurstHeapWalkRssMb = Infinity;
  troughMb = Infinity;
  nudgedVia = 'tick';
  recentRss.length = 0;
}
