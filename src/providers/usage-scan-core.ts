import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';

export interface CanonicalUsageRecord {
  responseId: string;
  model: string;
  sessionId: string;
  agentId?: string;
  timestamp: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  speed?: 'standard' | 'fast' | null;
  inference_geo?: string | null;
  service_tier?: string | null;
  server_tool_use?: { web_search_requests: number | null; web_fetch_requests: number | null };
  pricing_context_complete?: boolean;
  complete: boolean;
}

export interface CanonicalCostState {
  sessionId: string;
  totalCostUsd: number;
  timestamp?: string;
  /** The CLI's cumulative model time (retries and parallel subagents included). */
  apiDurationMs?: number;
  /** The CLI's cumulative process time, idle stretches included. */
  durationMs?: number;
}

export interface UsageScanDiagnostics {
  files_scanned: number;
  unreadable_files: number;
  skipped_non_regular_files: number;
  invalid_lines: number;
  invalid_timestamps: number;
  missing_message_ids: number;
  invalid_usage: number;
  duplicate_usage_lines: number;
  changed_usage_duplicates: number;
  incomplete_records: number;
  recovered_final_count: number;
  yields: number;
}

export interface CanonicalUsageScanOptions {
  projectsDir: string;
  since?: string | Date;
  until?: string | Date;
  sessionIds?: string[];
}

type JsonObject = Record<string, unknown>;
const BASE_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
const TTL_FIELDS = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const;
type Counter = typeof BASE_FIELDS[number] | typeof TTL_FIELDS[number];
type Counters = Partial<Record<Counter, number>>;
interface LogFile { path: string; sessionId: string; agentId?: string }
interface ResponseOwner {
  file: LogFile; time: number; line: number;
  sourceSessionId: string;
  sourceRank: number;
  ownershipUnverified?: boolean;
}
interface ResponseSnapshot extends ResponseOwner {
  responseId: string;
  model: string;
  counters: Counters;
  pricingContext?: Pick<CanonicalUsageRecord, 'speed' | 'inference_geo' | 'service_tier' | 'server_tool_use' | 'pricing_context_complete'>;
  maxOutput: number | undefined;
  final: boolean;
  finalUsage: boolean;
  lines: number;
}
interface ResponseGroup { owner: ResponseSnapshot; finalCopy?: ResponseSnapshot; maxOutput: number | undefined }

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeUsageModel(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/\[1m\]$/, '') : '';
  const name = raw.replace(/^(?:bedrock\/)?(?:converse\/)?/, '')
    .replace(/^(?:(?:us|eu|apac|global)\.)?(?:anthropic|openai)\./, '')
    .replace(/-\d{8}(?=-|$)/g, '').replace(/-v\d+(?::\d+)?$/, '').replace(/\./g, '-');
  if (/^(?:claude-)?3-5-haiku$/.test(name)) return 'claude-haiku-3-5';
  if (/^(?:claude-)?(?:fable|opus|sonnet|haiku)-\d+(?:-\d{1,2})?(?:-fast)?$/.test(name)) {
    return name.startsWith('claude-') ? name : `claude-${name}`;
  }
  const compact = name.replace(/[\s._-]/g, '');
  const gpt = /^gpt(61|6|56)(sol|luna|astra)$/.exec(compact);
  if (gpt) return `gpt-${gpt[1] === '61' ? '6-1' : gpt[1] === '56' ? '5-6' : '6'}-${gpt[2]}`;
  return raw || 'unknown';
}

function timestamp(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value !== 'string') return undefined;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!parts) return undefined;
  const [, year, month, day, hour, minute, second = '0'] = parts.map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]! || hour! > 23 || minute! > 59 || Number(second) > 59) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function boundary(value: string | Date | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  let time: number | undefined;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year!, month! - 1, day!);
    if (date.getFullYear() === year && date.getMonth() === month! - 1 && date.getDate() === day) time = date.getTime();
  } else time = timestamp(value);
  if (time === undefined) throw new Error('Usage boundary must be a valid date or offset-bearing timestamp');
  return time;
}

function diagnostics(): UsageScanDiagnostics {
  return { files_scanned: 0, unreadable_files: 0, skipped_non_regular_files: 0, invalid_lines: 0,
    invalid_timestamps: 0, missing_message_ids: 0, invalid_usage: 0, duplicate_usage_lines: 0,
    changed_usage_duplicates: 0, incomplete_records: 0, recovered_final_count: 0, yields: 0 };
}

function yieldBudget(diag: UsageScanDiagnostics): () => Promise<void> | undefined {
  let start = process.cpuUsage();
  return () => {
    const elapsed = process.cpuUsage(start);
    if (elapsed.user + elapsed.system < 5_000) return;
    diag.yields++;
    return setImmediate().then(() => { start = process.cpuUsage(); });
  };
}

async function directories(dir: string, diag: UsageScanDiagnostics) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch { diag.unreadable_files++; return []; }
}

async function assertRoot(dir: string): Promise<void> {
  if (!(await lstat(dir)).isDirectory()) throw new Error('Canonical projects path must be a directory');
}

async function* canonicalFiles(root: string, diag: UsageScanDiagnostics): AsyncGenerator<LogFile> {
  const projects = (await directories(root, diag)).filter(entry => entry.isDirectory());
  const subagentDirs: string[] = [];
  for (const project of projects) {
    const projectDir = path.join(root, project.name);
    for (const entry of await directories(projectDir, diag)) {
      const filePath = path.join(projectDir, entry.name);
      if (entry.name.endsWith('.jsonl')) {
        if (entry.isFile()) yield { path: filePath, sessionId: entry.name.slice(0, -6) };
        else diag.skipped_non_regular_files++;
      }
      if (entry.isDirectory()) subagentDirs.push(filePath);
    }
  }
  for (const sessionDir of subagentDirs) {
    const agentsDir = path.join(sessionDir, 'subagents');
    try { if (!(await lstat(agentsDir)).isDirectory()) continue; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diag.unreadable_files++;
      continue;
    }
    for (const entry of await directories(agentsDir, diag)) {
      if (!entry.name.endsWith('.jsonl')) continue;
      if (!entry.isFile()) { diag.skipped_non_regular_files++; continue; }
      yield { path: path.join(agentsDir, entry.name), sessionId: path.basename(sessionDir), agentId: entry.name.slice(0, -6) };
    }
  }
}

async function* readObjects(file: LogFile, diag: UsageScanDiagnostics, end?: number): AsyncGenerator<JsonObject> {
  let handle: FileHandle | undefined;
  try {
    if (!(await lstat(file.path)).isFile()) { diag.skipped_non_regular_files++; return; }
    // Nonblocking plus fstat protects the lstat/open race from ever consuming a FIFO.
    handle = await open(file.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) { diag.skipped_non_regular_files++; return; }
    diag.files_scanned++;
    const size = Math.min(stat.size, end ?? stat.size);
    if (!size) return;
    const stream = handle.createReadStream({ encoding: 'utf8', autoClose: false, end: size - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const pause = yieldBudget(diag);
    try {
      for await (const line of lines) {
        const wait = pause();
        if (wait) await wait;
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line.replace(/^\0+/, '')); }
        catch { diag.invalid_lines++; continue; }
        if (!object(parsed)) { diag.invalid_lines++; continue; }
        yield parsed;
      }
    } finally { lines.close(); stream.destroy(); }
  } catch { diag.unreadable_files++; }
  finally { await handle?.close().catch(() => {}); }
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidUsage(usage: unknown): boolean {
  if (usage === undefined) return false;
  if (!object(usage)) return true;
  if (BASE_FIELDS.some(key => key in usage && !counter(usage[key]))) return true;
  const creation = usage.cache_creation;
  return creation !== undefined && creation !== null && (!object(creation) ||
    TTL_FIELDS.some(key => key in creation && !counter(creation[key])));
}

function pricingContext(usage: unknown): NonNullable<ResponseSnapshot['pricingContext']> {
  const result: NonNullable<ResponseSnapshot['pricingContext']> = { pricing_context_complete: false };
  if (!object(usage)) return result;
  let valid = true;
  for (const field of ['speed', 'inference_geo', 'service_tier'] as const) {
    if (!(field in usage)) { valid = false; continue; }
    const value = usage[field];
    if (field === 'speed') {
      result.speed = value === 'standard' || value === 'fast' ? value : null;
      valid &&= value === 'standard' || value === 'fast';
    } else {
      result[field] = typeof value === 'string' ? value : null;
      valid &&= field === 'inference_geo' ? value === '' || value === 'global' || value === 'us' : value === 'standard';
    }
  }
  const tools = usage.server_tool_use;
  if (tools !== undefined && tools !== null) {
    const search = object(tools) && counter(tools.web_search_requests) ? tools.web_search_requests : null;
    const fetch = object(tools) && counter(tools.web_fetch_requests) ? tools.web_fetch_requests : null;
    result.server_tool_use = { web_search_requests: search, web_fetch_requests: fetch };
    valid &&= search === 0 && fetch !== null;
  }
  if (usage.iterations !== undefined && usage.iterations !== null) valid &&= Array.isArray(usage.iterations) && usage.iterations.length === 0;
  result.pricing_context_complete = valid;
  return result;
}

function updateUsage(snapshot: ResponseSnapshot, message: JsonObject) {
  const final = typeof message.stop_reason === 'string' && message.stop_reason.length > 0;
  if (snapshot.final && !final) return;
  if (final && !snapshot.final) snapshot.counters = {};
  const usage = message.usage;
  snapshot.pricingContext = pricingContext(usage);
  let invalid = usage !== undefined && !object(usage);
  if (object(usage)) {
    for (const key of BASE_FIELDS) {
      if (!(key in usage)) continue;
      if (counter(usage[key])) snapshot.counters[key] = usage[key];
      else { delete snapshot.counters[key]; invalid = true; }
    }
    const creation = usage.cache_creation;
    if (creation !== undefined && creation !== null && !object(creation)) invalid = true;
    if (object(creation)) for (const key of TTL_FIELDS) {
      if (!(key in creation)) continue;
      if (counter(creation[key])) snapshot.counters[key] = creation[key];
      else { delete snapshot.counters[key]; invalid = true; }
    }
    if (snapshot.counters.output_tokens !== undefined) snapshot.maxOutput = Math.max(snapshot.maxOutput ?? 0, snapshot.counters.output_tokens);
  }
  if (final) {
    snapshot.final = true;
    snapshot.finalUsage = object(usage) && !invalid && counter(usage.input_tokens) && counter(usage.output_tokens);
  }
}

function sourceOwner(row: JsonObject, file: LogFile): Pick<ResponseOwner, 'sourceSessionId' | 'sourceRank'> {
  const fork = row.forkedFrom;
  if (object(fork) && typeof fork.sessionId === 'string' && fork.sessionId) {
    return { sourceSessionId: fork.sessionId, sourceRank: 2 };
  }
  const sourceSessionId = typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : file.sessionId;
  return { sourceSessionId, sourceRank: sourceSessionId === file.sessionId ? 0 : 1 };
}

function ownerBefore(a: ResponseOwner, b: ResponseOwner): boolean {
  if (a.time !== b.time) return a.time < b.time;
  if (a.sourceRank !== b.sourceRank) return a.sourceRank < b.sourceRank;
  if (!!a.file.agentId !== !!b.file.agentId) return !a.file.agentId;
  return a.file.path < b.file.path || (a.file.path === b.file.path && a.line < b.line);
}

function chooseOwner<T extends ResponseOwner>(a: T, b: T, selected?: Set<string>): T {
  const ambiguous = a.time === b.time && a.sourceRank === 0 && b.sourceRank === 0 &&
    a.sourceSessionId !== b.sourceSessionId;
  let chosen = ownerBefore(a, b) ? a : b;
  if (ambiguous && selected?.has(a.sourceSessionId) !== selected?.has(b.sourceSessionId)) {
    chosen = selected?.has(a.sourceSessionId) ? a : b;
  }
  if (ambiguous || (a.time === b.time && a.ownershipUnverified) || (a.time === b.time && b.ownershipUnverified)) {
    chosen.ownershipUnverified = true;
  }
  return chosen;
}

function strongerFinal(a: ResponseSnapshot, b: ResponseSnapshot | undefined): boolean {
  return a.final && a.finalUsage && (!b || a.maxOutput! > b.maxOutput! ||
    (a.maxOutput === b.maxOutput && ownerBefore(a, b)));
}

function toRecord(group: ResponseGroup, diag: UsageScanDiagnostics): CanonicalUsageRecord {
  const owner = group.owner;
  let chosen = owner;
  if (!owner.finalUsage && group.finalCopy && group.finalCopy.maxOutput! >= (owner.maxOutput ?? 0)) {
    chosen = group.finalCopy;
    diag.recovered_final_count++;
  }
  const c = chosen.counters;
  const hasTtl = TTL_FIELDS.every(key => c[key] !== undefined);
  const ttlConsistent = hasTtl && c.ephemeral_5m_input_tokens! + c.ephemeral_1h_input_tokens! === c.cache_creation_input_tokens;
  const ttlAbsent = TTL_FIELDS.every(key => c[key] === undefined);
  const solCacheTotal = owner.model === 'gpt-6-1-sol' && hasTtl && TTL_FIELDS.every(key => c[key] === 0);
  const complete = !owner.ownershipUnverified && owner.sourceRank === 0 && owner.model !== 'unknown' &&
    !['synthetic', '<synthetic>'].includes(owner.model) && chosen.final && chosen.finalUsage &&
    BASE_FIELDS.every(key => c[key] !== undefined) && group.maxOutput === c.output_tokens &&
    (ttlConsistent || solCacheTotal || (ttlAbsent && (c.cache_creation_input_tokens === 0 || owner.model.startsWith('gpt-'))));
  if (!complete) diag.incomplete_records++;
  return {
    responseId: owner.responseId, model: owner.model, sessionId: owner.sourceSessionId,
    ...(owner.file.agentId ? { agentId: owner.file.agentId } : {}), timestamp: new Date(owner.time).toISOString(),
    input_tokens: c.input_tokens ?? null, output_tokens: group.maxOutput ?? null,
    cache_creation_input_tokens: c.cache_creation_input_tokens ?? null, cache_read_input_tokens: c.cache_read_input_tokens ?? null,
    ...(hasTtl && !solCacheTotal ? { cache_creation: { ephemeral_5m_input_tokens: c.ephemeral_5m_input_tokens!, ephemeral_1h_input_tokens: c.ephemeral_1h_input_tokens! } } : {}),
    ...chosen.pricingContext,
    pricing_context_complete: chosen.finalUsage && chosen.pricingContext?.pricing_context_complete === true,
    complete,
  };
}

/** Converts one final owned response; folding/deduplication stay with the caller. An explicit observation time fills only a missing timestamp. */
export function canonicalRecordFromAssistant(
  row: unknown, fileMetadata: { sessionId: string; agentId?: string }, observedTimestamp?: string | Date,
): CanonicalUsageRecord | undefined {
  if (!object(row) || !object(row.message) || typeof row.message.model !== 'string' || !row.message.model.trim()) return;
  const candidate = { ...row,
    ...(row.sessionId === undefined && typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
    ...(row.timestamp === undefined && observedTimestamp !== undefined ? { timestamp: observedTimestamp } : {}),
  };
  const diag = diagnostics();
  const identity = responseIdentity(candidate, diag);
  if (!identity) return;
  const file = { path: '', ...fileMetadata }, source = sourceOwner(candidate, file);
  if (source.sourceRank !== 0) return;
  const snapshot: ResponseSnapshot = { file, time: identity.time, line: 0, ...source,
    responseId: identity.id, model: identity.model, counters: {}, maxOutput: undefined,
    final: false, finalUsage: false, lines: 0,
  };
  updateUsage(snapshot, identity.message);
  if (!snapshot.finalUsage) return;
  return toRecord({ owner: snapshot, maxOutput: snapshot.maxOutput }, diag);
}

const COST_FIELDS = ['totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalToolDuration',
  'totalLinesAdded', 'totalLinesRemoved', 'totalDuration', 'startTime'] as const;
const MODEL_COST_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'] as const;
const COST_LIMIT = 1e15;
function costNumber(value: unknown, limit = COST_LIMIT): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limit;
}

function costState(row: JsonObject, sessionId: string): CanonicalCostState | undefined {
  if (row.type !== 'cost-state' || row.sessionId !== sessionId || !costNumber(row.totalCostUSD, 1e9) ||
    !COST_FIELDS.every(key => costNumber(row[key])) || !object(row.modelUsage) ||
    (row.hasUnknownModelCost !== undefined && typeof row.hasUnknownModelCost !== 'boolean')) return;
  const sums = [0, 0, 0, 0];
  for (const [model, usage] of Object.entries(row.modelUsage)) {
    if (!/^[^\p{Cc}\p{Cf}]+$/u.test(model) || !object(usage) ||
      !MODEL_COST_FIELDS.every(key => costNumber(usage[key])) ||
      (usage.thinkingTokens !== undefined && !costNumber(usage.thinkingTokens))) return;
    for (let i = 0; i < 4; i++) {
      sums[i]! += usage[MODEL_COST_FIELDS[i]!] as number;
      if (sums[i]! > COST_LIMIT) return;
    }
  }
  const time = timestamp(row.timestamp);
  return { sessionId, totalCostUsd: row.totalCostUSD, ...(time !== undefined ? { timestamp: new Date(time).toISOString() } : {}),
    apiDurationMs: row.totalAPIDuration as number, durationMs: row.totalDuration as number };
}

function responseIdentity(row: JsonObject, diag: UsageScanDiagnostics): { key: string; id: string; model: string; time: number; message: JsonObject } | undefined {
  if (row.type !== 'assistant' || !object(row.message)) return;
  const message = row.message;
  if (typeof message.id !== 'string' || !message.id) { diag.missing_message_ids++; return; }
  const time = timestamp(row.timestamp);
  if (time === undefined) { diag.invalid_timestamps++; return; }
  const model = normalizeUsageModel(message.model), usage = message.usage;
  if (['synthetic', '<synthetic>'].includes(model) && (!object(usage) || BASE_FIELDS.every(key => !usage[key]))) return;
  return { key: JSON.stringify([model, message.id]), id: message.id, model, time, message };
}

type CanonicalScanResult = { records: CanonicalUsageRecord[]; diagnostics: UsageScanDiagnostics; costStates: CanonicalCostState[] };

export async function scanCanonicalUsage(options: CanonicalUsageScanOptions): Promise<CanonicalScanResult> {
  await assertRoot(options.projectsDir);
  const since = boundary(options.since, -Infinity), until = boundary(options.until, Infinity);
  if (since >= until) throw new Error('Usage since must precede until');
  const selected = options.sessionIds ? new Set(options.sessionIds) : undefined;
  const diag = diagnostics();
  return scanLogFiles(canonicalFiles(options.projectsDir, diag), diag, { since, until, selected });
}

/** What one session's files have been folded into so far, so a grown transcript is read from where the last read stopped. */
export interface SessionFoldState {
  files: Map<string, SessionFoldFile>;
}
interface SessionFoldFile {
  file: LogFile; ino: number; offset: number; line: number;
  /** The file's first bytes when folding began: different bytes mean it was rewritten in place. */
  head: string;
  snapshots: Map<string, ResponseSnapshot>; cost?: CanonicalCostState;
}

export function newSessionFoldState(): SessionFoldState { return { files: new Map() }; }

const NEWLINE = 10;
const CANDIDATES = [Buffer.from('"assistant"'), Buffer.from('"cost-state"')];
const CHUNK_BYTES = 4 * 1024 * 1024;

/** Start offsets of the complete lines in buf[0, end) that hold a candidate pattern, in order. */
function candidateLines(buf: Buffer, end: number): number[] {
  const starts = new Set<number>();
  for (const pattern of CANDIDATES) {
    let at = buf.indexOf(pattern, 0);
    while (at !== -1 && at < end) {
      const lineStart = buf.lastIndexOf(NEWLINE, at) + 1;
      starts.add(lineStart);
      const lineEnd = buf.indexOf(NEWLINE, at);
      if (lineEnd === -1) break;
      at = buf.indexOf(pattern, lineEnd + 1);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

function foldRow(entry: SessionFoldFile, row: JsonObject, sessionId: string, diag: UsageScanDiagnostics): void {
  const file = entry.file;
  entry.line++;
  if (!file.agentId) {
    const state = costState(row, sessionId);
    if (state) entry.cost = state;
  }
  const identity = responseIdentity(row, diag);
  if (!identity) return;
  const { key, id, model, time, message } = identity;
  if (invalidUsage(message.usage)) diag.invalid_usage++;
  let snapshot = entry.snapshots.get(key);
  if (!snapshot) {
    snapshot = { file, responseId: id, model, time, line: entry.line, ...sourceOwner(row, file), counters: {}, maxOutput: undefined, final: false, finalUsage: false, lines: 0 };
    entry.snapshots.set(key, snapshot);
  } else {
    diag.duplicate_usage_lines++;
    const candidate = { file, time, line: entry.line, ...sourceOwner(row, file) };
    if (ownerBefore(candidate, snapshot)) Object.assign(snapshot, candidate);
  }
  updateUsage(snapshot, message);
  snapshot.lines++;
}

function parseLine(buf: Buffer, start: number, end: number, diag: UsageScanDiagnostics): JsonObject | undefined {
  const text = buf.toString('utf8', start, end).replace(/^\0+/, '');
  if (!text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (object(parsed)) return parsed;
  } catch { /* counted below */ }
  diag.invalid_lines++;
  return undefined;
}

/** Folds the bytes a file gained since the last read (all of it after a rewrite). */
async function foldTail(state: SessionFoldState, file: LogFile, sessionId: string, diag: UsageScanDiagnostics,
  pause: () => Promise<void> | undefined, progress: { read: number }): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    if (!(await lstat(file.path)).isFile()) { diag.skipped_non_regular_files++; return; }
    handle = await open(file.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) { diag.skipped_non_regular_files++; return; }
    diag.files_scanned++;
    const headBuf = Buffer.alloc(Math.min(256, stat.size));
    if (headBuf.length) await handle.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('hex');
    let entry = state.files.get(file.path);
    const shared = Math.min(head.length, entry?.head.length ?? 0);
    if (!entry || entry.ino !== stat.ino || stat.size < entry.offset || head.slice(0, shared) !== entry.head.slice(0, shared)) {
      entry = { file, ino: stat.ino, offset: 0, line: 0, head, snapshots: new Map() };
      state.files.set(file.path, entry);
    }
    if (head.length > entry.head.length) entry.head = head;
    progress.read += entry.offset;
    let rest = Buffer.alloc(0);
    let position = entry.offset;
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      progress.read += bytesRead;
      const buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const complete = buf.lastIndexOf(NEWLINE) + 1;
      for (const start of candidateLines(buf, complete)) {
        const wait = pause();
        if (wait) await wait;
        const row = parseLine(buf, start, buf.indexOf(NEWLINE, start), diag);
        if (row) foldRow(entry, row, sessionId, diag);
      }
      entry.offset += complete;
      rest = Buffer.from(buf.subarray(complete));
    }
    // A last line without its newline may still be mid-write: fold it if it parses, and read it again next time.
    if (rest.length && CANDIDATES.some(p => rest.includes(p))) {
      const text = rest.toString('utf8');
      try {
        const row: unknown = JSON.parse(text);
        if (object(row)) { foldRow(entry, row, sessionId, diag); entry.line--; }
      } catch { /* still being written */ }
    }
  } catch { diag.unreadable_files++; }
  finally { await handle?.close().catch(() => {}); }
}

/**
 * The canonical fold over ONE session's own files (its transcript and its
 * subagent transcripts), in one pass and incrementally: pass the state back and
 * only the bytes the files gained are read. A response another session owns (a
 * fork's inherited history, a copied line) is dropped exactly as the full scan
 * drops it.
 */
export async function scanCanonicalSessionUsage(options: {
  sessionId: string; files: { path: string; agentId?: string }[]; state?: SessionFoldState;
  progress?: { read: number };
}): Promise<CanonicalScanResult & { state: SessionFoldState }> {
  const diag = diagnostics();
  const state = options.state ?? newSessionFoldState();
  const progress = options.progress ?? { read: 0 };
  const selected = new Set([options.sessionId]);
  const pause = yieldBudget(diag);
  const wanted = new Set(options.files.map(f => f.path));
  for (const known of [...state.files.keys()]) if (!wanted.has(known)) state.files.delete(known);
  for (const f of options.files) {
    const file: LogFile = { path: f.path, sessionId: options.sessionId, ...(f.agentId ? { agentId: f.agentId } : {}) };
    await foldTail(state, file, options.sessionId, diag, pause, progress);
  }
  const groups = new Map<string, ResponseGroup>();
  for (const entry of state.files.values()) {
    for (const [key, stored] of entry.snapshots) {
      const wait = pause();
      if (wait) await wait;
      // chooseOwner marks its pick; keep the stored snapshot clean for the next fold.
      const snapshot = { ...stored };
      const group = groups.get(key);
      if (!group) groups.set(key, { owner: snapshot, maxOutput: snapshot.maxOutput, ...(snapshot.finalUsage ? { finalCopy: snapshot } : {}) });
      else {
        if (snapshot.maxOutput !== undefined) group.maxOutput = Math.max(group.maxOutput ?? 0, snapshot.maxOutput);
        if (JSON.stringify(group.owner.counters) !== JSON.stringify(snapshot.counters)) diag.changed_usage_duplicates++;
        group.owner = chooseOwner(snapshot, group.owner, selected);
        if (strongerFinal(snapshot, group.finalCopy)) group.finalCopy = snapshot;
      }
    }
  }
  const records: CanonicalUsageRecord[] = [];
  for (const group of groups.values()) {
    if (!selected.has(group.owner.sourceSessionId)) continue;
    records.push(toRecord(group, diag));
  }
  const costStates: CanonicalCostState[] = [];
  for (const entry of state.files.values()) if (!entry.file.agentId && entry.cost) costStates.push(entry.cost);
  return { records, diagnostics: diag, costStates, state };
}

async function scanLogFiles(source: AsyncIterable<LogFile>, diag: UsageScanDiagnostics, scope: {
  since: number; until: number; selected?: Set<string>;
}): Promise<CanonicalScanResult> {
  const { since, until, selected } = scope;
  const costs = new Map<string, CanonicalCostState>();
  // Historical identities need only their earliest timestamp, not counters or copied content.
  const owners = new Map<string, ResponseOwner | number>();
  const files: { file: LogFile; size: number }[] = [];
  const pause = yieldBudget(diag);
  for await (const file of source) {
    let size: number;
    try { size = (await lstat(file.path)).size; } catch { diag.unreadable_files++; continue; }
    files.push({ file, size });
    let line = 0;
    for await (const row of readObjects(file, diag, size)) {
      line++;
      if (!file.agentId) {
        const state = costState(row, file.sessionId);
        if (state) costs.set(file.sessionId, state);
      }
      const identity = responseIdentity(row, diag);
      if (!identity) continue;
      const { key, time } = identity;
      if (invalidUsage(identity.message.usage)) diag.invalid_usage++;
      const owner = owners.get(key), candidate = { file, time, line, ...sourceOwner(row, file) };
      if (owner !== undefined) diag.duplicate_usage_lines++;
      if (owner === undefined || (typeof owner === 'number' && time < owner)) {
        owners.set(key, time < since || time >= until ? time : candidate);
      } else if (typeof owner !== 'number') {
        const chosen = chooseOwner(candidate, owner, selected);
        owners.set(key, chosen.time < since || chosen.time >= until ? chosen.time : chosen);
      }
    }
  }
  for (const [key, owner] of owners) {
    const wait = pause();
    if (wait) await wait;
    if (typeof owner === 'number' || owner.time >= until || (selected && !selected.has(owner.sourceSessionId))) owners.delete(key);
  }
  const groups = new Map<string, ResponseGroup>();
  const secondPass = diagnostics();
  if (owners.size) for (const { file, size } of files) {
    const local = new Map<string, ResponseSnapshot>();
    let line = 0;
    for await (const row of readObjects(file, secondPass, size)) {
      line++;
      const identity = responseIdentity(row, secondPass);
      if (!identity || !owners.has(identity.key)) continue;
      const { key, id, model, time, message } = identity;
      let snapshot = local.get(key);
      if (!snapshot) {
        snapshot = { file, responseId: id, model, time, line, ...sourceOwner(row, file), counters: {}, maxOutput: undefined, final: false, finalUsage: false, lines: 0 };
        local.set(key, snapshot);
      } else {
        const candidate = { file, time, line, ...sourceOwner(row, file) };
        if (ownerBefore(candidate, snapshot)) Object.assign(snapshot, candidate);
      }
      const before = JSON.stringify(snapshot.counters);
      updateUsage(snapshot, message);
      if (snapshot.lines && before !== JSON.stringify(snapshot.counters)) diag.changed_usage_duplicates++;
      snapshot.lines++;
    }
    for (const [key, snapshot] of local) {
      const wait = pause();
      if (wait) await wait;
      const group = groups.get(key);
      if (!group) groups.set(key, { owner: snapshot, maxOutput: snapshot.maxOutput, ...(snapshot.finalUsage ? { finalCopy: snapshot } : {}) });
      else {
        if (snapshot.maxOutput !== undefined) group.maxOutput = Math.max(group.maxOutput ?? 0, snapshot.maxOutput);
        if (JSON.stringify(group.owner.counters) !== JSON.stringify(snapshot.counters)) diag.changed_usage_duplicates++;
        group.owner = chooseOwner(snapshot, group.owner, selected);
        if (strongerFinal(snapshot, group.finalCopy)) group.finalCopy = snapshot;
      }
    }
  }
  diag.yields += secondPass.yields;
  diag.unreadable_files += secondPass.unreadable_files;
  const records: CanonicalUsageRecord[] = [];
  for (const [key, group] of groups) {
    const wait = pause();
    if (wait) await wait;
    const owner = owners.get(key) as ResponseOwner;
    if (group.owner.file.path !== owner.file.path || group.owner.time !== owner.time) continue;
    group.owner.ownershipUnverified ||= owner.ownershipUnverified;
    records.push(toRecord(group, diag));
  }
  return { records, diagnostics: diag, costStates: [...costs.values()].filter(state => !selected || selected.has(state.sessionId)) };
}

export async function scanCostState(options: { projectsDir: string; sessionId: string; cwd?: string }): Promise<CanonicalCostState | undefined> {
  if (!options.sessionId || path.basename(options.sessionId) !== options.sessionId || options.sessionId === '..') {
    throw new Error('Cost-state session ID must be a filename component');
  }
  await assertRoot(options.projectsDir);
  const diag = diagnostics();
  const projects = (await directories(options.projectsDir, diag)).filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (options.cwd) {
    const canonical = (await realpath(options.cwd).catch(() => options.cwd!)).normalize('NFC');
    const name = canonical.replace(/[^a-zA-Z0-9]/g, '-');
    const index = projects.findIndex(project => project === name || (name.length > 200 && project.startsWith(`${name.slice(0, 200)}-`)));
    if (index > 0) projects.unshift(...projects.splice(index, 1));
  }
  for (const project of projects) {
    const file = { path: path.join(options.projectsDir, project, `${options.sessionId}.jsonl`), sessionId: options.sessionId };
    try { const stat = await lstat(file.path); if (!stat.isFile() || !stat.size) continue; } catch { continue; }
    let latest: CanonicalCostState | undefined;
    for await (const row of readObjects(file, diag)) latest = costState(row, file.sessionId) ?? latest;
    return latest;
  }
  return undefined;
}

/**
 * The fold's own pieces, for the host scan's file index (usage-scan-index.ts),
 * so an indexed scan decides owners and counters with exactly these rules.
 */
export const scanFold = {
  diagnostics, yieldBudget, assertRoot, boundary, object, canonicalFiles, candidateLines, parseLine, responseIdentity,
  invalidUsage, sourceOwner, ownerBefore, chooseOwner, updateUsage, strongerFinal, toRecord, NEWLINE, CANDIDATES, CHUNK_BYTES,
};
export type { LogFile as ScanLogFile, ResponseSnapshot as ScanSnapshot, ResponseOwner as ScanOwner, ResponseGroup as ScanGroup, CanonicalScanResult };
