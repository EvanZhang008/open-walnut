/**
 * Which engines a host can run, asked of that host (2026-10-30, the user: "if no
 * engine should grey"). This machine answers from its own probe (engine-probe.ts);
 * another host's daemon looks for each engine's CLI on its own PATH
 * (providers/acp-host-artifacts.ts, `acpHostEngines`). The engine picker greys out
 * what the task's host cannot run, and an engine switch refuses it.
 *
 * Every answer comes within a deadline, cached a minute per host. A host that does
 * not answer in time reads as unknown (no row), never as "not installed": the start
 * itself then says why, and a failed switch puts the old session back.
 */
import { ENGINE_REGISTRY, isAcpEngine } from './engine-registry.js';
import type { SessionEngine } from '../types.js';
import { probeEngines, type EngineAvailability } from './engine-probe.js';
import { hostAdapterSpec } from './host-adapter-spec.js';
import { engineHostBlocker, LOCAL_HOST, normalizeHost } from '../transfer/planner.js';
import { log } from '../../logging/index.js';

const TTL_MS = 60_000;
/** A host that did not answer is asked again after this, not at every picker mount. */
const FAILED_TTL_MS = 15_000;
const DEADLINE_MS = 4_000;
/** Above the daemon's own 5 s `--version` limit, so a cold probe still lands in the cache for the next ask. */
const RPC_TIMEOUT_MS = 12_000;

type HostAnswer = Partial<Record<SessionEngine, EngineAvailability>>;
const cache = new Map<string, { at: number; value: HostAnswer; failed?: boolean }>();
const inFlight = new Map<string, Promise<HostAnswer>>();

/** Test seam. */
export function _resetHostEngineCache(): void { cache.clear(); inFlight.clear(); }

export interface HostEnginesOpts {
  /** false = only a connection already open (the picker: opening it never dials or deploys). Default true. */
  dial?: boolean;
}

/** null = no connection to ask (not configured, or not open and `dial` is false). */
async function askRemote(host: string, dial: boolean): Promise<HostAnswer | null> {
  const dc = await import('../../providers/daemon-connection.js');
  let conn = dc.getConnectedDaemonConnection(host);
  if (!conn) {
    if (!dial) return null;
    const { getConfig } = await import('../config-manager.js');
    const hostDef = (await getConfig()).hosts?.[host];
    const hostname = hostDef?.hostname ?? (hostDef as Record<string, unknown> | undefined)?.ssh as string | undefined;
    if (!hostDef || !hostname) return null;
    conn = await (await import('../hosts/link.js')).link(host);
  }
  const out: HostAnswer = { claude: { installed: true, version: null, reason: null } };
  const acpIds = [...ENGINE_REGISTRY.keys()].filter((id) => isAcpEngine(id));
  if (!conn.hasCapability('acp-host-v1')) {
    for (const id of acpIds) {
      const rule = engineHostBlocker(id, host);
      out[id] = { installed: false, version: null, reason: rule ?? `the daemon on ${host} does not run ACP engines (it is older than this Walnut, or runs without bun)` };
    }
    return out;
  }
  const specs = acpIds.map((id) => hostAdapterSpec(id)).filter((s): s is NonNullable<typeof s> => !!s);
  const resp = await conn.send('acpHostEngines', { specs }, RPC_TIMEOUT_MS);
  if (!resp.ok) return null;
  // The daemon spreads its answer into the reply (sendOk).
  const engines = (resp as { engines?: Record<string, EngineAvailability> }).engines ?? {};
  for (const id of acpIds) {
    const rule = engineHostBlocker(id, host);
    if (rule) { out[id] = { installed: false, version: null, reason: rule }; continue; }
    const row = engines[id];
    if (row) out[id] = { installed: row.installed === true, version: row.version ?? null, reason: row.reason ?? null };
  }
  return out;
}

/** Every engine's availability on `host` that is known within the deadline. */
export async function hostEnginesAvailability(hostIn: string | undefined | null, opts: HostEnginesOpts = {}): Promise<HostAnswer> {
  const host = normalizeHost(hostIn ?? undefined);
  if (host === LOCAL_HOST) return Object.fromEntries(await probeEngines()) as HostAnswer;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < (hit.failed ? FAILED_TTL_MS : TTL_MS)) return hit.value;
  let work = inFlight.get(host);
  if (!work) {
    work = askRemote(host, opts.dial !== false).then((value) => {
      // No connection to ask is not an answer: the next ask (a switch dials) tries again.
      if (value) cache.set(host, { at: Date.now(), value });
      return value ?? hit?.value ?? {};
    }).catch((err: unknown) => {
      log.session.info('host engines: the host did not answer', { host, error: err instanceof Error ? err.message : String(err) });
      const value = hit?.value ?? {};
      cache.set(host, { at: Date.now(), value, failed: true });
      return value;
    }).finally(() => inFlight.delete(host));
    inFlight.set(host, work);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<HostAnswer>((resolve) => { timer = setTimeout(() => resolve(hit?.value ?? {}), DEADLINE_MS); timer.unref?.(); });
  try { return await Promise.race([work, late]); } finally { if (timer) clearTimeout(timer); }
}

/** One engine on `host`, or null when the host did not say. */
export async function hostEngineAvailability(host: string | undefined | null, engine: SessionEngine): Promise<EngineAvailability | null> {
  return (await hostEnginesAvailability(host))[engine] ?? null;
}
