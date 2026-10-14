import { randomUUID } from 'node:crypto';
import { USAGE_DB_FILE } from '../../constants.js';
import { ResponseUsageStore, type UsageEvidence, type UsageOwner, type SourceCheck } from './response-store.js';
import { getConfig } from '../config-manager.js';
import { listSessions } from '../session-tracker.js';
import { getDaemonConnection } from '../../providers/daemon-connection.js';
import type { UsageFilter } from './types.js';
import { engineCaps } from '../agents/engine-registry.js';

let store: ResponseUsageStore | undefined;
let inflight: Promise<unknown> | undefined;
let state: { running: boolean; id?: string; since?: string; until?: string; startedAt?: string; finishedAt?: string; error?: string } = { running: false };

export function responseUsageStore() {
  return store ??= new ResponseUsageStore(USAGE_DB_FILE);
}
export function collectionState() { return state; }
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
      let reply = await conn.send('usage.scan', { since, until, sessionIds: owners.map(o => o.sessionId),
        proxyLogDir: config.usage?.proxy_log_dirs?.[host] }, 600_000);
      let responses = 0, verified = 0, unverified = 0;
      let checks: SourceCheck[] = [];
      for (;;) {
        if (!reply.ok || !reply.result) throw new Error(String(reply.error ?? 'No usage evidence returned.'));
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
  return { since, until, results };
}
