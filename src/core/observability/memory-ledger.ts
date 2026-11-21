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

export interface ProcessMemoryMb { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number }

/** This process's memory in whole MB: the one place every report and log line reads it. */
export function processMemoryMb(): ProcessMemoryMb {
  const m = process.memoryUsage();
  return {
    rssMb: mb(m.rss)!, heapUsedMb: mb(m.heapUsed)!, heapTotalMb: mb(m.heapTotal)!,
    externalMb: mb(m.external)!, arrayBuffersMb: mb(m.arrayBuffers)!,
  };
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
export const GC_NUDGE_RSS_MB = 1536;
export const GC_NUDGE_EVERY_MS = 3 * 60_000;
let lastNudgeAt = -Infinity;
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
export function nudgeGcUnderPressure(now = Date.now(), gc: GcFn | null = bunGc(), rssMb = processMemoryMb().rssMb): void {
  if (process.env.WALNUT_GC_NUDGE === '0' || !gc) return;
  if (nudgedFromMb !== null) {
    log.obs.info('memory gc nudge', { beforeMb: nudgedFromMb, afterMb: rssMb, freedMb: nudgedFromMb - rssMb });
    nudgedFromMb = null;
  }
  if (rssMb < GC_NUDGE_RSS_MB || now - lastNudgeAt < GC_NUDGE_EVERY_MS) return;
  lastNudgeAt = now;
  nudgedFromMb = rssMb;
  gc(false);
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
// reading of the last BURST_WINDOW_MS. At most one line per BURST_EVERY_MS.
export const BURST_RISE_MB = 1024;
export const BURST_WINDOW_MS = 3 * 60_000;
export const BURST_EVERY_MS = 15 * 60_000;

const burstContexts = new Map<string, () => unknown>();
/** Register what a module has in flight, read only when a burst is logged. Returns its unregister. */
export function registerBurstContext(name: string, read: () => unknown): () => void {
  burstContexts.set(name, read);
  return () => { if (burstContexts.get(name) === read) burstContexts.delete(name); };
}

const recentRss: Array<{ at: number; rssMb: number }> = [];
let lastBurstAt = -Infinity;

/** Health-tick hook (every 30 s): log what was in flight when the footprint jumped. */
export async function watchMemoryBurst(now = Date.now(), rssMb = processMemoryMb().rssMb): Promise<boolean> {
  while (recentRss.length > 0 && now - recentRss[0]!.at > BURST_WINDOW_MS) recentRss.shift();
  const low = recentRss.reduce((m, r) => Math.min(m, r.rssMb), rssMb);
  recentRss.push({ at: now, rssMb });
  if (rssMb - low < BURST_RISE_MB || now - lastBurstAt < BURST_EVERY_MS) return false;
  lastBurstAt = now;
  const context: Record<string, unknown> = {};
  for (const [name, read] of burstContexts) {
    try { context[name] = read(); } catch (err) { context[name] = `unreadable: ${err instanceof Error ? err.message : String(err)}`; }
  }
  // No heap walk here: at the peak it would stop the loop for seconds. The engine's own
  // allocator counters are free; process numbers say strings (external) or buffers.
  const j = await loadJsc();
  const u = j?.memoryUsage();
  log.obs.warn('memory burst', {
    ...processMemoryMb(), lowMb: low, riseMb: rssMb - low, uptimeSec: Math.round(process.uptime()),
    holdersMb: Math.round(readMemoryHolders().reduce((n, r) => n + r.bytes, 0) / MB),
    ...(u ? { engineMb: mb(u.current), engineCommitMb: mb(u.currentCommit) } : {}), context,
  });
  return true;
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
  recentRss.length = 0;
}
