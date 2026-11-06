import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import { USAGE_DB_FILE } from '../../constants.js';
import { ResponseUsageStore, type UsageEvidence, type UsageOwner, type SourceCheck } from './response-store.js';
import { getConfig } from '../config-manager.js';
import { listSessions } from '../session-tracker.js';
import { link } from '../hosts/link.js';
import type { UsageFilter } from './types.js';
import { engineCaps } from '../agents/engine-registry.js';
import type { DayBucket } from './cost-rollup.js';
import { outsideHosts } from './outside-codex.js';
import { classifyClaudeOutside } from './outside-claude.js';
import type { ClaudeSessionMeta } from '../../providers/claude-outside-core.js';
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
/** How long a host waits after a full read of its sessions outside Walnut failed. */
const OUTSIDE_RETRY_MS = 3 * 60 * 60_000;

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
  // Every host Walnut knows is read for Claude Code sessions it did not start, one machine once (a Mac reached two ways is two
  // rows in config.hosts); one with no Claude session record of Walnut's is skipped quietly when it cannot be read or cannot do it.
  const { joinedAliasOf, pickableHosts } = await import('../hosts/joined-twins.js');
  const asJoined = joinedAliasOf(config.hosts ?? {}, config.net);
  // The machine's own name reads the sessions outside Walnut, whichever of its names a session record uses, so what that read stores
  // (rows, origins, the full-read mark) never moves to another name. A name added only for that is skipped quietly when it cannot be read.
  const extraHosts = new Set<string>();
  const addMachine = (alias: string) => {
    const machine = asJoined(alias);
    if (!hosts.has(machine)) { hosts.set(machine, []); extraHosts.add(machine); }
  };
  for (const host of [...hosts.keys()]) addMachine(host);
  for (const [alias] of pickableHosts(config.hosts ?? {}, config.net)) addMachine(alias);
  // Sessions Walnut has a record of, by machine, each with the name its record uses: another name's sessions are stored by that name's own read.
  const ownerNames = new Map<string, Map<string, string>>();
  for (const [host, owners] of hosts) {
    const byId = ownerNames.get(asJoined(host)) ?? new Map<string, string>();
    for (const o of owners) byId.set(o.sessionId, host);
    ownerNames.set(asJoined(host), byId);
  }
  const results = [];
  for (const [host, owners] of hosts) {
    try {
      const conn = await link(host);
      await conn.connect();
      if (!conn.hasCapability('usage-scan-v1') || (extraHosts.has(host) && !conn.hasCapability('claude-outside-v1'))) {
        if (extraHosts.has(host)) continue;
        throw new Error('This host needs the usage collector daemon upgrade.');
      }
      // Sessions Walnut did not start are read too (a daemon that can). Until they were read in full once, the whole history is.
      const machine = asJoined(host);
      const outsideScan = conn.hasCapability('claude-outside-v1') && host === machine;
      // A full read that failed (a link that dropped before a long read ended) waits OUTSIDE_RETRY_MS before the next one.
      const cooling = Date.now() - rollup.claudeOutsideFailedAt(host) < OUTSIDE_RETRY_MS;
      let fullOutside = outsideScan && !rollup.claudeOutsideBuilt(host) && (since === undefined || since === INCREMENTAL) && !cooling;
      const known = ownerNames.get(machine) ?? new Map<string, string>();
      const foreign = new Set([...known].filter(([, name]) => name !== host).map(([id]) => id));
      let unreadable = 0;
      const scanArgs = (outside: boolean, from: string | undefined) => ({ since: from, until, sessionIds: owners.map(o => o.sessionId),
        ...(outside ? { outside: true } : {}), proxyLogDir: config.usage?.proxy_log_dirs?.[host] });
      let requestSince = fullOutside ? undefined : sinceFor(host);
      let outsideNow = outsideScan && !(cooling && !rollup.claudeOutsideBuilt(host));
      let responses = 0, verified = 0, unverified = 0;
      let checks: SourceCheck[] = [];
      let logged = false;
      for (let attempt = 0; ; attempt++) {
        try {
          let reply = await conn.send('usage.scan', scanArgs(outsideNow, requestSince), 30 * 60_000);
          for (;;) {
            if (!reply.ok || !reply.result) throw new Error(String(reply.error ?? 'No usage evidence returned.'));
            const scan = (reply.result as { scan?: unknown }).scan;
            if (scan && !logged) { logged = true; log.usage.info('usage scan read', { host, scan }); }
            const evidence = reply.result as UsageEvidence & { outsideSessions?: ClaudeSessionMeta[] };
            unreadable += (evidence.canonical?.diagnostics as { unreadable_files?: number } | undefined)?.unreadable_files ?? 0;
            // A session another name of this machine owns is stored by that name's own read.
            if (outsideNow && foreign.size) evidence.reconciliation = { ...evidence.reconciliation, records: evidence.reconciliation.records.filter(r => !foreign.has(r.sessionId)) };
            // Who started each outside session is noted before its responses are stored.
            const extra = evidence.outsideSessions?.length
              ? classifyClaudeOutside({ rollup, host, metas: evidence.outsideSessions, known, hasRows: id => responseUsageStore().hasSession(id) }) : [];
            const imported = await responseUsageStore().importHost(host, evidence, extra.length ? [...owners, ...extra] : owners);
            responses += imported.responses; verified += imported.verified; unverified += imported.unverified;
            checks = imported.checks;
            if (reply.done !== false) break;
            reply = await conn.send('usage.scan', { key: reply.key, offset: reply.offset }, 30_000);
          }
          break;
        } catch (error) {
          if (attempt > 0 || !fullOutside) throw error;
          // The long read did not end, whether its link dropped or its pages ran out: the host's own sessions are still collected
          // now, and the full read of the rest is tried again after a wait. What it stored already is kept (a response has one row).
          log.usage.warn('claude outside full read failed; collecting without it', { host, error: String(error) });
          rollup.setClaudeOutsideFailedAt(host, Date.now());
          fullOutside = false; outsideNow = false; requestSince = sinceFor(host); unreadable = 0;
        }
      }
      responseUsageStore().finishHost(host, until, checks);
      // Only a read from the beginning counts as the full one; a pass with a start (a manual window) leaves it for the next.
      // A file that could not be read keeps the full read for the next pass, a few times at most.
      if (outsideNow && requestSince === undefined) {
        const tries = unreadable > 0 ? rollup.claudeOutsideTries(host) + 1 : 0;
        rollup.setClaudeOutsideTries(host, tries);
        if (tries === 0 || tries >= 3) { rollup.markClaudeOutsideBuilt(host); rollup.setClaudeOutsideFailedAt(host, 0); }
      }
      results.push({ host, responses, verified, unverified });
    } catch (error) {
      if (extraHosts.has(host)) { log.usage.debug('claude outside read skipped', { host, error: String(error) }); continue; }
      responseUsageStore().markHostUnavailable(host, String(error));
      results.push({ host, status: 'unverified', detail: String(error) });
    }
  }
  // Sums for pairs an import could not refresh (thresholds changed) come from the rebuild.
  if (!rollup.isReady()) await rollup.backfill();
  const engines = await collectEngineSessions(sessions, sinceFor);
  // Every host Walnut knows, whatever engine its sessions use: a host with only terminal Codex runs counts too.
  // One machine once: a Mac reached two ways (found over ssh, joined over the host network) is two rows in config.hosts.
  const outsideList = outsideHosts(hosts.keys(), sessions.map(s => s.host ?? '__local__'), pickableHosts(config.hosts ?? {}, config.net).map(([alias]) => alias))
    .map(host => asJoined(host));
  const outside = await collectOutside(sessions, [...new Set(outsideList)]).catch((error) => {
    log.usage.warn('outside codex collection failed', { error: String(error) });
    return undefined;
  });
  return { since, until, results, engines, outside };
}

/** Codex runs no Walnut session started (an agent's `codex exec`), read from each host's own rollout files. */
async function collectOutside(sessions: Awaited<ReturnType<typeof listSessions>>, hosts: string[]) {
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const { collectOutsideCodex } = await import('./outside-codex.js');
  const usage = responseUsageStore();
  return collectOutsideCodex({ rollup: usage.rollup, hosts, timeZone: usage.timezone, reader: host => new DaemonFileReader(host),
    knownIds: host => sessions.filter(s => engineCaps(s.engine).rolloutUsage && (s.host ?? '__local__') === host).map(s => s.claudeSessionId) });
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
        taskId: session.taskId || null, source: 'session' }, buckets, { byDay: split });
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
