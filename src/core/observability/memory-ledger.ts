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

import { log } from '../../logging/index.js';

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

/** Reset sampler state (tests only). */
export function _resetMemoryLedgerForTesting(): void {
  lastSampleAt = 0;
  lastHeapWalkAt = -Infinity;
  overWarnedAt.clear();
}
