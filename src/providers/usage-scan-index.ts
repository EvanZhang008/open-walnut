/**
 * The host usage scan's file index: where each transcript was read to, and what
 * its recent responses folded into, so the next scan reads only the bytes the
 * files gained instead of every transcript on the host (24 GB on a busy Mac).
 *
 * Claude Code transcripts are append-only JSONL, so a file's state at a line
 * boundary plus its new lines is the same fold as reading it whole. A file
 * counts as unchanged only when its device, inode, size and ctime all match (a
 * write of any kind moves ctime, and a copy cannot set it); a changed file is
 * read from where it was left when its first bytes and the 1 KB before that
 * point are still the same, and from the start otherwise (rewritten, truncated,
 * replaced). Its modification time is never trusted.
 *
 * The index keeps the per-file fold of every response from the horizon on (two
 * days), plus an 8-byte hash of every response a file wrote before it: the
 * full scan's owner is a response's EARLIEST copy, so a copy written today of
 * a response from last week (a fork re-stamping its history) must still read
 * as history, not as a new call. An answer is always the WHOLE window asked for, decided across
 * all files with the full scan's owner rules (usage-scan-core.ts). So the
 * index is only a read cache: what Walnut has confirmed is the window start it
 * asks from (its last finished pass), and a pass it never imported is simply
 * answered again. A window reaching past the horizon rebuilds the index with
 * its fold kept from the window's start; one older than a week, or with no
 * start, takes the full scan.
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import {
  scanCanonicalUsage, scanFold as F,
  type CanonicalScanResult, type CanonicalUsageRecord, type CanonicalUsageScanOptions,
  type ScanGroup, type ScanLogFile, type ScanOwner, type ScanSnapshot, type UsageScanDiagnostics,
} from './usage-scan-core.js';

/** How far back the index keeps folded responses; an older window takes the full scan. */
export const INDEX_HORIZON_MS = 2 * 86_400_000;
/** A window must start this long after the horizon (a response's lines span minutes, never this). */
export const INDEX_MARGIN_MS = 60 * 60_000;
/** A window older than this is answered by the full scan instead of a deeper index. */
export const INDEX_DEEPEST_MS = 7 * 86_400_000;
const INDEX_VERSION = 1;
const HEAD_BYTES = 256;
const MARK_BYTES = 1024;

interface IndexEntry {
  file: ScanLogFile;
  dev: number; ino: number; size: number; ctimeMs: number;
  /** Bytes folded so far: always just after a newline. */
  offset: number;
  /** Candidate rows folded so far (the fold's line numbers continue from here). */
  line: number;
  /** Hex of the first bytes, and a hash of the MARK_BYTES before `offset`. */
  head: string; mark: string;
  /** Per-response fold of this file, responses from the horizon on. */
  snapshots: Map<string, ScanSnapshot>;
  /** keyHash of each response this file holds a line of from before the horizon. */
  old: Buffer;
}

export interface UsageScanIndex { horizon: number; entries: Map<string, IndexEntry> }

export interface IndexedScanStats {
  /** incremental: from the index; rebuilt: index made fresh; full: window past the horizon. */
  mode: 'incremental' | 'rebuilt' | 'full';
  files: number; filesRead: number; filesUnchanged: number; filesReread: number;
  bytesRead: number; ms: number;
}

type Pause = () => Promise<void> | undefined;

/** The index file for one projects dir inside `dir`. */
export function usageIndexPath(dir: string, projectsDir: string): string {
  return path.join(dir, `${createHash('sha1').update(path.resolve(projectsDir)).digest('hex').slice(0, 16)}.jsonl`);
}

// ── persistence (JSON lines, read and written with yields: the file can be tens of MB) ──

type StoredSnapshot = [string, string, string, number, number, string, number, ScanSnapshot['counters'],
  ScanSnapshot['pricingContext'] | null, number | null, 0 | 1, 0 | 1, number];

function storeSnapshot(key: string, s: ScanSnapshot): StoredSnapshot {
  return [key, s.responseId, s.model, s.time, s.line, s.sourceSessionId, s.sourceRank, s.counters,
    s.pricingContext ?? null, s.maxOutput ?? null, s.final ? 1 : 0, s.finalUsage ? 1 : 0, s.lines];
}

function loadSnapshot(file: ScanLogFile, r: StoredSnapshot): ScanSnapshot {
  return { file, responseId: r[1], model: r[2], time: r[3], line: r[4], sourceSessionId: r[5], sourceRank: r[6],
    counters: r[7], ...(r[8] ? { pricingContext: r[8] } : {}), maxOutput: r[9] ?? undefined,
    final: r[10] === 1, finalUsage: r[11] === 1, lines: r[12] };
}

export async function loadUsageIndex(indexPath: string, projectsDir: string): Promise<UsageScanIndex | undefined> {
  let header: { v?: number; root?: string; horizon?: number } | undefined;
  const entries = new Map<string, IndexEntry>();
  const input = createReadStream(indexPath, { encoding: 'utf8' });
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let n = 0;
    for await (const line of lines) {
      if (++n % 200 === 0) await setImmediate();
      if (!line) continue;
      const row = JSON.parse(line);
      if (!header) { header = row; if (header?.v !== INDEX_VERSION || header.root !== path.resolve(projectsDir)) return undefined; continue; }
      const file: ScanLogFile = { path: row.p, sessionId: row.s, ...(row.a ? { agentId: row.a } : {}) };
      entries.set(row.p, { file, dev: row.d, ino: row.i, size: row.z, ctimeMs: row.c, offset: row.o, line: row.l,
        head: row.h, mark: row.m, old: Buffer.from(row.x ?? '', 'base64'), snapshots: new Map((row.r as StoredSnapshot[]).map(r => [r[0], loadSnapshot(file, r)])) });
    }
  } catch { return undefined; } finally { input.destroy(); }
  return header && typeof header.horizon === 'number' ? { horizon: header.horizon, entries } : undefined;
}

export async function saveUsageIndex(indexPath: string, projectsDir: string, index: UsageScanIndex): Promise<void> {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const temp = `${indexPath}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  let written = false;
  try {
    let buffer = JSON.stringify({ v: INDEX_VERSION, root: path.resolve(projectsDir), horizon: index.horizon }) + '\n';
    for (const e of index.entries.values()) {
      buffer += JSON.stringify({ p: e.file.path, s: e.file.sessionId, ...(e.file.agentId ? { a: e.file.agentId } : {}),
        d: e.dev, i: e.ino, z: e.size, c: e.ctimeMs, o: e.offset, l: e.line, h: e.head, m: e.mark,
        ...(e.old.length ? { x: e.old.toString('base64') } : {}),
        r: [...e.snapshots].map(([key, s]) => storeSnapshot(key, s)) }) + '\n';
      if (buffer.length > 1 << 20) { await handle.write(buffer); buffer = ''; await setImmediate(); }
    }
    if (buffer) await handle.write(buffer);
    await handle.close();
    await rename(temp, indexPath);
    written = true;
  } finally {
    if (!written) { await handle.close().catch(() => {}); await rm(temp, { force: true }); }
  }
}

// ── reading one file from where the index left it ──

function hash(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
const keyBytes = (key: string): Buffer => createHash('sha1').update(key).digest().subarray(0, 8);

async function readAt(handle: FileHandle, start: number, length: number, stats: IndexedScanStats): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, length));
  if (buf.length) await handle.read(buf, 0, buf.length, start);
  stats.bytesRead += buf.length;
  return buf;
}

function foldRow(snapshots: Map<string, ScanSnapshot>, old: Buffer[], file: ScanLogFile, line: number, row: Record<string, unknown>,
  keepFrom: number, diag: UsageScanDiagnostics): void {
  const identity = F.responseIdentity(row, diag);
  if (!identity) return;
  const { key, id, model, time, message } = identity;
  if (time < keepFrom) { old.push(keyBytes(key)); return; }
  if (F.invalidUsage(message.usage)) diag.invalid_usage++;
  let snapshot = snapshots.get(key);
  if (!snapshot) {
    snapshot = { file, responseId: id, model, time, line, ...F.sourceOwner(row, file), counters: {}, maxOutput: undefined, final: false, finalUsage: false, lines: 0 };
    snapshots.set(key, snapshot);
  } else {
    diag.duplicate_usage_lines++;
    const candidate = { file, time, line, ...F.sourceOwner(row, file) };
    if (F.ownerBefore(candidate, snapshot)) Object.assign(snapshot, candidate);
  }
  F.updateUsage(snapshot, message);
  snapshot.lines++;
}

/**
 * Brings one file's entry up to date. Returns it, plus the fold of a last line
 * still without its newline (it may be mid-write: counted in this answer, read
 * again next time, never written into the entry).
 */
async function refreshFile(prev: IndexEntry | undefined, file: ScanLogFile, keepFrom: number, diag: UsageScanDiagnostics,
  pause: Pause, stats: IndexedScanStats, chunk: Buffer): Promise<{ entry: IndexEntry; tail?: Map<string, ScanSnapshot>; tailOld?: Buffer } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) { diag.skipped_non_regular_files++; return undefined; }
    stats.files++;
    const same = prev && prev.dev === stat.dev && prev.ino === stat.ino;
    // The bytes just before where the last scan stopped: one small read per file
    // catches a rewrite inside the clock tick a size and ctime check would miss.
    const markStart = prev ? Math.max(0, prev.offset - MARK_BYTES) : 0;
    const markOk = !!same && stat.size >= prev.offset
      && hash(await readAt(handle, markStart, prev.offset - markStart, stats)) === prev.mark;
    let entry: IndexEntry;
    let rest: Buffer;
    if (same && markOk && prev.size === stat.size && prev.ctimeMs === stat.ctimeMs) {
      // Not written since the last scan: only a last line without its newline is read again.
      stats.filesUnchanged++;
      entry = { ...prev, file };
      if (entry.offset === stat.size) return { entry };
      stats.filesRead++;
      rest = await readAt(handle, entry.offset, stat.size - entry.offset, stats);
    } else {
      let resume = false;
      if (same && markOk) {
        const head = (await readAt(handle, 0, Math.min(HEAD_BYTES, stat.size), stats)).toString('hex');
        const shared = Math.min(head.length, prev.head.length);
        resume = head.slice(0, shared) === prev.head.slice(0, shared);
      }
      if (prev && !resume) stats.filesReread++;
      entry = resume && prev ? { ...prev, file, size: stat.size, ctimeMs: stat.ctimeMs }
        : { file, dev: stat.dev, ino: stat.ino, size: stat.size, ctimeMs: stat.ctimeMs, offset: 0, line: 0, head: '', mark: '', snapshots: new Map(), old: Buffer.alloc(0) };
      stats.filesRead++;
      diag.files_scanned++;
      // Fold the complete lines past the offset into the entry; keep the unterminated rest aside.
      rest = Buffer.alloc(0);
      let position = entry.offset;
      const old: Buffer[] = [];
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, F.CHUNK_BYTES, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        stats.bytesRead += bytesRead;
        const buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const complete = buf.lastIndexOf(F.NEWLINE) + 1;
        for (const start of F.candidateLines(buf, complete)) {
          const wait = pause();
          if (wait) await wait;
          const row = F.parseLine(buf, start, buf.indexOf(F.NEWLINE, start), diag);
          if (row) foldRow(entry.snapshots, old, file, ++entry.line, row, keepFrom, diag);
        }
        entry.offset += complete;
        rest = Buffer.from(buf.subarray(complete));
      }
      if (old.length) entry.old = Buffer.concat([entry.old, ...old]);
      entry.head = (await readAt(handle, 0, Math.min(HEAD_BYTES, entry.offset), stats)).toString('hex');
      const markStart = Math.max(0, entry.offset - MARK_BYTES);
      entry.mark = hash(await readAt(handle, markStart, entry.offset - markStart, stats));
    }
    if (!rest.length || !F.CANDIDATES.some(p => rest.includes(p))) return { entry };
    let row: unknown;
    try { row = JSON.parse(rest.toString('utf8').replace(/^\0+/, '')); } catch { return { entry }; }
    if (!F.object(row)) return { entry };
    const identity = F.responseIdentity(row, diag);
    if (!identity) return { entry };
    const tail = new Map<string, ScanSnapshot>();
    const base = entry.snapshots.get(identity.key);
    if (base) tail.set(identity.key, { ...base, counters: { ...base.counters } });
    const tailOld: Buffer[] = [];
    foldRow(tail, tailOld, file, entry.line + 1, row, keepFrom, diag);
    return tailOld.length ? { entry, tailOld: tailOld[0] } : { entry, tail };
  } catch { diag.unreadable_files++; return undefined; }
  finally { await handle?.close().catch(() => {}); }
}

// ── the scan ──

async function refreshIndex(base: UsageScanIndex | undefined, root: string, keepFrom: number, diag: UsageScanDiagnostics,
  pause: Pause, stats: IndexedScanStats) {
  const entries = new Map<string, IndexEntry>();
  const tails = new Map<string, Map<string, ScanSnapshot>>();
  const tailOld: Buffer[] = [];
  const chunk = Buffer.allocUnsafe(F.CHUNK_BYTES);
  for await (const file of F.canonicalFiles(root, diag)) {
    const done = await refreshFile(base?.entries.get(file.path), file, keepFrom, diag, pause, stats, chunk);
    if (!done) continue;
    entries.set(file.path, done.entry);
    if (done.tail) tails.set(file.path, done.tail);
    if (done.tailOld) tailOld.push(done.tailOld);
  }
  return { index: { horizon: keepFrom, entries } as UsageScanIndex, tails, tailOld: Buffer.concat(tailOld) };
}

/** The full scan's owner and fold rules over the indexed files, for one window. */
async function answer({ index, tails, tailOld }: Awaited<ReturnType<typeof refreshIndex>>, since: number, until: number,
  selected: Set<string> | undefined, diag: UsageScanDiagnostics, pause: Pause): Promise<CanonicalUsageRecord[]> {
  const view = (entry: IndexEntry): Iterable<[string, ScanSnapshot]> => {
    const tail = tails.get(entry.file.path);
    if (!tail) return entry.snapshots;
    const merged = new Map(entry.snapshots);
    for (const [key, s] of tail) merged.set(key, s);
    return merged;
  };
  const owners = new Map<string, ScanOwner>();
  for (const entry of index.entries.values()) {
    for (const [key, s] of view(entry)) {
      const wait = pause();
      if (wait) await wait;
      const candidate: ScanOwner = { file: s.file, time: s.time, line: s.line, sourceSessionId: s.sourceSessionId, sourceRank: s.sourceRank };
      const owner = owners.get(key);
      owners.set(key, owner ? F.chooseOwner(candidate, owner, selected) : candidate);
    }
  }
  for (const [key, owner] of owners) {
    if (owner.time < since || owner.time >= until || (selected && !selected.has(owner.sourceSessionId))) owners.delete(key);
  }
  // A response with a line from before the horizon has its owner there: history, never in the window.
  const byHash = new Map<bigint, string>();
  for (const key of owners.keys()) byHash.set(keyBytes(key).readBigUInt64BE(0), key);
  const dropOld = (old: Buffer) => {
    for (let at = 0; at + 8 <= old.length && byHash.size; at += 8) {
      const key = byHash.get(old.readBigUInt64BE(at));
      if (key !== undefined) { owners.delete(key); byHash.delete(old.readBigUInt64BE(at)); }
    }
  };
  for (const entry of index.entries.values()) {
    if (!byHash.size) break;
    const wait = pause();
    if (wait) await wait;
    dropOld(entry.old);
  }
  dropOld(tailOld);
  const groups = new Map<string, ScanGroup>();
  for (const entry of index.entries.values()) {
    for (const [key, stored] of view(entry)) {
      if (!owners.has(key)) continue;
      const wait = pause();
      if (wait) await wait;
      // chooseOwner marks its pick; keep the stored fold clean for the next scan.
      const snapshot = { ...stored };
      const group = groups.get(key);
      if (!group) groups.set(key, { owner: snapshot, maxOutput: snapshot.maxOutput, ...(snapshot.finalUsage ? { finalCopy: snapshot } : {}) });
      else {
        if (snapshot.maxOutput !== undefined) group.maxOutput = Math.max(group.maxOutput ?? 0, snapshot.maxOutput);
        if (JSON.stringify(group.owner.counters) !== JSON.stringify(snapshot.counters)) diag.changed_usage_duplicates++;
        group.owner = F.chooseOwner(snapshot, group.owner, selected);
        if (F.strongerFinal(snapshot, group.finalCopy)) group.finalCopy = snapshot;
      }
    }
  }
  const records: CanonicalUsageRecord[] = [];
  for (const [key, group] of groups) {
    const owner = owners.get(key)!;
    if (group.owner.file.path !== owner.file.path || group.owner.time !== owner.time) continue;
    group.owner.ownershipUnverified ||= owner.ownershipUnverified;
    records.push(F.toRecord(group, diag));
  }
  return records;
}

function prune(index: UsageScanIndex, horizon: number): UsageScanIndex {
  if (horizon <= index.horizon) return index;
  for (const entry of index.entries.values()) {
    const old: Buffer[] = [];
    for (const [key, s] of entry.snapshots) if (s.time < horizon) { entry.snapshots.delete(key); old.push(keyBytes(key)); }
    if (old.length) entry.old = Buffer.concat([entry.old, ...old]);
  }
  return { horizon, entries: index.entries };
}

/**
 * `scanCanonicalUsage` for a whole host, answered from the file index when the
 * window starts after its horizon, and the index brought up to date. The
 * records equal the full scan's for the same files and window.
 */
export async function scanCanonicalUsageIndexed(options: CanonicalUsageScanOptions & { indexPath: string; now?: number }):
  Promise<CanonicalScanResult & { scan: IndexedScanStats }> {
  const started = Date.now();
  const now = options.now ?? started;
  await F.assertRoot(options.projectsDir);
  const since = F.boundary(options.since, -Infinity), until = F.boundary(options.until, Infinity);
  if (since >= until) throw new Error('Usage since must precede until');
  const selected = options.sessionIds ? new Set(options.sessionIds) : undefined;
  const diag = F.diagnostics();
  const pause = F.yieldBudget(diag);
  const stats: IndexedScanStats = { mode: 'incremental', files: 0, filesRead: 0, filesUnchanged: 0, filesReread: 0, bytesRead: 0, ms: 0 };
  const horizon = now - INDEX_HORIZON_MS;
  const base = await loadUsageIndex(options.indexPath, options.projectsDir);
  let result: CanonicalScanResult;
  let index: UsageScanIndex;
  if (base && since >= base.horizon + INDEX_MARGIN_MS) {
    const fresh = await refreshIndex(base, options.projectsDir, base.horizon, diag, pause, stats);
    index = fresh.index;
    result = { records: await answer(fresh, since, until, selected, diag, pause), diagnostics: diag, costStates: [] };
  } else if (since >= now - INDEX_DEEPEST_MS) {
    // One read of every file, its fold kept from the window's start; the save prunes it to the horizon.
    stats.mode = 'rebuilt';
    const fresh = await refreshIndex(undefined, options.projectsDir, Math.min(horizon, since - INDEX_MARGIN_MS), diag, pause, stats);
    index = fresh.index;
    result = { records: await answer(fresh, since, until, selected, diag, pause), diagnostics: diag, costStates: [] };
  } else {
    // No start, or older than a week: the full scan (it reads every file twice), then a fresh index.
    stats.mode = 'full';
    result = await scanCanonicalUsage(options);
    const fresh = await refreshIndex(undefined, options.projectsDir, horizon, F.diagnostics(), pause, stats);
    index = fresh.index;
    const total = [...index.entries.values()].reduce((n, e) => n + e.size, 0);
    stats.bytesRead += 2 * total;
  }
  await saveUsageIndex(options.indexPath, options.projectsDir, prune(index, horizon)).catch(() => { /* next scan rebuilds */ });
  stats.ms = Date.now() - started;
  return { ...result, scan: stats };
}
