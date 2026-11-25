import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import { USAGE_DB_FILE } from '../../constants.js';
import { reopenIfWiped } from '../../lib/sqlite-wiped.js';
import { PluginDatabaseClient } from '../plugins/plugin-storage.js';
import { ResponseUsageStore, type OverviewPart, type UsageEvidence, type UsageOwner, type UsageReader, type SourceCheck } from './response-store.js';
import { getConfig } from '../config-manager.js';
import { listSessions } from '../session-tracker.js';
import { link } from '../hosts/link.js';
import type { UsageFilter } from './types.js';
import { engineCaps } from '../agents/engine-registry.js';
import type { DayBucket } from './cost-rollup.js';
import { usageMachines } from './usage-machines.js';
import { outsideHosts } from './outside-codex.js';
import { classifyClaudeOutside } from './outside-claude.js';
import { WALNUT_SESSION_ENTRYPOINTS, type ClaudeSessionMeta } from '../../providers/claude-outside-core.js';
import type { SessionCostScan } from '../../providers/session-cost-core.js';
import { needCapability } from '../../providers/daemon-capability-need.js';

let store: ResponseUsageStore | undefined;
let inflight: Promise<unknown> | undefined;
let state: { running: boolean; id?: string; since?: string; until?: string; startedAt?: string; finishedAt?: string; error?: string } = { running: false };

export function responseUsageStore() {
  if (store) {
    store = reopenIfWiped(USAGE_DB_FILE, store, () => new ResponseUsageStore(USAGE_DB_FILE), (old) => old.close());
    return store;
  }
  return store = new ResponseUsageStore(USAGE_DB_FILE);
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
/** A worker's connection to the usage database, for the store it was opened beside. */
let reader: { store: ResponseUsageStore; client: PluginDatabaseClient } | null = null;
let readerWarned = false;

/** Drops the worker's connection; the next overview opens another. */
function dropReader(client: PluginDatabaseClient): void {
  if (reader?.client !== client) return;
  reader = null;
  void client.dispose().catch(() => {});
}

/** The overview's reader: a worker's connection, so its scans never hold the loop thread; this
 *  store's own (undefined) when no worker can start. A store reopened after a wipe gets a new one
 *  (the old connection holds the deleted file), and so does a worker that died: a read it refuses
 *  drops it, and that one overview reads on this store's own connection. Made in one synchronous
 *  step, so two first requests share one worker. */
function usageReader(current: ResponseUsageStore): UsageReader | undefined {
  if (reader?.store !== current) {
    if (reader) dropReader(reader.client);
    try {
      reader = { store: current, client: new PluginDatabaseClient(USAGE_DB_FILE, undefined, { existingOnly: true }) };
    } catch (err) {
      if (!readerWarned) log.usage.warn('usage overview reads on the loop thread: no worker', { error: String(err) });
      readerWarned = true;
      return undefined;
    }
  }
  const { client } = reader;
  const own = current.ownReader();
  const guard = async <T>(read: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    try { return await read(); } catch (err) {
      // A statement error is the query's own: the store's connection answers it the same.
      log.usage.warn('usage overview worker read failed; reading on the loop thread', { error: String(err) });
      dropReader(client);
      return fallback();
    }
  };
  return {
    get: (sql, args) => guard(() => client.get(sql, [...args]), () => own.get(sql, args)),
    all: (sql, args) => guard(() => client.all(sql, [...args]), () => own.all(sql, args)),
  };
}

/** Test seam: the worker's connection goes. */
export async function _closeUsageReaderForTesting(): Promise<void> {
  const r = reader;
  reader = null;
  await r?.client.dispose().catch(() => {});
}

export async function reconciledOverview(filter: UsageFilter, limit: number, parts?: readonly OverviewPart[]) {
  const current = responseUsageStore();
  return { ...await current.getOverview(filter, limit, { reader: usageReader(current), parts }), collection: state };
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
  // One machine is read once, under its own name: every other name of it (a found ~/.ssh/config row of a joined machine, an alias
  // its daemon confirmed is the same process: hosts/joined-twins.ts) reads the same transcripts, and read under each it stored each
  // response once per name (2026-11-20: clouddev, newdev and clouddev-net were one box, and its week counted about three times).
  const { machineOf } = await usageMachines(config, rollup, { refresh: true });
  const { joinedTwins, pickableHosts } = await import('../hosts/joined-twins.js');
  const hosts = new Map<string, UsageOwner[]>();
  hosts.set('__local__', []);
  /** The other names a machine's sessions were started under: a link to read it over when its own is down. */
  const otherNames = new Map<string, Set<string>>();
  /** Sessions Walnut has a record of, by machine, each with the name its record uses. */
  const knownOn = new Map<string, Map<string, string>>();
  for (const session of sessions) {
    if (engineCaps(session.engine).historySource !== 'provider-jsonl') continue;
    const named = session.host ?? '__local__';
    const host = machineOf(named);
    const owners = hosts.get(host) ?? [];
    owners.push({ sessionId: session.claudeSessionId, taskId: session.taskId || undefined,
      title: session.title, project: session.project, lane: session.lane });
    hosts.set(host, owners);
    if (named !== host) otherNames.set(host, (otherNames.get(host) ?? new Set()).add(named));
    knownOn.set(host, (knownOn.get(host) ?? new Map()).set(session.claudeSessionId, named));
  }
  // Every host Walnut knows is read for Claude Code sessions it did not start; one with no Claude session record of Walnut's is
  // skipped quietly when it cannot be read or cannot do it.
  const extraHosts = new Set<string>();
  for (const [alias] of pickableHosts(config.hosts ?? {}, config.net)) {
    const machine = machineOf(alias);
    if (!hosts.has(machine)) { hosts.set(machine, []); extraHosts.add(machine); }
  }
  // Every other name of a machine is a link to read it over when its own is down (they reach one daemon).
  for (const { alias, joined } of joinedTwins(config.hosts ?? {}, config.net)) {
    if (hosts.has(joined)) otherNames.set(joined, (otherNames.get(joined) ?? new Set()).add(alias));
  }
  // A name read as another machine's keeps no collection mark of its own: its rows are that machine's now. A mark that
  // came back (an older build ran again and read under that name) may have stored copies again: they are removed once more.
  // (A keeper that changed, as with the host network turned off, forgets a mark this build wrote: nothing to remove.)
  let olderMark = false;
  for (const { host } of responseUsageStore().countedUntil()) {
    if (machineOf(host) === host) continue;
    if (!rollup.ownPass(host)) olderMark = true;
    responseUsageStore().forgetHost(host); rollup.forgetOwnPass(host);
  }
  if (olderMark) rollup.redoDedupe();
  // Sessions Walnut imported because they began outside it are outside whatever entrypoint they wrote (a script's claude -p).
  const importedIds = new Set(sessions.filter(s => /started outside Walnut/.test(s.human_note ?? '')).map(s => s.claudeSessionId));
  for (const [host, owners] of hosts) {
    // One with no origin yet is noted; one an older build kept as Walnut's is put right (the import says it began outside).
    const rows = owners.filter(o => importedIds.has(o.sessionId)).flatMap(o => {
      const before = rollup.originOf(host, o.sessionId);
      if (before?.outside) return [];
      return [{ host, sessionId: o.sessionId, originator: before?.originator || 'imported', provider: before?.provider ?? '', cwd: before?.cwd ?? '',
        outside: true, stored: true, firstAt: before?.firstAt ?? '', lastAt: before?.lastAt ?? '' }];
    });
    if (rows.length) rollup.recordOrigins(rows);
  }
  // A look kept as outside for a session whose record came later, on an entrypoint Walnut's own sessions write, is put right.
  rollup.repairWalnutOrigins([...WALNUT_SESSION_ENTRYPOINTS], (host, id) => !!knownOn.get(machineOf(host))?.has(id) && !importedIds.has(id));
  const results = [];
  for (const [host, owners] of hosts) {
    try {
      const conn = await connectedLink(host, [...otherNames.get(host) ?? []]);
      if (!needCapability(conn, 'usage-scan-v1') || (extraHosts.has(host) && !needCapability(conn, 'claude-outside-v1'))) {
        if (extraHosts.has(host)) continue;
        throw new Error('This host needs the usage collector daemon upgrade.');
      }
      // Sessions Walnut did not start are read too (a daemon that can). Until they were read in full once, the whole history is.
      const outsideScan = conn.hasCapability('claude-outside-v1');
      // A full read that failed (a link that dropped before a long read ended) waits OUTSIDE_RETRY_MS before the next one.
      const cooling = Date.now() - rollup.claudeOutsideFailedAt(host) < OUTSIDE_RETRY_MS;
      let fullOutside = outsideScan && !rollup.claudeOutsideBuilt(host) && (since === undefined || since === INCREMENTAL) && !cooling;
      const known = knownOn.get(host) ?? new Map<string, string>();
      let unreadable = 0;
      const scanArgs = (outside: boolean, from: string | undefined) => ({ since: from, until, sessionIds: owners.map(o => o.sessionId),
        ...(outside ? { outside: true } : {}),
        proxyLogDir: config.usage?.proxy_log_dirs?.[host] ?? [...otherNames.get(host) ?? []].map(n => config.usage?.proxy_log_dirs?.[n]).find(Boolean) });
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
            // A Walnut session begun after this pass listed the sessions is not in `known` yet: its record is read again before
            // the first look, because that look is kept for good and would otherwise call it outside.
            if (evidence.outsideSessions?.some(m => !known.has(m.sessionId) && WALNUT_SESSION_ENTRYPOINTS.has(m.entrypoint) && !rollup.originOf(host, m.sessionId))) {
              for (const s of await listSessions()) {
                if (engineCaps(s.engine).historySource !== 'provider-jsonl' || known.has(s.claudeSessionId)) continue;
                const named = s.host ?? '__local__';
                if (machineOf(named) !== host) continue;
                known.set(s.claudeSessionId, named);
                if (/started outside Walnut/.test(s.human_note ?? '')) importedIds.add(s.claudeSessionId);
                owners.push({ sessionId: s.claudeSessionId, taskId: s.taskId || undefined, title: s.title, project: s.project, lane: s.lane });
              }
            }
            // Who started each outside session is noted before its responses are stored.
            const extra = evidence.outsideSessions?.length
              ? classifyClaudeOutside({ rollup, host, metas: evidence.outsideSessions, known, imported: importedIds, hasRows: id => responseUsageStore().hasSession(id) }) : [];
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
          fullOutside = false; outsideNow = false; requestSince = sinceFor(host); unreadable = 0; responses = 0; verified = 0; unverified = 0;
        }
      }
      responseUsageStore().finishHost(host, until, checks);
      rollup.markOwnPass(host);
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
  const engines = await collectEngineSessions(sessions, sinceFor, machineOf);
  // Every host Walnut knows, whatever engine its sessions use: a host with only terminal Codex runs counts too. One machine once.
  const outsideList = outsideHosts(hosts.keys(), sessions.map(s => s.host ?? '__local__'), pickableHosts(config.hosts ?? {}, config.net).map(([alias]) => alias))
    .map(host => machineOf(host));
  const outside = await collectOutside(sessions, [...new Set(outsideList)], machineOf).catch((error) => {
    log.usage.warn('outside codex collection failed', { error: String(error) });
    return undefined;
  });
  return { since, until, results, engines, outside };
}

/** Codex runs no Walnut session started (an agent's `codex exec`), read from each host's own rollout files. */
/** The link of `host`, connected; when it cannot be, the first of the machine's other names that can (they reach one daemon). */
async function connectedLink(host: string, others: string[]) {
  let first: unknown;
  for (const name of [host, ...others]) {
    try {
      const conn = await link(name);
      await conn.connect();
      return conn;
    } catch (error) { first ??= error; }
  }
  throw first;
}

async function collectOutside(sessions: Awaited<ReturnType<typeof listSessions>>, hosts: string[], machineOf: (alias: string) => string) {
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const { collectOutsideCodex } = await import('./outside-codex.js');
  const usage = responseUsageStore();
  return collectOutsideCodex({ rollup: usage.rollup, hosts, timeZone: usage.timezone, reader: host => new DaemonFileReader(host),
    knownIds: host => sessions.filter(s => engineCaps(s.engine).rolloutUsage && machineOf(s.host ?? '__local__') === host).map(s => s.claudeSessionId) });
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
async function collectEngineSessions(sessions: Awaited<ReturnType<typeof listSessions>>, sinceFor: (host: string) => string | undefined,
  machineOf: (alias: string) => string) {
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
    const since = all(host) ? undefined : sinceFor(machineOf(host));
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
      // Read over the session's own link, counted as its machine's (one machine, one host).
      await rollup.replaceSession({ sessionId: session.claudeSessionId, host: machineOf(host), engine: session.engine,
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
