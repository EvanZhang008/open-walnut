import fs from 'node:fs/promises';
import path from 'node:path';
import { scanCanonicalUsage, scanCostState } from './usage-scan-core.js';
import { scanCanonicalUsageIndexed, usageIndexPath } from './usage-scan-index.js';
import { scanProxyUsage, reconcileUsageAsync } from './usage-reconcile-core.js';
import { setImmediate } from 'node:timers/promises';
import { priceUsage } from '../core/usage/pricing.js';

export interface UsageScanRequest {
  projectsDir: string;
  proxyLogDir?: string;
  since?: string;
  until: string;
  sessionIds?: string[];
  lifetime?: boolean;
  /** Where the host keeps its transcript file index (usage-scan-index.ts); unset: read every file. */
  indexDir?: string;
}

const NEAR_MS = 10 * 60_000;

export async function scanHostUsage(request: UsageScanRequest) {
  const since = request.since === undefined ? undefined : Date.parse(request.since);
  const until = Date.parse(request.until);
  if ((since !== undefined && !Number.isFinite(since)) || !Number.isFinite(until)
    || (since !== undefined && since > until)) throw new RangeError('Invalid usage collection window');
  const files: string[] = [];
  if (request.proxyLogDir) {
    try {
      for (const name of await fs.readdir(request.proxyLogDir)) {
        if (name === 'proxy.log' || /^proxy\.log\.\d{4}-\d{2}-\d{2}$/.test(name)) {
          // A log rotated three days before the window opens holds none of its requests
          // (by the date in its name: a copied file's mtime is not to be trusted).
          const rotated = name.slice('proxy.log.'.length);
          if (since !== undefined && rotated && Date.parse(`${rotated}T00:00:00Z`) < since - 3 * 86_400_000) continue;
          files.push(path.join(request.proxyLogDir, name));
        }
      }
    } catch { /* Missing evidence stays unverified. */ }
  }
  const upstream = await scanProxyUsage({ files, sessionIds: request.sessionIds });
  // Requests ten minutes or more outside the window cannot compete for one of its
  // responses; keeping them would stretch the transcript read back by days.
  if (since !== undefined && !request.lifetime) {
    upstream.records = upstream.records.filter(r => (r.finishedMs ?? r.startedMs) >= since - NEAR_MS && r.startedMs < until + NEAR_MS);
  }
  let retainedSince = since;
  let retainedUntil = since === until ? until + 1 : until;
  // Retain every competitor before clipping; proxy compatibility includes its right endpoint.
  for (const record of upstream.records) {
    if (retainedSince !== undefined) retainedSince = Math.min(retainedSince, record.startedMs - 5_000);
    retainedUntil = Math.max(retainedUntil, (record.finishedMs ?? record.startedMs) + 5_000 + 1);
  }
  const retainedEnd = new Date(retainedUntil);
  const window = { ...request,
    since: request.lifetime || retainedSince === undefined ? undefined : new Date(retainedSince),
    until: request.lifetime ? undefined : Number.isFinite(retainedEnd.getTime()) ? retainedEnd : undefined,
  };
  const indexed = request.indexDir && !request.lifetime
    ? await scanCanonicalUsageIndexed({ ...window, indexPath: usageIndexPath(request.indexDir, request.projectsDir) })
    : undefined;
  const canonical = indexed ?? await scanCanonicalUsage(window);
  const scoped = await reconcileUsageAsync(canonical.records, upstream.records, request.lifetime ? {} : { since, until });
  const used = new Set<typeof upstream.records[number]>();
  for (const [index, record] of scoped.records.entries()) {
    if (record.upstream) used.add(record.upstream);
    if (index % 100 === 99) await setImmediate();
  }
  const inWindow: typeof upstream.records = [];
  for (const [index, record] of upstream.records.entries()) {
    if (request.lifetime || used.has(record) || ((since === undefined || record.startedMs >= since) && record.startedMs < until)) inWindow.push(record);
    if (index % 100 === 99) await setImmediate();
  }
  return { canonical: { ...canonical, records: scoped.records }, upstream: { ...upstream, records: inWindow },
    reconciliation: scoped, until: request.until, ...(indexed ? { scan: indexed.scan } : {}) };
}

export function createUsagePages() {
  const jobs = new Map<string, { result: Awaited<ReturnType<typeof scanHostUsage>>; expiresAt: number }>();
  function page(key: string, offset = 0) {
    for (const [key, job] of jobs) if (job.expiresAt < Date.now()) jobs.delete(key);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid usage page offset');
    const result = jobs.get(key)?.result;
    if (!result) throw new Error('Usage collection expired; check sources again.');
    const records = result.reconciliation.records.slice(offset, offset + 500);
    const end = offset + records.length;
    const done = end >= result.reconciliation.records.length;
    const evidence = { ...result, canonical: { ...result.canonical, records: [], costStates: [] }, upstream: { ...result.upstream, records: [],
      recordCount: result.upstream.records.length }, reconciliation: { ...result.reconciliation, records,
      upstreamUnmatched: [], unmatchedCount: result.reconciliation.upstreamUnmatched.length,
      responseCount: result.reconciliation.records.length,
      matchedCount: result.reconciliation.records.filter(r => r.verification === 'matched').length } };
    if (done) jobs.delete(key);
    return { result: evidence, key, offset: end, done };
  }
  return {
    put(result: Awaited<ReturnType<typeof scanHostUsage>>) {
      if (jobs.size >= 2) jobs.delete(jobs.keys().next().value!);
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      jobs.set(key, { result, expiresAt: Date.now() + 15 * 60_000 });
      setTimeout(() => jobs.delete(key), 15 * 60_000).unref();
      return page(key);
    }, page,
  };
}

export { scanCostState, priceUsage };
export { scanSessionCost, SESSION_COST_DAY_SPLIT } from './session-cost-core.js';
export { createUsageBudgetRuntime } from './usage-budget-runtime.js';
export { createBudgetControl } from './usage-budget-control.js';
