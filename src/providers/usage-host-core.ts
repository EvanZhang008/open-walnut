import fs from 'node:fs/promises';
import path from 'node:path';
import { scanCanonicalUsage, scanCostState } from './usage-scan-core.js';
import { scanProxyUsage, reconcileUsage } from './usage-reconcile-core.js';
import { priceUsage } from '../core/usage/pricing.js';

export interface UsageScanRequest {
  projectsDir: string;
  proxyLogDir?: string;
  since?: string;
  until: string;
  sessionIds?: string[];
}

export async function scanHostUsage(request: UsageScanRequest) {
  const canonical = await scanCanonicalUsage({ ...request, since: undefined, until: undefined });
  const files: string[] = [];
  if (request.proxyLogDir) {
    try {
      for (const name of await fs.readdir(request.proxyLogDir)) {
        if (name === 'proxy.log' || /^proxy\.log\.\d{4}-\d{2}-\d{2}$/.test(name)) {
          files.push(path.join(request.proxyLogDir, name));
        }
      }
    } catch { /* Missing evidence stays unverified. */ }
  }
  const upstream = await scanProxyUsage({ files, sessionIds: request.sessionIds });
  const since = request.since ? Date.parse(request.since) : undefined;
  const until = Date.parse(request.until);
  if ((since !== undefined && !Number.isFinite(since)) || !Number.isFinite(until)
    || (since !== undefined && since > until)) throw new RangeError('Invalid usage collection window');
  const scoped = reconcileUsage(canonical.records, upstream.records, { since, until });
  const used = new Set(scoped.records.flatMap(r => r.upstream ? [r.upstream] : []));
  const inWindow = upstream.records.filter(r => used.has(r) || ((since === undefined || r.startedMs >= since) && r.startedMs < until));
  return { canonical: { ...canonical, records: scoped.records }, upstream: { ...upstream, records: inWindow },
    reconciliation: scoped, until: request.until };
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
