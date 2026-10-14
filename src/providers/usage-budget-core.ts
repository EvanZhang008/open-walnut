import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { priceReconciledUsage, PRICING_VERSION } from '../core/usage/pricing.js';
import { normalizeUsageModel, type CanonicalUsageRecord } from './usage-scan-core.js';
import type { ProxyUsageRecord, UsageVerification } from './usage-reconcile-core.js';
import { createBudgetPersistence } from './usage-budget-persistence.js';

export interface BudgetState {
  limitUsd: number | null;
  spentUsd: number | null;
  state: 'unlimited' | 'active' | 'paused' | 'unverified';
  reason: string | null;
  revision: number;
  updatedAt: string | null;
  stopError?: string | null;
}
export type BudgetUsageRecord = CanonicalUsageRecord & {
  verification: UsageVerification;
  upstream?: ProxyUsageRecord;
};
export interface BudgetBaseline { records: BudgetUsageRecord[]; complete: boolean }
export interface BudgetConfiguration {
  limitUsd: number | null;
  /** Expected current policy revision, not an evidence revision. */
  revision: number;
  baseline?: BudgetBaseline;
}
export interface BudgetUsageGroup {
  name: string; calls: number; verifiedCalls: number; unverifiedCalls: number; costUsd: number | null;
}
export interface BudgetSummary {
  budget: BudgetState; verifiedCalls: number; unverifiedCalls: number;
  byModel: BudgetUsageGroup[]; byAgent: BudgetUsageGroup[];
}
export interface BudgetResponseEvidence {
  model: string;
  responseId: string;
  verification: UsageVerification;
  costUsd: number | null;
  pricingVersion: string;
  record: BudgetUsageRecord;
}
interface Policy {
  limitUsd: number | null;
  revision: number;
  baselineComplete: boolean;
  unverifiedReason: string | null;
  stopError: string | null;
}
interface Aggregate { calls: number; verifiedCalls: number; unknownCount: number; cost: number; compensation: number }
interface StoredBudget extends Policy {
  sequence: number;
  updatedAt: string | null;
  knownSubtotalUsd: number;
  compensation: number;
  unknownCount: number;
  verifiedCalls: number;
  byModel: Map<string, Aggregate>;
  byAgent: Map<string, Aggregate>;
  responses: Map<string, BudgetResponseEvidence>;
}
type EventData = { version: 2; updatedAt: string } & (
  { kind: 'policy'; policy: Policy } | { kind: 'response'; entry: BudgetResponseEvidence });
type Event = EventData & { sequence: number };

// The owning daemon is the sole process writer; handles share ordering and loaded state.
const pending = new Map<string, Promise<void>>(), loaded = new Map<string, StoredBudget>();
function serialized<T>(file: string, action: () => Promise<T>): Promise<T> {
  const result = (pending.get(file) ?? Promise.resolve()).then(action);
  const settled = result.then(() => {}, () => {});
  pending.set(file, settled);
  void settled.then(() => { if (pending.get(file) === settled) pending.delete(file); });
  return result;
}
function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function validLimit(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0.01);
}
function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function identity(entry: { model: string; responseId: string }): string { return JSON.stringify([entry.model, entry.responseId]); }
function policy(data: StoredBudget): Policy {
  return { limitUsd: data.limitUsd, revision: data.revision, baselineComplete: data.baselineComplete,
    unverifiedReason: data.unverifiedReason, stopError: data.stopError };
}
function emptyBudget(): StoredBudget {
  return { limitUsd: null, revision: 0, updatedAt: null, sequence: 0, baselineComplete: false,
    unverifiedReason: null, stopError: null, knownSubtotalUsd: 0, compensation: 0, unknownCount: 0,
    verifiedCalls: 0, byModel: new Map(), byAgent: new Map(), responses: new Map() };
}
function validPolicy(value: unknown): value is Policy {
  return object(value) && validLimit(value.limitUsd) && validRevision(value.revision)
    && typeof value.baselineComplete === 'boolean'
    && (value.unverifiedReason === null || typeof value.unverifiedReason === 'string')
    && (value.stopError === null || typeof value.stopError === 'string');
}
function validEntry(value: unknown, sid: string): value is BudgetResponseEvidence {
  return object(value) && typeof value.model === 'string' && !!value.model
    && typeof value.responseId === 'string' && !!value.responseId
    && ['matched', 'unmatched', 'incomplete'].includes(value.verification as string)
    && typeof value.pricingVersion === 'string' && object(value.record)
    && value.record.responseId === value.responseId && value.record.model === value.model
    && value.record.verification === value.verification && value.record.sessionId === sid
    && (value.costUsd === null || (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd)
      && value.costUsd >= 0 && value.verification === 'matched'));
}
function verified(entry: BudgetResponseEvidence): boolean {
  return entry.verification === 'matched' && entry.costUsd !== null && entry.pricingVersion === PRICING_VERSION;
}
function addCost(data: StoredBudget, delta: number): void {
  const next = delta - data.compensation, total = data.knownSubtotalUsd + next;
  data.compensation = (total - data.knownSubtotalUsd) - next;
  data.knownSubtotalUsd = total;
}
function adjustGroup(groups: Map<string, Aggregate>, name: string, entry: BudgetResponseEvidence, direction: 1 | -1): void {
  const group = groups.get(name) ?? { calls: 0, verifiedCalls: 0, unknownCount: 0, cost: 0, compensation: 0 };
  group.calls += direction;
  if (verified(entry)) {
    group.verifiedCalls += direction;
    const next = direction * entry.costUsd! - group.compensation, total = group.cost + next;
    group.compensation = (total - group.cost) - next; group.cost = total;
    if (group.verifiedCalls === 0) { group.cost = 0; group.compensation = 0; }
  } else group.unknownCount += direction;
  if (group.calls === 0) groups.delete(name); else groups.set(name, group);
}
function adjust(data: StoredBudget, entry: BudgetResponseEvidence, direction: 1 | -1): void {
  if (verified(entry)) {
    data.verifiedCalls += direction; addCost(data, direction * entry.costUsd!);
    if (data.verifiedCalls === 0) { data.knownSubtotalUsd = 0; data.compensation = 0; }
  } else data.unknownCount += direction;
  adjustGroup(data.byModel, entry.model, entry, direction);
  adjustGroup(data.byAgent, entry.record.agentId ? 'subagent' : 'main', entry, direction);
}
function apply(data: StoredBudget, event: Event): void {
  if (event.kind === 'policy') Object.assign(data, event.policy);
  else {
    const key = identity(event.entry), previous = data.responses.get(key);
    if (previous) adjust(data, previous, -1);
    data.responses.set(key, event.entry); adjust(data, event.entry, 1);
  }
  data.sequence = event.sequence; data.updatedAt = event.updatedAt;
}
async function regular(file: string, flags: number) {
  const handle = await fs.open(file, flags, 0o600);
  if (!(await handle.stat()).isFile()) { await handle.close(); throw failure('BUDGET_CORRUPT', 'Usage budget must be a regular file'); }
  return handle;
}
async function load(file: string, sid: string): Promise<StoredBudget> {
  const cached = loaded.get(file); if (cached) return cached;
  const data = emptyBudget();
  let marker: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    marker = await regular(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const value = JSON.parse(await marker.readFile('utf8')) as unknown;
    if (!object(value) || value.version !== 2 || value.journal !== path.basename(`${file}l`)) {
      throw failure('BUDGET_CORRUPT', 'Stored usage budget marker is invalid');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const orphan = await fs.lstat(`${file}l`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (orphan && (!orphan.isFile() || orphan.size > 0)) throw failure('BUDGET_CORRUPT', 'Usage budget journal has no marker');
      loaded.set(file, data); return data;
    }
    if (error instanceof SyntaxError) throw failure('BUDGET_CORRUPT', 'Stored usage budget marker is invalid JSON');
    throw error;
  } finally { await marker?.close(); }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await regular(`${file}l`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const size = (await handle.stat()).size;
    if (size) {
      const tail = Buffer.alloc(1); await handle.read(tail, 0, 1, size - 1);
      if (tail[0] !== 10) throw failure('BUDGET_CORRUPT', 'Usage budget journal has an incomplete final event');
      const stream = handle.createReadStream({ encoding: 'utf8', autoClose: false, end: size - 1 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let readError: Error | undefined, cpu = process.cpuUsage();
      stream.on('error', error => { readError = error; lines.close(); });
      try {
        for await (const line of lines) {
          let event: unknown;
          try { event = JSON.parse(line); } catch { throw failure('BUDGET_CORRUPT', 'Usage budget journal has an invalid event'); }
          if (!object(event) || event.version !== 2 || event.sequence !== data.sequence + 1
            || typeof event.updatedAt !== 'string' || !Number.isFinite(Date.parse(event.updatedAt))
            || (event.kind !== 'policy' && event.kind !== 'response')
            || (event.kind === 'policy' ? !validPolicy(event.policy) : !validEntry(event.entry, sid))) {
            throw failure('BUDGET_CORRUPT', 'Usage budget journal sequence or evidence is invalid');
          }
          apply(data, event as Event);
          const usage = process.cpuUsage(cpu);
          if (usage.user + usage.system >= 5_000) { await setImmediate(); cpu = process.cpuUsage(); }
        }
        if (readError) throw readError;
      } finally { lines.close(); stream.destroy(); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw failure('BUDGET_CORRUPT', 'Usage budget journal is missing');
    throw error;
  } finally { await handle?.close(); }
  loaded.set(file, data); return data;
}
const syncedMarkers = new Set<string>();
async function syncDirectory(dir: string): Promise<void> {
  const directory = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}
const persistence = createBudgetPersistence(fs, path);
export const durableBudgetDirectory = persistence.ensureDirectory;
export const ensureUsageBudgetDirectory = durableBudgetDirectory;
async function ensureMarker(file: string): Promise<void> {
  await durableBudgetDirectory(path.dirname(file));
  let exists = false;
  try { await fs.lstat(file); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists && syncedMarkers.has(file)) return;
  if (!exists) {
    // The journal is authoritative; the small atomic marker only enables discovery.
    const journal = await regular(`${file}l`, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await journal.chmod(0o600); await journal.close();
    const temp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temp, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify({ version: 2, journal: path.basename(`${file}l`) })); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  await syncDirectory(path.dirname(file));
  syncedMarkers.add(file);
}
async function append(file: string, data: StoredBudget, events: AsyncIterable<EventData>): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await ensureMarker(file);
    handle = await regular(`${file}l`, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let sequence = data.sequence;
    // Apply only after the whole batch is durable. Failure discards the cache and replays disk.
    const committed: Event[] = [];
    for await (const item of events) {
      if (!Number.isSafeInteger(sequence + 1)) throw failure('BUDGET_CORRUPT', 'Usage budget journal sequence is exhausted');
      const event = { ...item, sequence: ++sequence } as Event;
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      committed.push(event);
      if (committed.length % 100 === 0) await setImmediate();
    }
    await handle.sync();
    for (const [index, event] of committed.entries()) { apply(data, event); if (index % 100 === 99) await setImmediate(); }
  } catch (error) { loaded.delete(file); throw error; }
  finally { await handle?.close(); }
}
function evidence(sid: string, record: BudgetUsageRecord): BudgetResponseEvidence {
  if (!record || record.sessionId !== sid || typeof record.responseId !== 'string' || !record.responseId
    || typeof record.model !== 'string' || !record.model.trim()
    || !['matched', 'unmatched', 'incomplete'].includes(record.verification)) {
    throw failure('BUDGET_INVALID_EVIDENCE', 'Usage evidence must belong to this session and identify a response');
  }
  const model = normalizeUsageModel(record.model);
  const priced = record.complete === true && record.verification === 'matched'
    && typeof record.input_tokens === 'number' && typeof record.output_tokens === 'number'
    && typeof record.cache_creation_input_tokens === 'number' && typeof record.cache_read_input_tokens === 'number'
    ? priceReconciledUsage({ ...record, model, forwardedModel: record.upstream?.forwardedModel ?? null,
      input_tokens: record.input_tokens, output_tokens: record.output_tokens,
      cache_creation_input_tokens: record.cache_creation_input_tokens, cache_read_input_tokens: record.cache_read_input_tokens }) : null;
  const stored: Record<string, unknown> = { model };
  for (const key of ['responseId', 'sessionId', 'agentId', 'timestamp', 'input_tokens', 'output_tokens',
    'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_creation', 'speed', 'inference_geo',
    'service_tier', 'server_tool_use', 'pricing_context_complete', 'complete', 'verification'] as const) {
    if (record[key] !== undefined) stored[key] = record[key];
  }
  if (record.upstream) {
    const upstream: Record<string, unknown> = {};
    for (const key of ['source', 'requestId', 'evidenceId', 'sessionId', 'model', 'requestedModel', 'responseModel',
      'forwardedModel', 'startedMs', 'finishedMs', 'usagePresent', 'complete', 'fileIndex', 'lineNumber',
      'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) upstream[key] = record.upstream[key];
    stored.upstream = upstream;
  }
  return { model, responseId: record.responseId, verification: record.verification,
    costUsd: priced?.costUsd ?? null, pricingVersion: PRICING_VERSION,
    record: structuredClone(stored) as unknown as BudgetUsageRecord };
}
function state(data: StoredBudget): BudgetState {
  const known = data.baselineComplete && data.unverifiedReason === null && data.unknownCount === 0
    && Number.isFinite(data.knownSubtotalUsd);
  const spentUsd = known ? data.knownSubtotalUsd : null;
  const result: BudgetState = { limitUsd: data.limitUsd, spentUsd, state: 'unlimited', reason: null,
    revision: data.revision, updatedAt: data.updatedAt, stopError: data.stopError };
  if (data.stopError !== null) { result.state = spentUsd === null ? 'unverified' : 'paused'; result.reason = 'stop_failed'; }
  else if (data.limitUsd !== null) {
    result.state = spentUsd === null ? 'unverified' : spentUsd >= data.limitUsd ? 'paused' : 'active';
    result.reason = spentUsd === null ? data.unverifiedReason ?? 'cost_unverified' : result.state === 'paused' ? 'budget_limit' : null;
  }
  return result;
}
async function* one(event: EventData) { yield event; }

/** Lifetime journal is Walnut-owned and independent of process and resume registries. */
export function createUsageBudgets(options: { dir: string; now?: () => number }) {
  const dir = path.resolve(options.dir), now = options.now ?? Date.now;
  function file(sid: string): string {
    if (typeof sid !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sid)) {
      throw failure('BUDGET_INVALID_SESSION', 'Budget session ID must be a safe filename component');
    }
    return path.join(dir, `${sid}.json`);
  }
  const time = () => new Date(now()).toISOString();
  const eventPolicy = (value: Policy) => ({ version: 2 as const, kind: 'policy' as const, updatedAt: time(), policy: value });
  async function setPolicy(name: string, data: StoredBudget, value: Policy): Promise<void> {
    if (JSON.stringify(policy(data)) !== JSON.stringify(value)) await append(name, data, one(eventPolicy(value)));
  }
  async function baseline(name: string, sid: string, data: StoredBudget, value: BudgetBaseline): Promise<void> {
    if (!Array.isArray(value.records) || typeof value.complete !== 'boolean') throw failure('BUDGET_INVALID_EVIDENCE', 'Budget baseline must include records and completeness');
    // A failed batch must never leave historical coverage marked complete.
    await setPolicy(name, data, { ...policy(data), baselineComplete: false });
    const updatedAt = time();
    async function* changes() {
      let count = 0;
      for (const raw of value.records) {
        const entry = evidence(sid, raw);
        if (JSON.stringify(data.responses.get(identity(entry))) !== JSON.stringify(entry)) {
          yield { version: 2 as const, kind: 'response' as const, updatedAt, entry };
        }
        if (++count % 100 === 0) await setImmediate();
      }
    }
    await append(name, data, changes());
    await setPolicy(name, data, { ...policy(data), baselineComplete: value.complete,
      unverifiedReason: value.complete ? null : data.unverifiedReason });
  }
  return {
    async read(sid: string): Promise<BudgetState> {
      const name = file(sid); return serialized(name, async () => state(await load(name, sid)));
    },
    async configure(sid: string, configuration: BudgetConfiguration): Promise<BudgetState> {
      const name = file(sid), { limitUsd, revision } = configuration, source = configuration.baseline;
      if (!validLimit(limitUsd)) throw failure('BUDGET_INVALID_LIMIT', 'Budget limit must be null or at least 0.01 USD');
      if (!validRevision(revision)) throw failure('BUDGET_INVALID_REVISION', 'Budget revision must be a nonnegative safe integer');
      const copy = source ? { complete: source.complete, records: source.records.slice() } : undefined;
      return serialized(name, async () => {
        const data = await load(name, sid);
        if (revision !== data.revision) throw failure('BUDGET_CONFLICT', 'Budget policy revision changed');
        if (!Number.isSafeInteger(data.revision + 1)) throw failure('BUDGET_INVALID_REVISION', 'Budget revision is exhausted');
        if (copy) await baseline(name, sid, data, copy);
        await setPolicy(name, data, { ...policy(data), limitUsd, revision: revision + 1 });
        return state(data);
      });
    },
    async observe(sid: string, observation: { record: BudgetUsageRecord }): Promise<BudgetState> {
      const name = file(sid), entry = evidence(sid, observation.record);
      return serialized(name, async () => {
        const data = await load(name, sid), previous = data.responses.get(identity(entry));
        if (JSON.stringify(previous) === JSON.stringify(entry)) return state(data);
        await append(name, data, one({ version: 2, kind: 'response', updatedAt: time(), entry }));
        if (data.unverifiedReason === 'cost_unverified' && previous?.costUsd === null && verified(entry)) {
          await setPolicy(name, data, { ...policy(data), unverifiedReason: null });
        }
        return state(data);
      });
    },
    async replaceBaseline(sid: string, source: BudgetBaseline): Promise<BudgetState> {
      const name = file(sid), copy = { complete: source.complete, records: source.records.slice() };
      return serialized(name, async () => { const data = await load(name, sid); await baseline(name, sid, data, copy); return state(data); });
    },
    async pauseUnverified(sid: string, reason = 'cost_unverified'): Promise<BudgetState> {
      const name = file(sid);
      if (typeof reason !== 'string' || !reason) throw new TypeError('Unverified budget reason must not be empty');
      return serialized(name, async () => { const data = await load(name, sid);
        await setPolicy(name, data, { ...policy(data), unverifiedReason: reason }); return state(data); });
    },
    async clearCoverageHold(sid: string, reason: string): Promise<BudgetState> {
      const name = file(sid);
      if (typeof reason !== 'string' || !reason) throw new TypeError('Coverage hold reason must not be empty');
      return serialized(name, async () => { const data = await load(name, sid);
        if (data.unverifiedReason === reason) await setPolicy(name, data, { ...policy(data), unverifiedReason: null });
        return state(data); });
    },
    async listConfigured(): Promise<string[]> {
      let files: string[];
      try { files = await fs.readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const result: string[] = [];
      for (const entry of files) {
        if (!entry.endsWith('.json')) continue;
        const sid = entry.slice(0, -5); let name: string;
        try { name = file(sid); } catch { continue; }
        try { if (!(await fs.lstat(name)).isFile()) continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if ((await serialized(name, () => load(name, sid))).limitUsd !== null) result.push(sid);
      }
      return result.sort();
    },
    async records(sid: string): Promise<BudgetUsageRecord[]> {
      const name = file(sid); return serialized(name, async () => {
        const data = await load(name, sid), records: BudgetUsageRecord[] = []; let count = 0;
        for (const entry of data.responses.values()) { records.push(structuredClone(entry.record)); if (++count % 100 === 0) await setImmediate(); }
        return records;
      });
    },
    async summaries(sid: string): Promise<BudgetSummary> {
      const name = file(sid); return serialized(name, async () => {
        const data = await load(name, sid);
        const groups = (source: Map<string, Aggregate>): BudgetUsageGroup[] => [...source].map(([name, value]) => ({
          name, calls: value.calls, verifiedCalls: value.verifiedCalls, unverifiedCalls: value.unknownCount,
          costUsd: value.unknownCount || !Number.isFinite(value.cost) ? null : Math.max(0, value.cost),
        }));
        return { budget: state(data), verifiedCalls: data.verifiedCalls, unverifiedCalls: data.unknownCount,
          byModel: groups(data.byModel), byAgent: groups(data.byAgent) };
      });
    },
    async snapshot(sid: string): Promise<{ budget: BudgetState; records: BudgetResponseEvidence[]; baselineComplete: boolean; knownSubtotalUsd: number }> {
      const name = file(sid); return serialized(name, async () => {
        const data = await load(name, sid), records: BudgetResponseEvidence[] = []; let count = 0;
        for (const entry of data.responses.values()) { records.push(structuredClone(entry)); if (++count % 100 === 0) await setImmediate(); }
        return { budget: state(data), records, baselineComplete: data.baselineComplete, knownSubtotalUsd: data.knownSubtotalUsd };
      });
    },
    async markStopError(sid: string, error: string | null): Promise<BudgetState> {
      const name = file(sid);
      if (error !== null && typeof error !== 'string') throw new TypeError('Budget stop error must be a string or null');
      return serialized(name, async () => { const data = await load(name, sid);
        await setPolicy(name, data, { ...policy(data), stopError: error }); return state(data); });
    },
  };
}
