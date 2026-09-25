/**
 * Working-dirs cache: the `GET /api/sessions/working-dirs` answer (`{dirs, hosts}`)
 * that the session launcher and the draft column read.
 *
 * The draft column reads it SYNCHRONOUSLY (`peek`), so the value lives for the
 * page's life. That made it stale in one way that mattered: a host added in
 * Settings after page load never got a tab in the folder picker, and the All tab
 * never listed it, until a reload or a session start. So the picker revalidates on
 * every open (stale-while-revalidate: render the cached answer at once, swap in
 * the fresh one only when it differs) and on a `config:changed` that may touch
 * hosts (`configChangeMayAffectHosts`).
 *
 * Pure: no React, no IO of its own (the loader is injected). Unit-tested in
 * tests/web/path-selector/working-dirs-cache.test.ts.
 */
import type { LaunchMemory } from '@/utils/engines';

export interface WorkingDirEntry {
  cwd: string;
  host: string | null;
  hostLabel?: string;
  /** Majority-vote project for this dir, or the configured default. '' = Inbox. */
  project: string;
  count: number;
  lastUsed: string;
  /** Launch config remembered from the last Quick Start on this dir. `model`
   *  is the raw picker value (catalog ID or legacy alias). Absent = Auto/Claude. */
  lastLaunch?: LaunchMemory;
}

/** A host from config.hosts, shown as a launcher tab even with zero session history. */
export interface ConfiguredHost {
  alias: string;
  label: string;
  /** True for auto-discovered FQDN-only entries with no human-chosen alias:
   *  the launcher shows a "name this host" nudge for these. */
  rawName?: boolean;
}

export interface WorkingDirsResult {
  dirs: WorkingDirEntry[];
  /** All configured remote hosts (may be absent on older servers). */
  hosts: ConfiguredHost[];
}

export interface WorkingDirsCache {
  /** The cached answer when there is one, else the network (joins an in-flight request). */
  fetch(): Promise<WorkingDirsResult>;
  /** Always the network, joining a request already in flight. An answer equal to
   *  the cached one resolves with the cached OBJECT, so a React state set bails out. */
  revalidate(): Promise<WorkingDirsResult>;
  /** A NEW request even when one is in flight (the in-flight one may predate the
   *  change that prompted this). The older request, if it lands later, answers
   *  with this one's result so no caller applies an older answer after a newer one. */
  refresh(): Promise<WorkingDirsResult>;
  /** Synchronous peek: `null` until an answer has landed. Never fetches. */
  peek(): WorkingDirsResult | null;
  /** Drop the value (e.g. a new session made a new path entry). A request already
   *  in flight still answers its caller but no longer writes the cache. */
  invalidate(): void;
}

export function createWorkingDirsCache(load: () => Promise<WorkingDirsResult>): WorkingDirsCache {
  let value: WorkingDirsResult | null = null;
  let valueSig = '';
  let valueGen = 0;
  let generation = 0;
  let inflight: Promise<WorkingDirsResult> | null = null;

  const start = (): Promise<WorkingDirsResult> => {
    const gen = ++generation;
    const p: Promise<WorkingDirsResult> = load().then((fresh) => {
      if (gen !== generation) {
        // Superseded by a refresh or an invalidate: answer with the newer result.
        if (inflight && inflight !== p) return inflight;
        if (value && valueGen > gen) return value;
        return fresh; // invalidated with nothing newer: own answer, not cached
      }
      const sig = JSON.stringify(fresh);
      if (!value || sig !== valueSig) {
        value = fresh;
        valueSig = sig;
      }
      valueGen = gen;
      return value;
    });
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
    return p;
  };

  return {
    fetch: () => (value ? Promise.resolve(value) : (inflight ?? start())),
    revalidate: () => inflight ?? start(),
    refresh: start,
    peek: () => value,
    invalidate: () => {
      value = null;
      valueSig = '';
      inflight = null;
      generation++;
    },
  };
}

/** Enabled hosts from a raw `config.hosts` map, in the working-dirs route's shape
 *  (alias + label). `enabled` defaults to true when unset, as on the server. */
function hostSignature(hosts: Array<{ alias: string; label: string }>): string {
  return hosts.map((h) => `${h.alias}\u0000${h.label}`).sort().join('\u0001');
}

/**
 * Could this `config:changed` event have changed the configured host list?
 *
 * Writers that name a `key` (focus_bar, favorites, ordering, focus_tiers …) never
 * touch hosts, and they are the frequent ones. A full config write (Settings save,
 * `PUT /api/config`) carries the merged `config`: compare its enabled hosts to the
 * ones the picker already knows, so an unrelated Settings save costs nothing. A
 * partial `config` without a `hosts` key (a plugin's own settings) is not about
 * hosts. Anything else is unknown, and a refetch is cheap, so it says yes.
 */
export function configChangeMayAffectHosts(data: unknown, known: ConfiguredHost[] | null): boolean {
  const event = (data ?? {}) as { key?: unknown; config?: unknown };
  if (typeof event.key === 'string' && event.key !== 'hosts') return false;
  const config = event.config;
  if (!config || typeof config !== 'object') return true;
  if (!('hosts' in config)) return false;
  if (!known) return true;
  const raw = (config as { hosts?: unknown }).hosts;
  const next: Array<{ alias: string; label: string }> = [];
  if (raw && typeof raw === 'object') {
    for (const [alias, def] of Object.entries(raw as Record<string, unknown>)) {
      const h = (def ?? {}) as { enabled?: unknown; label?: unknown };
      if (h.enabled === false) continue;
      next.push({ alias, label: typeof h.label === 'string' ? h.label : alias });
    }
  }
  return hostSignature(next) !== hostSignature(known);
}

/**
 * Which hosts the picker should pre-warm now, and from which folder: the most
 * frequent history cwd per host (the server sorts `dirs` best-first), else `~/`
 * for a configured host with no history yet. Hosts in `warmed` were already
 * pre-warmed on this page and are skipped, so a host that appears later (added in
 * Settings) is warmed once without re-warming the others.
 */
export function hostsToPrewarm(result: WorkingDirsResult, warmed: ReadonlySet<string>): Array<[host: string, cwd: string]> {
  const best = new Map<string, string>();
  for (const d of result.dirs) {
    if (d.host && !best.has(d.host)) best.set(d.host, d.cwd);
  }
  for (const h of result.hosts) {
    if (!best.has(h.alias)) best.set(h.alias, '~/');
  }
  return Array.from(best).filter(([host]) => !warmed.has(host));
}
