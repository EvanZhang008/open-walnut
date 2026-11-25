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
import { needCapability } from '../../providers/daemon-capability-need.js'

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

/** Forget what `host` said (an engine was just installed there): the next ask asks it again. */
export function forgetHostEngines(host: string): void { cache.delete(normalizeHost(host)); }

export interface HostEnginesOpts {
  /** false = only a connection already open (the picker: opening it never dials or deploys). Default true. */
  dial?: boolean;
}

/** null = no connection to ask (not configured, or not open and `dial` is false). */
/** The connection module once an ask has loaded it, for the synchronous reader above (no import cycle at load). */
let daemonConnections: typeof import('../../providers/daemon-connection.js') | null = null;

async function askRemote(host: string, dial: boolean): Promise<HostAnswer | null> {
  const dc = await import('../../providers/daemon-connection.js');
  daemonConnections = dc;
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
  if (!needCapability(conn, 'acp-host-v1')) {
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
    if (row) out[id] = { installed: row.installed === true, version: row.version ?? null, reason: withInstallHint(id, row.reason ?? null) };
  }
  return out;
}

/**
 * The host daemon's "<binary> is not installed" with the engine's own one-line installer
 * after it (engine-registry.ts `install`), so the picker says how to get it there.
 */
export function withInstallHint(engine: SessionEngine, reason: string | null): string | null {
  const adapter = ENGINE_REGISTRY.get(engine)?.acpAdapter;
  if (!reason || !adapter?.install || !adapter.binary || reason !== `${adapter.binary} is not installed`) return reason;
  return `${reason}: install it with \`${adapter.install}\``;
}

/**
 * Claude Code on another host, from that host's preflight (host-readiness.ts) rather than the
 * daemon's word, which never named it: every remote host read as able to run it, so placement
 * and the engine picker offered a host with none installed (2026-11-05). Missing, needing a
 * node it lacks, or broken is not installed; an old or signed-out one is still installed (Start
 * says so, and may go ahead); a check that could not tell gives no row. No answer yet changes nothing.
 */
async function withClaudeReadiness(host: string, answer: HostAnswer): Promise<HostAnswer> {
  const { claudeUnusableProblem, getHostReadiness } = await import('../hosts/host-readiness.js');
  const r = getHostReadiness(host);
  if (!r) return answer;
  // A check that could not tell is no answer (unknown, never "not installed"), as below.
  if (r.claude.unknown) { const { claude: _unknown, ...rest } = answer; return rest; }
  const p = claudeUnusableProblem(host);
  const version = r.claude.version ?? null;
  return { ...answer, claude: p ? { installed: false, version, reason: p.message.replace(/\.\s*$/, '') } : { installed: true, version, reason: null } };
}

/** Every engine's availability on `host` that is known within the deadline. */
export async function hostEnginesAvailability(hostIn: string | undefined | null, opts: HostEnginesOpts = {}): Promise<HostAnswer> {
  const host = normalizeHost(hostIn ?? undefined);
  if (host === LOCAL_HOST) return Object.fromEntries(await probeEngines()) as HostAnswer;
  return withClaudeReadiness(host, await askedEngines(host, opts));
}

async function askedEngines(host: string, opts: HostEnginesOpts): Promise<HostAnswer> {
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

/** A probe still running, or a check that could not run, is no answer (engine-probe.ts, routes/engines.ts). */
const PENDING_REASON = /^(still checking availability|availability check unavailable)$/;

/** The row says the engine is missing there; a pending probe or no row says nothing. */
export function saysNotInstalled(availability: EngineAvailability | null | undefined): boolean {
  return !!availability && !availability.installed && !PENDING_REASON.test(availability.reason ?? '');
}

/**
 * The host's last answer about one engine, from the cache alone (never asks, never waits):
 * for a synchronous reader on the launch path (default-engine.ts). undefined = no answer
 * yet, or the host did not name that engine. A stale answer is still returned, as the
 * engine picker shows it until the next ask.
 */
export function cachedHostEngineAvailability(hostIn: string | undefined | null, engine: SessionEngine): EngineAvailability | undefined {
  const host = normalizeHost(hostIn ?? undefined);
  if (host === LOCAL_HOST) return undefined;
  return cache.get(host)?.value[engine];
}

/**
 * Whether `host` has positively said it runs `engine`, from what is known without a dial:
 * its cached answer says installed, and an open link to it (when there is one) has a daemon
 * that runs ACP engines ('acp-host-v1'). No answer is no: the reader that inherits an engine
 * (default-engine.ts) must not start one a host may lack, and the cache is empty after every
 * restart.
 */
export function hostSaysInstalled(hostIn: string | undefined | null, engine: SessionEngine): boolean {
  const host = normalizeHost(hostIn ?? undefined);
  if (host === LOCAL_HOST || cachedHostEngineAvailability(host, engine)?.installed !== true) return false;
  if (!isAcpEngine(engine)) return true;
  const open = daemonConnections?.getConnectedDaemonConnection(host);
  return !open || open.hasCapability('acp-host-v1');
}

/** Whether `host` has an answer fresh enough that no new ask is due. */
export function hostEnginesFresh(hostIn: string | undefined | null): boolean {
  const hit = cache.get(normalizeHost(hostIn ?? undefined));
  return !!hit && Date.now() - hit.at < (hit.failed ? FAILED_TTL_MS : TTL_MS);
}

/** Test seam: what `host` answered, as if it had just answered it. */
export function _seedHostEngineCache(host: string, value: HostAnswer): void {
  cache.set(normalizeHost(host), { at: Date.now(), value });
}

/** One engine on `host`, or null when the host did not say. */
export async function hostEngineAvailability(host: string | undefined | null, engine: SessionEngine): Promise<EngineAvailability | null> {
  return (await hostEnginesAvailability(host))[engine] ?? null;
}
