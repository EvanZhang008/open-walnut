/**
 * Which host may hold the clock of a portable routine (always-on clock delegation).
 *
 * A routine bound to a host keeps its clock there (clock-placement.ts workHostOf). A
 * portable one (server API work: `placement.portable` on its claude-code config, or an
 * offline-run routine) has no host of its own, so while this Mac is awake it may hand its
 * clock to a host that stays up: that host's daemon fires on the schedule and, when the
 * Mac is asleep, starts the run itself (clock-host-start-v1). The routine's configured
 * host never changes: the Mac still takes the fire when it is awake and runs it as
 * before; only the clock (and the start the daemon makes without it) lives elsewhere.
 *
 * The host test is run-placement.ts's own (portableWorkOf, hostBlocker, walnutHomeOn),
 * plus what a clock needs on top: the `always-on` tag, and for a new handover a host
 * with room. Nothing here admits a slot: the clock's push reserves nothing, and the
 * host's own gate still runs when its run starts.
 *
 * A held clock is judged more gently than a new handover: a fact that is merely not
 * known (the host's capabilities, its Walnut home) keeps it where it is, because the
 * host's silence says nothing about the routine; only a plain "no" gives it back.
 */

import { LOCAL_HOST } from '../sessions/host-admission.js';
import { WALNUT_MCP_CAPABILITY } from '../sessions/walnut-mcp-mount.js';
import type { HostCapabilities } from '../hosts/capabilities.js';
import type { CronJob } from '../cron/types.js';
import type { RoutineLaunch } from '../types.js';
import {
  defaultRunPlacementDeps, hostBlocker, mapWalnutHomeCwd, portableWorkOf, routineLaunchPlacement, routinePlacementOf, walnutHomeOn,
  type PortableWork, type RunPlacementDeps,
} from './run-placement.js';
import { promptOf } from './trigger-push.js';

/** The capability tag a host must carry to hold a portable clock. */
export const ALWAYS_ON_TAG = 'always-on';

/** The session id of a host-started run is derived per slot (routine-run-ids.ts): hostBlocker is told one is promised. */
const SLOT_SESSION_ID = 'derived-per-slot';

/** The facts a host is judged by: all of them external, so a test names them without touching the clock handover. */
export interface PortableClockEnv {
  /** Host facts as run placement reads them (connection, grants, capabilities, engine, Walnut home). */
  run: RunPlacementDeps;
  /** The host has room for another run: true free, false busy, null not known. */
  free(host: string): Promise<boolean | null>;
  /**
   * Whether portable clocks may be delegated at all (the backup-leader switch,
   * `cloud_bridge.backup_leader`: off means nothing but the user's own hosts run Walnut work
   * while the Mac is away). Read before every push.
   */
  allowed(): Promise<boolean>;
}

/**
 * What a routine that is no claude-code run needs from the routines layer to be delegated:
 * the session/main-agent reflection routines a detached worker runs offline (offline-run.ts).
 * The routine's owner never moves; only its clock does.
 */
export interface OfflineClockWork {
  /** Sync and cheap: this routine's run may be done by a detached worker on any always-on host. */
  portable(job: CronJob): boolean;
  /** What the host starts while the Mac is away, its folder already in THAT host's Walnut home; null: not on that host. */
  startOf(job: CronJob, host: string): Promise<import('../../providers/trigger-clock-core.js').ClockStartSpec | null>;
  /**
   * The task whose conversation the start carries a sample of (its owner): placement watches it and
   * pushes again, at most once a minute, when it changes, so a sample armed on the host is not stale.
   * Absent or null: nothing to watch.
   */
  ownerOf?(job: CronJob): Promise<string | null>;
}

export type PortableKind = 'claude' | 'offline';

/** The host a claude-code routine's config names as its own (LOCAL_HOST: this Mac). */
export function sourceHostOf(config: Record<string, unknown>): string {
  const host = typeof config.host === 'string' ? config.host.trim() : '';
  return !host || host === 'local' ? LOCAL_HOST : host;
}

/**
 * The routine's claude-code config when it declares itself portable, else null. It may name a
 * source host: an unowned clock can be delegated in advance to any qualified always-on host.
 * A clock already accepted by its source stays there until that daemon releases it.
 */
export function portableClaudeConfigOf(job: CronJob): Record<string, unknown> | null {
  if (job.executor?.type !== 'claude-code') return null;
  const c = (job.executor.config ?? {}) as Record<string, unknown>;
  // A console agent's persona and init run are the Mac's until a host can do them.
  if (c.walnutAgent === true || (typeof c.agentId === 'string' && c.agentId.trim()) || (typeof c.titleTemplate === 'string' && c.titleTemplate.trim())) return null;
  const checked = routinePlacementOf(c.placement);
  return checked.ok && checked.placement?.portable ? c : null;
}

/**
 * How long one push may spend judging portable hosts in all (WALNUT_CLOCK_PORTABLE_MS): the facts
 * come over host links (engine readiness, load), and a push also carries every other
 * clock. Past it a host reads as "not known": a held clock stays, a new handover waits for the next push.
 */
export function portableBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WALNUT_CLOCK_PORTABLE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 10_000;
}

/** `work`'s result; null when there is none, undefined when it failed or is not done by `deadlineMs` (not known now, unlike a plain null). */
export async function withinBudget<T>(work: Promise<T> | null | undefined, deadlineMs: number): Promise<T | null | undefined> {
  if (!work) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadlineMs - Date.now()));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type Seat =
  | { ok: true; cwd?: string }
  /** `unknown`: the host's silence, not a no: a held clock stays. */
  | { ok: false; why: string; unknown: boolean };

const no = (why: string, unknown = false): Seat => ({ ok: false, why, unknown });

/**
 * Whether `host` may hold this portable routine's clock now. `held`: the clock is already
 * there, so room is not asked and a fact not known keeps it. A claude kind also returns the
 * folder mapped into the host's Walnut home.
 */
export async function portableSeatOf(
  job: CronJob, kind: PortableKind, host: string, env: PortableClockEnv, opts: { held: boolean; deadlineMs?: number },
): Promise<Seat> {
  const left = opts.deadlineMs === undefined ? portableBudgetMs() : opts.deadlineMs - Date.now();
  if (left <= 0) return no('the placement budget of this push is spent', true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      judge(job, kind, host, env, opts),
      new Promise<Seat>((resolve) => {
        timer = setTimeout(() => resolve(no('its facts took longer than the placement budget', true)), left);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function judge(job: CronJob, kind: PortableKind, host: string, env: PortableClockEnv, opts: { held: boolean }): Promise<Seat> {
  const run = env.run;
  const config = kind === 'claude' ? portableClaudeConfigOf(job) : null;
  const message = promptOf(job);
  let work: PortableWork;
  let launch: RoutineLaunch;
  let cwd: string | undefined;
  const source = config ? sourceHostOf(config) : LOCAL_HOST;
  if (kind === 'claude') {
    if (!config) return no('it is not a portable claude-code routine');
    launch = {
      message, cwd: typeof config.cwd === 'string' ? config.cwd.trim() : '', source: 'routine', jobId: job.id,
      ...(source !== LOCAL_HOST ? { host: source } : {}),
      ...(typeof config.model === 'string' && config.model.trim() ? { model: config.model.trim() } : {}),
      ...(typeof config.project === 'string' && config.project.trim() ? { project: config.project.trim() } : {}),
      ...routineLaunchPlacement(config, message),
    };
    const portable = await portableWorkOf(launch, source, run);
    if ('stays' in portable) return no(portable.stays);
    work = portable.work;
  } else {
    work = { what: 'an offline routine', daemon: [WALNUT_MCP_CAPABILITY], tags: [] };
    launch = { message, cwd: await run.localHome(), source: 'routine', jobId: job.id };
  }
  const card = await run.capabilities(host);
  if (!card) return no('its capabilities are not known', true);
  if (!card.tags.includes(ALWAYS_ON_TAG)) return no(`it is not ${ALWAYS_ON_TAG}`, card.unknown.includes(ALWAYS_ON_TAG));
  if (!await walnutHomeOn(host, run)) return no('its Walnut home is not known yet', true);
  const blocked = await hostBlocker(host, { ...work, tags: [...new Set([...work.tags, ALWAYS_ON_TAG])] }, launch, { preassignedSessionId: SLOT_SESSION_ID }, run);
  if (blocked) return no(blocked);
  if (kind === 'claude') {
    cwd = (await mapWalnutHomeCwd(launch.cwd, source, host, run)) ?? undefined;
    if (!cwd) return no('its folder has no place in that host\'s Walnut home');
  }
  if (!opts.held) {
    const free = await env.free(host);
    if (free !== true) return no(free === false ? 'it has no room' : 'its load is not known');
    // The host starts the run in this folder and expects it to be there (a fresh account has no routines folder yet).
    if (cwd) {
      try {
        await run.ensureDir(cwd, host);
      } catch (err) {
        return no(`its folder could not be made (${err instanceof Error ? err.message : String(err)})`, true);
      }
    }
  }
  return { ok: true, ...(cwd ? { cwd } : {}) };
}

// ── real wiring ──

let overrides: Partial<PortableClockEnv> | null = null;
/** Test seam: external facts a test names in place of the real readers (the rest stay real). */
export function __setPortableClockEnvForTesting(next: Partial<PortableClockEnv> | null): void { overrides = next; }

/**
 * The capabilities a host is known by: the fleet's last read, else what the user declared plus its
 * probe. A cached card is as old as the last fleet read, so what the config declares now is
 * merged into it: a tag the user added since (always-on) counts at once, never after the next read.
 */
export async function capabilitiesOf(host: string, base: Pick<RunPlacementDeps, 'capabilities'>): Promise<HostCapabilities | null> {
  const [{ getConfig }, { hostCapabilities, normalizeTag }] = await Promise.all([import('../config-manager.js'), import('../hosts/capabilities.js')]);
  const def = (await getConfig()).hosts?.[host];
  const cached = await base.capabilities(host);
  if (cached) {
    const declared = (Array.isArray(def?.capabilities) ? def.capabilities : []).map(normalizeTag).filter((t): t is string => !!t);
    const add = declared.filter((t) => !cached.tags.includes(t));
    if (add.length === 0) return cached;
    const alwaysOn = declared.includes(ALWAYS_ON_TAG);
    return {
      ...cached, tags: [...cached.tags, ...add], declared: [...new Set([...cached.declared, ...declared])],
      ...(alwaysOn ? { alwaysOn: true, unknown: cached.unknown.filter((u) => u !== ALWAYS_ON_TAG) } : {}),
    };
  }
  if (!def) return null;
  const { readHostProfile } = await import('../hosts/host-profile.js');
  const profile = await readHostProfile(host).catch(() => null);
  return hostCapabilities({ probed: profile?.probed, kind: profile?.kind, local: false, week: null, declared: def.capabilities });
}

export function defaultPortableClockEnv(): PortableClockEnv {
  const base = defaultRunPlacementDeps();
  const real: PortableClockEnv = {
    run: {
      ...base,
      capabilities: (host) => capabilitiesOf(host, base),
      // The hello's home may be unknown on a link that is up (a direct one): the probe knows it too.
      async remoteHome(host) {
        const home = await base.remoteHome(host);
        if (home) return home;
        const { readHostProfile } = await import('../hosts/host-profile.js');
        return (await readHostProfile(host).catch(() => null))?.probed?.home ?? null;
      },
    },
    async free(host) {
      const { hostLoads } = await import('../hosts/placement.js');
      const view = (await hostLoads({ hosts: [host] }))[0];
      return view?.known ? !view.busy : null;
    },
    async allowed() {
      const { backupLeaderAllowed } = await import('../leader/primary-leader.js');
      return backupLeaderAllowed();
    },
  };
  return { ...real, ...(overrides ?? {}), run: overrides?.run ?? real.run };
}
