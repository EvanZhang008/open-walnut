import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
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
  /** Stable cross-batch identity without returning the private account label. */
  evidenceId?: string;
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

export interface ProxyUsageCheckpoint {
  offset: number;
  dev: number;
  ino: number;
}

export interface ProxyUsageScanOptions {
  files: string[];
  /** Opt-in incremental reads. Offsets must be newline boundaries previously returned for the same file. */
  offsets?: Record<string, ProxyUsageCheckpoint>;
  /** Half-open request-start window [since, until), in milliseconds, ISO timestamps or local dates. */
  since?: Time;
  until?: Time;
  sessionIds?: string[];
}

export interface ProxyUsageScanResult {
  records: ProxyUsageRecord[];
  /** Host-local paths are returned only in incremental mode, never in ordinary exported evidence. */
  checkpoints?: Record<string, ProxyUsageCheckpoint>;
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
    source: 'proxy', evidenceId: createHash('sha256').update(JSON.stringify([label(raw.account), requestId, startedMs])).digest('hex'),
    requestId, sessionId: label(raw.session_id),
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

/** Incremental reads wait for a complete LF/CRLF line; trailing fragments are reread next time. */
async function* completeProxyLines(handle: FileHandle, start: number, end: number): AsyncGenerator<{ line: string; bytes: number }> {
  const stream = handle.createReadStream({ autoClose: false, start, end: end - 1 });
  let fragments: Buffer[] = [];
  let readError: Error | undefined;
  stream.on('error', error => { readError = error; });
  try {
    for await (const value of stream) {
      const chunk = value as Buffer;
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor);
        if (newline < 0) { fragments.push(chunk.subarray(cursor)); break; }
        fragments.push(chunk.subarray(cursor, newline + 1));
        const bytes = Buffer.concat(fragments);
        yield { line: bytes.toString('utf8').replace(/\r?\n$/, ''), bytes: bytes.length };
        fragments = [];
        cursor = newline + 1;
      }
    }
    if (readError) throw readError;
  } finally { stream.destroy(); }
}

/** Stream explicitly supplied regular files. Incremental callers merge/deduplicate evidence across batches. */
export async function scanProxyUsage(options: ProxyUsageScanOptions): Promise<ProxyUsageScanResult> {
  const since = bound(options.since), until = bound(options.until);
  if (since !== undefined && until !== undefined && since > until) throw new RangeError('Reversed usage time window');
  if (options.offsets && Object.values(options.offsets).some(checkpoint => !checkpoint
    || !Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0
    || !Number.isSafeInteger(checkpoint.dev) || checkpoint.dev < 0
    || !Number.isSafeInteger(checkpoint.ino) || checkpoint.ino < 0)) {
    throw new RangeError('Invalid usage file checkpoint');
  }
  const checkpoints: Record<string, ProxyUsageCheckpoint> | undefined = options.offsets === undefined ? undefined : {};
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
      const previous = options.offsets?.[file];
      let consumedOffset = previous && previous.dev === stat.dev && previous.ino === stat.ino && previous.offset <= stat.size
        ? previous.offset : 0;
      const checkpoint = checkpoints ? { offset: consumedOffset, dev: stat.dev, ino: stat.ino } : undefined;
      if (checkpoint) Object.defineProperty(checkpoints!, file, { value: checkpoint, enumerable: true, configurable: true, writable: true });
      if (consumedOffset >= stat.size) continue;
      // Snapshot EOF: a busy append-only log cannot extend a scan forever.
      const stream = checkpoints ? undefined : handle.createReadStream({ encoding: 'utf8', autoClose: false, end: stat.size - 1 });
      const lines = stream ? createInterface({ input: stream, crlfDelay: Infinity }) : undefined;
      let readError: Error | undefined;
      stream?.on('error', (error) => { readError = error; lines?.close(); });
      const input = lines ?? completeProxyLines(handle, consumedOffset, stat.size);
      let lineNumber = 0;
      try {
        for await (const value of input) {
          const line = typeof value === 'string' ? value : value.line;
          if (typeof value !== 'string') {
            consumedOffset += value.bytes;
            checkpoint!.offset = consumedOffset;
          }
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
      } finally { lines?.close(); stream?.destroy(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      diagnostics.push({ fileIndex, code: typeof code === 'string' ? code : 'file-read-error' });
      coverage.allFilesRead = false;
    } finally { await handle?.close(); }
  }
  coverage.unattributed = records.filter((record) => record.sessionId === null).length;
  coverage.incomplete = records.filter((record) => !record.complete).length;
  return { records, diagnostics, coverage, ...(checkpoints ? { checkpoints } : {}) };
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

function* stableSort(values: number[], compare: (a: number, b: number) => number): Generator<void, void> {
  let source = values, target = new Array<number>(values.length);
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
      let left = start, right = middle;
      for (let out = start; out < end; out++) {
        target[out] = left < middle && (right >= end || compare(source[left], source[right]) <= 0) ? source[left++] : source[right++];
        yield;
      }
    }
    [source, target] = [target, source];
  }
  if (source !== values) for (let i = 0; i < values.length; i++) { values[i] = source[i]; yield; }
}

/** One matching algorithm, drained synchronously or cooperatively by the public APIs. */
function* reconciliationSteps(
  canonical: readonly CanonicalUsageRecord[], upstream: readonly ProxyUsageRecord[],
  options: { maxTimestampDriftMs?: number; since?: number; until?: number } = {},
): Generator<void, UsageReconciliation> {
  const drift = options.maxTimestampDriftMs ?? 5_000;
  if (!Number.isFinite(drift) || drift < 0) throw new RangeError('Invalid usage timestamp drift');
  const records: UsageReconciliation['records'] = [];
  const canonicalGroups = new Map<string, number[]>(), upstreamGroups = new Map<string, number[]>();
  const starts: number[] = [], ends: number[] = [], eligible: boolean[] = [];
  for (const [index, record] of canonical.entries()) {
    const key = signature(record);
    const verification = record.complete && hasCounters(record) && key && time(record.timestamp) !== null ? 'unmatched' : 'incomplete';
    records.push({ ...record, verification });
    if (verification !== 'incomplete' && key) {
      const group = canonicalGroups.get(key) ?? []; group.push(index); canonicalGroups.set(key, group);
    }
    yield;
  }
  for (const [index, record] of upstream.entries()) {
    starts.push(record.startedMs - drift); ends.push((record.finishedMs ?? record.startedMs) + drift);
    const key = signature(record);
    eligible.push(Boolean(record.complete && record.usagePresent && key && time(record.startedMs) !== null
      && (record.finishedMs === null || (time(record.finishedMs) !== null && record.finishedMs >= record.startedMs)) && Number.isFinite(ends[index])));
    if (eligible[index] && key) {
      const group = upstreamGroups.get(key) ?? []; group.push(index); upstreamGroups.set(key, group);
    }
    yield;
  }
  const used = new Set<number>();
  for (const [key, group] of canonicalGroups) {
    const candidates = upstreamGroups.get(key) ?? [];
    yield* stableSort(candidates, (a, b) => starts[a] - starts[b] || ends[a] - ends[b]);
    yield* stableSort(group, (a, b) => time(records[a].timestamp)! - time(records[b].timestamp)!);
    const heap: number[] = [];
    let cursor = 0;
    for (const index of group) {
      const timestamp = time(records[index].timestamp)!;
      while (cursor < candidates.length && starts[candidates[cursor]] <= timestamp) { heapPush(heap, candidates[cursor++], ends); yield; }
      while (heap.length && ends[heap[0]] < timestamp) { heapPop(heap, ends); yield; }
      if (heap.length) {
        // Earliest compatible finish preserves count multiplicity when windows overlap.
        const match = heapPop(heap, ends);
        used.add(match); records[index].verification = 'matched'; records[index].upstream = upstream[match];
      }
      yield;
    }
  }
  const inWindow = (timestamp: number) => (options.since === undefined || timestamp >= options.since)
    && (options.until === undefined || timestamp < options.until);
  const scopedRecords: UsageReconciliation['records'] = [], upstreamUnmatched: UsageReconciliation['upstreamUnmatched'] = [];
  for (const record of records) { if (inWindow(time(record.timestamp) ?? -Infinity)) scopedRecords.push(record); yield; }
  for (const [index, record] of upstream.entries()) {
    if (!used.has(index) && inWindow(record.startedMs)) upstreamUnmatched.push({
      ...record, verification: !record.sessionId ? 'unattributed' : eligible[index] ? 'unmatched' : 'incomplete',
    });
    yield;
  }
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
  for (const record of scopedRecords) { if (record.verification !== 'matched') addResidual('canonical', record); yield; }
  for (const record of upstreamUnmatched) { addResidual('proxy', record); yield; }
  return { records: scopedRecords, upstreamUnmatched, residuals: [...residuals.values()] };
}

/** Input canonical records are already response/fork deduped by their owning scanner. */
export function reconcileUsage(
  canonical: readonly CanonicalUsageRecord[], upstream: readonly ProxyUsageRecord[],
  options: { maxTimestampDriftMs?: number; since?: number; until?: number } = {},
): UsageReconciliation {
  const steps = reconciliationSteps(canonical, upstream, options);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** The same stable greedy matcher, including sort/heap work, yields at a five-millisecond CPU budget. */
export async function reconcileUsageAsync(
  canonical: readonly CanonicalUsageRecord[], upstream: readonly ProxyUsageRecord[],
  options: { maxTimestampDriftMs?: number; since?: number; until?: number } = {},
): Promise<UsageReconciliation> {
  const steps = reconciliationSteps(canonical, upstream, options);
  let cpu = process.cpuUsage(), ticks = 0, next = steps.next();
  while (!next.done) {
    if (++ticks % 64 === 0) {
      const elapsed = process.cpuUsage(cpu);
      if (elapsed.user + elapsed.system >= 5_000) { await setImmediate(); cpu = process.cpuUsage(); }
    }
    next = steps.next();
  }
  return next.value;
}
