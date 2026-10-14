import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { normalizeUsageModel, type CanonicalUsageRecord } from './usage-scan-core.js';

const COUNTERS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
type Counter = typeof COUNTERS[number];
type Counters = Record<Counter, number | null>;
type Time = string | number | Date;

/** Only independent token evidence, never request content or inferred cache TTL. */
export interface ProxyUsageRecord extends Counters {
  source: 'proxy';
  requestId: string;
  sessionId: string | null;
  model: string | null;
  requestedModel: string | null;
  responseModel: string | null;
  forwardedModel: string | null;
  startedMs: number;
  finishedMs: number | null;
  usagePresent: boolean;
  complete: boolean;
  fileIndex: number;
  lineNumber: number;
}

export interface ProxyUsageScanOptions {
  files: string[];
  /** Half-open request-start window [since, until), in milliseconds, ISO timestamps or local dates. */
  since?: Time;
  until?: Time;
  sessionIds?: string[];
}

export interface ProxyUsageScanResult {
  records: ProxyUsageRecord[];
  diagnostics: { fileIndex: number; lineNumber?: number; code: string }[];
  coverage: {
    filesRequested: number;
    filesScanned: number;
    cacheLines: number;
    duplicates: number;
    filtered: number;
    unattributed: number;
    incomplete: number;
    yields: number;
    firstStartedMs: number | null;
    lastStartedMs: number | null;
    /** Explicit files only; this does not claim all host traffic was logged. */
    allFilesRead: boolean;
  };
}

function label(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function time(value: unknown): number | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value
    : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function bound(value: Time | undefined): number | undefined {
  if (value === undefined) return undefined;
  let ms = time(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    ms = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
  }
  if (ms === null) throw new TypeError('Invalid usage time bound');
  return ms;
}

function hasCounters(record: object): boolean {
  return COUNTERS.every((key) => counter((record as Record<string, unknown>)[key]) !== null);
}

function extract(raw: Record<string, unknown>, fileIndex: number, lineNumber: number): ProxyUsageRecord | null {
  const requestId = label(raw.request_id);
  const startedMs = time(raw.started_ms);
  if (!requestId || startedMs === null) return null;
  const duration = typeof raw.duration_ms === 'number' ? raw.duration_ms : raw.total_ms;
  const finish = time(raw.finished_ms) ?? (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
    ? time(startedMs + duration) : null);
  const requestedModel = label(raw.requested_model);
  const responseModel = label(raw.response_model);
  const forwardedModel = label(raw.forwarded_model);
  const record: ProxyUsageRecord = {
    source: 'proxy', requestId, sessionId: label(raw.session_id),
    model: responseModel ?? forwardedModel ?? requestedModel,
    requestedModel, responseModel, forwardedModel, startedMs,
    finishedMs: finish !== null && finish >= startedMs ? finish : null,
    usagePresent: raw.usage_present === true, complete: false, fileIndex, lineNumber,
    input_tokens: counter(raw.input_tokens), output_tokens: counter(raw.output_tokens),
    cache_creation_input_tokens: counter(raw.cache_creation_input_tokens),
    cache_read_input_tokens: counter(raw.cache_read_input_tokens),
  };
  const success = raw.success !== false && (raw.outcome === 'complete' || raw.outcome === 'success'
    || (raw.success === true && raw.outcome === undefined));
  record.complete = success && record.usagePresent && hasCounters(record) && record.model !== null;
  return record;
}

/** Stream only explicitly supplied regular files. File positions replace raw paths/accounts in output. */
export async function scanProxyUsage(options: ProxyUsageScanOptions): Promise<ProxyUsageScanResult> {
  const since = bound(options.since), until = bound(options.until);
  if (since !== undefined && until !== undefined && since > until) throw new RangeError('Reversed usage time window');
  const sessions = options.sessionIds ? new Set(options.sessionIds) : null;
  const records: ProxyUsageRecord[] = [];
  const diagnostics: ProxyUsageScanResult['diagnostics'] = [];
  const coverage: ProxyUsageScanResult['coverage'] = {
    filesRequested: options.files.length, filesScanned: 0, cacheLines: 0, duplicates: 0,
    filtered: 0, unattributed: 0, incomplete: 0, yields: 0, firstStartedMs: null, lastStartedMs: null,
    allFilesRead: true,
  };
  let cpuStart = process.cpuUsage();
  const yieldIfNeeded = (): Promise<void> | undefined => {
    const cpu = process.cpuUsage(cpuStart);
    if (cpu.user + cpu.system < 5_000) return;
    coverage.yields++;
    return setImmediate().then(() => { cpuStart = process.cpuUsage(); });
  };
  const seen = new Map<string, ProxyUsageRecord>();
  for (const [fileIndex, file] of options.files.entries()) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Nonblocking open prevents a FIFO from hanging even if the path changes before fstat.
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        diagnostics.push({ fileIndex, code: 'not-regular-file' });
        coverage.allFilesRead = false;
        continue;
      }
      coverage.filesScanned++;
      if (!stat.size) continue;
      // Snapshot EOF: a busy append-only log cannot extend a scan forever.
      const stream = handle.createReadStream({ encoding: 'utf8', autoClose: false, end: stat.size - 1 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let readError: Error | undefined;
      stream.on('error', (error) => { readError = error; lines.close(); });
      let lineNumber = 0;
      try {
        for await (const line of lines) {
          lineNumber++;
          const pause = yieldIfNeeded();
          if (pause) await pause;
          const marker = /(?:^|\s)request CACHE\s+(\{.*)$/.exec(line);
          if (!marker) continue;
          coverage.cacheLines++;
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(marker[1]);
            if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new TypeError('Invalid CACHE object');
          } catch {
            diagnostics.push({ fileIndex, lineNumber, code: 'invalid-cache-json' });
            continue;
          }
          const record = extract(raw, fileIndex, lineNumber);
          if (!record) {
            diagnostics.push({ fileIndex, lineNumber, code: 'invalid-request-identity' });
            continue;
          }
          const identity = JSON.stringify([label(raw.account), record.requestId, record.startedMs]);
          const previous = seen.get(identity);
          if (previous) {
            coverage.duplicates++;
            const { fileIndex: _f, lineNumber: _l, ...content } = record;
            const { fileIndex: _pf, lineNumber: _pl, ...previousContent } = previous;
            if (JSON.stringify(content) !== JSON.stringify(previousContent)) {
              previous.complete = false;
              for (const key of COUNTERS) if (previous[key] !== record[key]) previous[key] = null;
              diagnostics.push({ fileIndex, lineNumber, code: 'conflicting-duplicate' });
            }
            continue;
          }
          seen.set(identity, record);
          if ((since !== undefined && record.startedMs < since) || (until !== undefined && record.startedMs >= until)
            || (sessions && record.sessionId !== null && !sessions.has(record.sessionId))) {
            coverage.filtered++;
            continue;
          }
          // Unattributed traffic remains visible as a coverage gap, not a guessed session match.
          records.push(record);
          coverage.firstStartedMs = Math.min(coverage.firstStartedMs ?? record.startedMs, record.startedMs);
          coverage.lastStartedMs = Math.max(coverage.lastStartedMs ?? record.startedMs, record.startedMs);
        }
        if (readError) throw readError;
      } finally { lines.close(); stream.destroy(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      diagnostics.push({ fileIndex, code: typeof code === 'string' ? code : 'file-read-error' });
      coverage.allFilesRead = false;
    } finally { await handle?.close(); }
  }
  coverage.unattributed = records.filter((record) => record.sessionId === null).length;
  coverage.incomplete = records.filter((record) => !record.complete).length;
  return { records, diagnostics, coverage };
}

export type UsageVerification = 'matched' | 'unmatched' | 'incomplete';
export interface UsageResidual extends Counters {
  source: 'canonical' | 'proxy';
  model: string;
  count: number;
}
export interface UsageReconciliation {
  records: (CanonicalUsageRecord & { verification: UsageVerification; upstream?: ProxyUsageRecord })[];
  upstreamUnmatched: (ProxyUsageRecord & { verification: 'unmatched' | 'incomplete' | 'unattributed' })[];
  residuals: UsageResidual[];
}

function signature(record: { sessionId: string | null; model: string | null } & object): string | null {
  const model = normalizeUsageModel(record.model);
  if (!record.sessionId || !record.model || model === 'unknown' || !hasCounters(record)) return null;
  return JSON.stringify([record.sessionId, model,
    ...COUNTERS.map((key) => (record as Record<string, unknown>)[key])]);
}

/** A min-heap by interval end consumes one observation per call without quadratic candidate scans. */
function heapPush(heap: number[], index: number, ends: number[]): void {
  let pos = heap.length;
  heap.push(index);
  while (pos > 0) {
    const parent = (pos - 1) >>> 1;
    if (ends[heap[parent]] <= ends[index]) break;
    heap[pos] = heap[parent]; pos = parent;
  }
  heap[pos] = index;
}
function heapPop(heap: number[], ends: number[]): number {
  const first = heap[0], last = heap.pop()!;
  if (!heap.length) return first;
  let pos = 0;
  while (pos * 2 + 1 < heap.length) {
    let child = pos * 2 + 1;
    if (child + 1 < heap.length && ends[heap[child + 1]] < ends[heap[child]]) child++;
    if (ends[last] <= ends[heap[child]]) break;
    heap[pos] = heap[child]; pos = child;
  }
  heap[pos] = last;
  return first;
}

/** Input canonical records are already response/fork deduped by their owning scanner. */
export function reconcileUsage(
  canonical: readonly CanonicalUsageRecord[], upstream: readonly ProxyUsageRecord[],
  options: { maxTimestampDriftMs?: number; since?: number; until?: number } = {},
): UsageReconciliation {
  const drift = options.maxTimestampDriftMs ?? 5_000;
  if (!Number.isFinite(drift) || drift < 0) throw new RangeError('Invalid usage timestamp drift');
  const records: UsageReconciliation['records'] = canonical.map((record) => ({
    ...record, verification: record.complete && hasCounters(record) && signature(record) && time(record.timestamp) !== null
      ? 'unmatched' : 'incomplete',
  }));
  const canonicalGroups = new Map<string, number[]>(), upstreamGroups = new Map<string, number[]>();
  const starts = upstream.map((record) => record.startedMs - drift);
  const ends = upstream.map((record) => (record.finishedMs ?? record.startedMs) + drift);
  records.forEach((record, index) => {
    const key = signature(record);
    if (record.verification !== 'incomplete' && key) {
      const group = canonicalGroups.get(key) ?? []; group.push(index); canonicalGroups.set(key, group);
    }
  });
  const eligible = upstream.map((record, index) => Boolean(record.complete && record.usagePresent && signature(record)
    && time(record.startedMs) !== null && (record.finishedMs === null
      || (time(record.finishedMs) !== null && record.finishedMs >= record.startedMs)) && Number.isFinite(ends[index])));
  upstream.forEach((record, index) => {
    const key = signature(record);
    if (eligible[index] && key) {
      const group = upstreamGroups.get(key) ?? []; group.push(index); upstreamGroups.set(key, group);
    }
  });
  const used = new Set<number>();
  for (const [key, group] of canonicalGroups) {
    const candidates = upstreamGroups.get(key) ?? [];
    candidates.sort((a, b) => starts[a] - starts[b] || ends[a] - ends[b]);
    group.sort((a, b) => time(records[a].timestamp)! - time(records[b].timestamp)!);
    const heap: number[] = [];
    let cursor = 0;
    for (const index of group) {
      const timestamp = time(records[index].timestamp)!;
      while (cursor < candidates.length && starts[candidates[cursor]] <= timestamp) heapPush(heap, candidates[cursor++], ends);
      while (heap.length && ends[heap[0]] < timestamp) heapPop(heap, ends);
      if (!heap.length) continue;
      // Earliest compatible finish preserves count multiplicity when windows overlap.
      const match = heapPop(heap, ends);
      used.add(match); records[index].verification = 'matched'; records[index].upstream = upstream[match];
    }
  }
  const inWindow = (timestamp: number) => (options.since === undefined || timestamp >= options.since)
    && (options.until === undefined || timestamp < options.until);
  const scopedRecords = records.filter(record => inWindow(time(record.timestamp) ?? -Infinity));
  const upstreamUnmatched: UsageReconciliation['upstreamUnmatched'] = upstream.flatMap((record, index) =>
    used.has(index) || !inWindow(record.startedMs) ? [] : [{
      ...record, verification: !record.sessionId ? 'unattributed' : eligible[index] ? 'unmatched' : 'incomplete',
    }]);
  const residuals = new Map<string, UsageResidual>();
  function addResidual(source: UsageResidual['source'], record: { model: string | null } & object): void {
    const model = record.model ? normalizeUsageModel(record.model) : 'unknown';
    const key = JSON.stringify([source, model]);
    const sum = residuals.get(key) ?? { source, model, count: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    sum.count++;
    for (const field of COUNTERS) {
      const value = counter((record as Record<string, unknown>)[field]);
      sum[field] = sum[field] === null || value === null ? null : sum[field]! + value;
    }
    residuals.set(key, sum);
  }
  scopedRecords.filter((record) => record.verification !== 'matched').forEach((record) => addResidual('canonical', record));
  upstreamUnmatched.forEach((record) => addResidual('proxy', record));
  return { records: scopedRecords, upstreamUnmatched, residuals: [...residuals.values()] };
}
