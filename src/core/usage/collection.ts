import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import { USAGE_DB_FILE } from '../../constants.js';
import { ResponseUsageStore, type UsageEvidence, type UsageOwner, type SourceCheck } from './response-store.js';
import { getConfig } from '../config-manager.js';
import { listSessions } from '../session-tracker.js';
import { getDaemonConnection } from '../../providers/daemon-connection.js';
import type { UsageFilter } from './types.js';
import { engineCaps } from '../agents/engine-registry.js';
import type { DayBucket } from './cost-rollup.js';
import type { SessionCostScan } from '../../providers/session-cost-core.js';

let store: ResponseUsageStore | undefined;
let inflight: Promise<unknown> | undefined;
let state: { running: boolean; id?: string; since?: string; until?: string; startedAt?: string; finishedAt?: string; error?: string } = { running: false };

export function responseUsageStore() {
  return store ??= new ResponseUsageStore(USAGE_DB_FILE);
}
export function collectionState() { return state; }

/** Re-read overlap for an incremental pass: imports dedupe by response id, so overlap is free. */
const OVERLAP_MS = 2 * 60 * 60_000;

/** How often the leader collects every host's usage (server.ts). */
export const USAGE_COLLECT_MS = 30 * 60_000;

/** True when a host never finished a pass, or the oldest finished one is a collect interval old. */
export function collectionStale(now = Date.now()): boolean {
  const untils = responseUsageStore().countedUntil();
  if (!untils.length) return true;
  return untils.some(u => !u.until || now - Date.parse(u.until) >= USAGE_COLLECT_MS);
}

/** Ask `collectUsage` to read each host from where its last finished pass ended. */
export const INCREMENTAL = 'incremental';

/**
 * Where an incremental pass starts on one host: its last finished pass, less an
 * overlap. Undefined (a full read) when the host never finished one, so a host
 * that is down never widens the other hosts' reads.
 */
export function hostSince(host: string): string | undefined {
  const until = responseUsageStore().countedUntil().find(u => u.host === host)?.until;
  const at = until ? Date.parse(until) : NaN;
  return Number.isFinite(at) ? new Date(at - OVERLAP_MS).toISOString() : undefined;
}
export function reconciledOverview(filter: UsageFilter, limit: number) {
  return { ...responseUsageStore().getOverview(filter, limit), collection: state };
}

export function collectUsage(since?: string, until = new Date().toISOString()): Promise<unknown> {
  if (inflight) return inflight;
  state = { running: true, id: randomUUID(), since, until, startedAt: new Date().toISOString() };
  inflight = collect(since, until).then(result => {
    state = { ...state, running: false, finishedAt: new Date().toISOString() };
    return result;
  }).catch(error => {
    state = { ...state, running: false, error: String(error) };
    throw error;
  }).finally(() => { inflight = undefined; });
  return inflight;
}

async function collect(since: string | undefined, until: string) {
  const config = await getConfig();
  const { ensurePriceBook, priceThresholds } = await import('./price-book.js');
  await ensurePriceBook();
  const rollup = responseUsageStore().rollup;
  rollup.setThresholds(priceThresholds(config.usage?.prices));
  const sinceFor = (host: string) => since === INCREMENTAL ? hostSince(host) : since;
  const sessions = await listSessions();
  const hosts = new Map<string, UsageOwner[]>();
  hosts.set('__local__', []);
  for (const session of sessions) {
    if (engineCaps(session.engine).historySource !== 'provider-jsonl') continue;
    const host = session.host ?? '__local__';
    const owners = hosts.get(host) ?? [];
    owners.push({ sessionId: session.claudeSessionId, taskId: session.taskId || undefined,
      title: session.title, project: session.project, lane: session.lane });
    hosts.set(host, owners);
  }
  const results = [];
  for (const [host, owners] of hosts) {
    try {
      const def = config.hosts?.[host];
      const target = host === '__local__' ? { hostname: '__local__' }
        : { hostname: def?.hostname ?? host, user: def?.user, port: def?.port };
      const conn = await getDaemonConnection(host, target);
      await conn.connect();
      if (!conn.hasCapability('usage-scan-v1')) throw new Error('This host needs the usage collector daemon upgrade.');
      let reply = await conn.send('usage.scan', { since: sinceFor(host), until, sessionIds: owners.map(o => o.sessionId),
        proxyLogDir: config.usage?.proxy_log_dirs?.[host] }, 30 * 60_000);
      let responses = 0, verified = 0, unverified = 0;
      let checks: SourceCheck[] = [];
      let logged = false;
      for (;;) {
        if (!reply.ok || !reply.result) throw new Error(String(reply.error ?? 'No usage evidence returned.'));
        const scan = (reply.result as { scan?: unknown }).scan;
        if (scan && !logged) { logged = true; log.usage.info('usage scan read', { host, scan }); }
        const imported = await responseUsageStore().importHost(host, reply.result as UsageEvidence, owners);
        responses += imported.responses; verified += imported.verified; unverified += imported.unverified;
        checks = imported.checks;
        if (reply.done !== false) break;
        reply = await conn.send('usage.scan', { key: reply.key, offset: reply.offset }, 30_000);
      }
      responseUsageStore().finishHost(host, until, checks);
      results.push({ host, responses, verified, unverified });
    } catch (error) {
      responseUsageStore().markHostUnavailable(host, String(error));
      results.push({ host, status: 'unverified', detail: String(error) });
    }
  }
  // Sums for pairs an import could not refresh (thresholds changed) come from the rebuild.
  if (!rollup.isReady()) await rollup.backfill();
  const engines = await collectEngineSessions(sessions, sinceFor);
  return { since, until, results, engines };
}

/** Engines whose own session records session-cost-core can read (Claude comes from usage.scan). */
const SCANNED_ENGINES = new Set(['codex', 'opencode']);

/** How long one session's read may take before its host counts as not answering. */
const ENGINE_READ_MS = 60_000;

/**
 * Codex and OpenCode sessions: each one's usage split by local day on its host,
 * replacing that session's rows. An incremental pass reads only the sessions
 * active since the host's last pass, except the first time and after the price
 * bands changed, when it reads them all. A host that does not answer is skipped
 * for the rest of the pass. A host whose daemon cannot split by day dates a
 * bucket by its last response.
 */
async function collectEngineSessions(sessions: Awaited<ReturnType<typeof listSessions>>, sinceFor: (host: string) => string | undefined) {
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const usage = responseUsageStore();
  const rollup = usage.rollup;
  const thresholds = JSON.parse(rollup.key || '[]') as number[];
  const timeZone = usage.timezone;
  const dateOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = (iso: string | undefined) => {
    const at = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(at) && at > 0 ? dateOf.format(at) : undefined;
  };
  const down = new Set<string>(), seen = new Set<string>(), incomplete = new Set<string>();
  const all = (host: string) => rollup.enginesKey(host) !== rollup.key;
  let read = 0, failed = 0;
  for (const session of sessions) {
    if (!session.engine || !SCANNED_ENGINES.has(session.engine)) continue;
    const host = session.host ?? '__local__';
    seen.add(host);
    if (down.has(host)) { failed++; continue; }
    const since = all(host) ? undefined : sinceFor(host);
    if (since && Date.parse(session.lastActiveAt ?? '') < Date.parse(since)) continue;
    let timer: NodeJS.Timeout | undefined;
    try {
      const reading = new DaemonFileReader(host).readSessionCost({ sessionId: session.claudeSessionId, engine: session.engine,
        cwd: session.cwd, thresholds, byDay: { timeZone } }, ENGINE_READ_MS);
      reading.catch(() => {});
      const scan = await Promise.race([reading, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ENGINE_READ_MS + 5_000); })]);
      if (scan === 'timeout') { down.add(host); failed++; continue; }
      if (!scan) { down.add(host); failed++; continue; } // a daemon without session-cost-v1
      if ((scan as SessionCostScan).pending) { incomplete.add(host); failed++; continue; }
      const result = scan as SessionCostScan;
      const split = !!result.byDay;
      const buckets: DayBucket[] = result.buckets.flatMap(b => {
        // No time on the response (or no day split): its last time, else the session's.
        const date = (split ? b.day : undefined) ?? dayOf(b.lastAt) ?? dayOf(result.lastAt) ?? dayOf(session.lastActiveAt);
        return date ? [{ day: date, model: b.model, band: b.band, responses: b.responses,
          input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite5m: b.cacheWrite5m, cacheWrite1h: b.cacheWrite1h,
          cacheWrite: b.cacheWrite }] : [];
      });
      await rollup.replaceSession({ sessionId: session.claudeSessionId, host, engine: session.engine,
        taskId: session.taskId || null, source: 'session' }, buckets);
      read++;
    } catch {
      down.add(host);
      failed++;
    } finally {
      clearTimeout(timer);
    }
  }
  for (const host of seen) if (!down.has(host) && !incomplete.has(host) && all(host)) rollup.markEnginesBuilt(host, rollup.key);
  return { read, failed };
}
