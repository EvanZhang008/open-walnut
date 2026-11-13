/**
 * Where a routine's run starts when the host it names is full (2026-11-13: an Inbox Triage
 * run waited hours on a full Mac, "all 7 slots taken", while clouddev had room).
 *
 * One rule, one place: admitRoutineLaunch admits the run on the host its launch names, and
 * only when that host refuses it for room (HostsFullError) and the work can run anywhere does
 * it look for another host. The choice is load placement's own (hosts/placement.ts
 * choosePlacement over hostLoads): a host with room, never one that is busy, unknown or
 * weighted "never". A host it names must also pass hostBlocker:
 *   - connected now (a cached load reading can outlive the link);
 *   - not closed to work from other hosts (hosts/exec-grants.ts);
 *   - the daemon capabilities and fleet tags the work needs (one not known is a no);
 *   - the engine the run would start on THERE installed and ready (engine-switch.ts
 *     switchHostBlocker, host-readiness claudeSessionBlocker), taking the same kind of session
 *     id the run already holds (a minted id needs an engine that takes one);
 *   - its Walnut home known (the run's folder is mapped into it).
 * The chosen host is then admitted through the same slot lock as any start
 * (sessions/host-admission.ts): one that filled up meanwhile refuses, and the next is tried.
 * When none takes it, the caller gets the named host's own refusal and its capacity wait goes
 * on as before. Nothing here starts a session: the host gate, credentials and the engine's own
 * checks still run in quickStartSession, on the host chosen.
 *
 * A named host that is asleep or unreachable (its link down for 30 s of awake time, sourceDownReason) is unavailable
 * the same way, for an automatic run: it is never admitted on there (a spawn there would only
 * fail), portable work takes the same search with placement told that host cannot keep it and
 * goes only to a host tagged always-on (this Mac too only when its card says so), and
 * a run kept there gets a HostsFullError with that reason (no slot words): its capacity wait holds
 * it until the host is back. A person's start is exempt, as from the slots.
 *
 * What may move: server API work, done through Walnut's tools in Walnut's home. A routine says
 * so itself (`placement: { portable: true, capabilities }` on its claude-code config, carried on
 * the launch: RoutinePlacement), and console agents registered in PORTABLE_AGENT_WORK are
 * covered without it (Inbox Triage: its batch, notes and letters are Walnut API calls, so the
 * routine already stored moves as it is). Even then a run keeps its host when its folder is not
 * Walnut's home, or its instructions (requirementsText, not the batch it carries) name files on
 * its machine or the Mac's tools. Everything else keeps its host too: an org start, a task that
 * already has a session (its conversation, or a spawn whose outcome is unknown).
 */

import { log } from '../../logging/index.js';
import { normalizeTag, type HostCapabilities } from '../hosts/capabilities.js';
import { namedPaths, namesTooManyPaths } from '../hosts/named-paths.js';
import type { PlacementDecision, choosePlacement } from '../hosts/placement.js';
import { HostsFullError, LOCAL_HOST } from '../sessions/host-admission.js';
import { WALNUT_MCP_CAPABILITY } from '../sessions/walnut-mcp-mount.js';
import { TRIAGE_AGENT_ID } from '../triage/types.js';
import type { RoutineLaunch, RoutinePlacement, SessionEngine } from '../types.js';

/** Most capability tags one routine may require. */
const MAX_CAPABILITIES = 16;

/**
 * A routine config's `placement`, checked and normalized: undefined when absent or not portable
 * (its runs keep their host), an error for a shape or tag that is not one.
 */
export function routinePlacementOf(raw: unknown): { ok: true; placement?: RoutinePlacement } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'placement must be an object: { portable: true, capabilities?: ["tag", ...] }' };
  const p = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(p).filter((k) => k !== 'portable' && k !== 'capabilities');
  if (unknownKeys.length) return { ok: false, error: `placement has no field ${unknownKeys.join(', ')} (it takes portable and capabilities)` };
  if (p.portable !== undefined && typeof p.portable !== 'boolean') return { ok: false, error: 'placement.portable must be true or false' };
  if (p.capabilities !== undefined && !Array.isArray(p.capabilities)) return { ok: false, error: 'placement.capabilities must be a list of capability tags' };
  const raws = (p.capabilities as unknown[] | undefined) ?? [];
  const tags: string[] = [];
  for (const t of raws) {
    const tag = normalizeTag(t);
    if (!tag) return { ok: false, error: `placement.capabilities: ${JSON.stringify(t)} is not a capability tag (lower case letters, digits and : . _ -, e.g. "linux", "mcp:slack")` };
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_CAPABILITIES) return { ok: false, error: `placement.capabilities names more than ${MAX_CAPABILITIES} tags` };
  if (p.portable !== true) {
    return tags.length ? { ok: false, error: 'placement.capabilities only applies with placement.portable: true' } : { ok: true };
  }
  return { ok: true, placement: { portable: true, ...(tags.length ? { capabilities: tags } : {}) } };
}

/**
 * The placement fields every routine launch carries (the claude-code executor, an isolated
 * cron run): the routine's declaration, and, for a run that may move, its own instructions when
 * the message carries more than them (an init processor's batch). An invalid stored declaration
 * counts as none; a run that may not move carries neither (its launch is as before).
 */
export function routineLaunchPlacement(
  config: { placement?: unknown; instructions?: unknown; walnutAgent?: unknown; agentId?: unknown }, message: string,
): Pick<RoutineLaunch, 'placement' | 'requirementsText'> {
  const checked = routinePlacementOf(config.placement);
  const placement = checked.ok ? checked.placement : undefined;
  const registered = config.walnutAgent === true && typeof config.agentId === 'string' && !!PORTABLE_AGENT_WORK[config.agentId];
  const instructions = typeof config.instructions === 'string' ? config.instructions : '';
  return {
    ...(placement ? { placement } : {}),
    ...((placement || registered) && instructions.trim() && instructions !== message ? { requirementsText: instructions } : {}),
  };
}

/** What portable work needs of the host it moves to. */
export interface PortableWork {
  /** Its name in a log line or reason. */
  what: string;
  /** Daemon capabilities a remote host must advertise (this Mac's own server needs none). */
  daemon: readonly string[];
  /** Fleet capability tags (hosts/capabilities.ts) the host must carry. */
  tags: readonly string[];
}

/**
 * Console agents whose routine runs are server API work, by agent id: the routine already
 * stored (no field of its own says it may move) is covered as it is.
 */
export const PORTABLE_AGENT_WORK: Readonly<Record<string, PortableWork & {
  /** Its own instructions in a message that carries no requirementsText (a launch stored before it existed). */
  instructionsOf?: (message: string) => Promise<string | undefined>;
}>> = {
  [TRIAGE_AGENT_ID]: {
    what: 'Inbox Triage', daemon: [WALNUT_MCP_CAPABILITY], tags: [],
    // The batch comes first, the routine's instructions after it (cron: `initOutput + "\n\n" + instructions`).
    async instructionsOf(message) {
      const { TRIAGE_RUN_INSTRUCTIONS } = await import('../triage/bootstrap.js');
      const at = message.indexOf(TRIAGE_RUN_INSTRUCTIONS.split('\n')[0]);
      return at >= 0 ? message.slice(at) : undefined;
    },
  },
};

/** Walnut's home under a remote account's home (the daemon's `~/.open-walnut`). */
const REMOTE_HOME_DIR = '.open-walnut';

/** Passed through to every admission, on the named host and on each host tried after it. */
export interface AdmitOptions { automatic: boolean; respectWaiting?: boolean; routine?: boolean }

export interface RunPlacementDeps {
  /** Admit one start on a host (sessions/host-admission.ts admitHostStart). */
  admit(id: string, host: string, opts: AdmitOptions): Promise<(holdMs?: number) => void>;
  /** Load placement's choice (hosts/placement.ts choosePlacement). */
  place(input: Parameters<typeof choosePlacement>[0]): Promise<PlacementDecision | null>;
  /** The host's daemon is connected now. */
  connected(host: string): Promise<boolean>;
  /** Whether its connected daemon advertises `cap`; null when not connected. */
  hasDaemonCap(host: string, cap: string): Promise<boolean | null>;
  /** Its account's home folder, as its daemon reported it; null when unknown. */
  remoteHome(host: string): Promise<string | null>;
  /** The user closed it to work from other hosts. */
  closed(host: string): Promise<boolean>;
  /** Its fleet capabilities, null when no card was read for it. */
  capabilities(host: string): Promise<HostCapabilities | null>;
  /** The engine the launch would start on there (undefined = Claude Code). */
  engineOn(host: string, launch: RoutineLaunch): Promise<SessionEngine | undefined>;
  /** Why that engine cannot start there on Walnut's own pick, or null. */
  engineBlocker(host: string, engine: SessionEngine | undefined): Promise<string | null>;
  /** The engine takes a session id Walnut minted (false: it issues its own). */
  takesMintedId(engine: SessionEngine | undefined): Promise<boolean>;
  /** The task has a session that ran, runs, or may still come up (a spawn of unknown outcome); a start known to have failed does not count. */
  hasSession(taskId: string): Promise<boolean>;
  /** Make the folder on the host (idempotent). */
  ensureDir(dir: string, host: string): Promise<void>;
  /** This server's Walnut home. */
  localHome(): Promise<string>;
  /**
   * Why a remote host cannot take work now (asleep or unreachable: its link was lost), with its
   * name, or null when it can or that is not known (a link never made here may be dialled).
   */
  unavailable(host: string): Promise<{ label: string; reason: string } | null>;
}

export interface RoutineAdmission {
  /** The launch to start: the one given when it stayed, else with the host and folder chosen. */
  launch: RoutineLaunch;
  /** The admitted slot; call it once the start settled (spawned or failed). */
  release: (holdMs?: number) => void;
  /** The admission key of the host it runs on ('__local__' or the alias). */
  host: string;
  moved: boolean;
  /** Why it moved. */
  reason?: string;
}

export interface AdmitRoutineOpts {
  /** The admission id (the run's task, or `routine-run:<sid>`). */
  admissionId: string;
  admit: AdmitOptions;
  /** The run's existing task: it may move only while no session of it ran or may still come up (hasSession). */
  existingTaskId?: string;
  /** The session id the caller minted for the run: a host it moves to must take one. */
  preassignedSessionId?: string;
  /** The caller pins the host. */
  keepHost?: boolean;
}

const keyOf = (host: string | undefined | null): string => (!host || host === 'local' ? LOCAL_HOST : host);
const trim = (p: string): string => p.replace(/\/+$/, '') || '/';
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir === '/' ? '' : dir}/`);

/** The host's Walnut home, or null when not known (a remote host that has not said its home). */
export async function walnutHomeOn(host: string, deps: Pick<RunPlacementDeps, 'localHome' | 'remoteHome'>): Promise<string | null> {
  if (host === LOCAL_HOST) return trim(await deps.localHome());
  const home = await deps.remoteHome(host);
  return home && home.startsWith('/') && trim(home) !== '/' ? `${trim(home)}/${REMOTE_HOME_DIR}` : null;
}

/** The same place in `to`'s Walnut home as `cwd` is in `from`'s, or null. */
export async function mapWalnutHomeCwd(cwd: string, from: string, to: string, deps: Pick<RunPlacementDeps, 'localHome' | 'remoteHome'>): Promise<string | null> {
  const [src, dst] = await Promise.all([walnutHomeOn(from, deps), walnutHomeOn(to, deps)]);
  const c = trim(cwd);
  if (!src || !dst || !under(c, src)) return null;
  return `${dst}${c.slice(src.length)}`;
}

/** The portable work a launch is and the text its needs were read from, or why it keeps its host. */
export async function portableWorkOf(
  launch: RoutineLaunch, from: string, deps: Pick<RunPlacementDeps, 'localHome' | 'remoteHome'>,
): Promise<{ work: PortableWork; text: string } | { stays: string }> {
  if (launch.source === 'org-autostart') return { stays: 'an org start keeps its host' };
  const agent = launch.walnutAgent && launch.agentId ? PORTABLE_AGENT_WORK[launch.agentId] : undefined;
  // A stored launch (a capacity wait, a retry) is read again: one not valid now declares nothing.
  const checked = launch.placement === undefined ? null : routinePlacementOf(launch.placement);
  if (checked && !checked.ok) return { stays: `its placement is not valid (${checked.error})` };
  const declared = checked?.ok ? checked.placement : undefined;
  if (!agent && !declared) return { stays: 'it is not declared portable' };
  const work: PortableWork = {
    what: agent?.what ?? 'a portable routine',
    daemon: [...new Set([WALNUT_MCP_CAPABILITY, ...(agent?.daemon ?? [])])],
    tags: [...new Set([...(agent?.tags ?? []), ...(declared?.capabilities ?? [])])],
  };
  const home = await walnutHomeOn(from, deps);
  if (!home || !under(trim(launch.cwd), home)) return { stays: `its folder ${launch.cwd} is not Walnut's home` };
  // The routine's own instructions say what the run needs; the batch an init processor put in
  // front of them is mail and history (an iOS release note, a calendar), not this run's needs.
  const text = launch.requirementsText ?? await agent?.instructionsOf?.(launch.message).catch(() => undefined) ?? launch.message;
  const { needsMacTools } = await import('../hosts/placement.js');
  if (needsMacTools(text, launch.cwd)) return { stays: 'it needs this Mac\'s tools' };
  // Walnut's own files (a note, the batch's state) are its API's, reached from any host. A note
  // named as `notes/Walnut/...` is no path at all (named-paths.ts counts only absolute ones). Any
  // other absolute path the run names is a file on its machine it may read.
  if (namesTooManyPaths(text, launch.cwd)) return { stays: 'it names more files than placement checks' };
  const homes = [home, trim(await deps.localHome()), `~/${REMOTE_HOME_DIR}`];
  const local = namedPaths(text, (p) => !homes.some((h) => under(trim(p), h)), { cwd: launch.cwd });
  if (local.length) return { stays: `it names ${local.slice(0, 3).join(', ')}, which may be only on its host` };
  return { work, text };
}

/** Why `host` cannot take the work, or null. */
export async function hostBlocker(
  host: string, work: PortableWork, launch: RoutineLaunch, opts: Pick<AdmitRoutineOpts, 'preassignedSessionId'>, deps: RunPlacementDeps,
): Promise<string | null> {
  if (host !== LOCAL_HOST) {
    if (!await deps.connected(host)) return 'it is not connected';
    if (await deps.closed(host)) return 'it is closed to work from other hosts';
    for (const cap of work.daemon) {
      const has = await deps.hasDaemonCap(host, cap);
      if (has === null) return 'it is not connected';
      if (!has) return `its daemon lacks ${cap}`;
    }
  }
  if (work.tags.length) {
    const c = await deps.capabilities(host);
    if (!c) return `its capabilities are not known (${work.what} needs ${work.tags.join(', ')})`;
    const lacks = work.tags.filter((t) => !c.tags.includes(t));
    if (lacks.length) return `it does not have ${lacks.join(', ')}`;
  }
  if (!await walnutHomeOn(host, deps)) return 'its Walnut home is not known yet';
  const engine = await deps.engineOn(host, launch);
  // The run's session id is already promised: the engine there must take it, or, with none, issue its own.
  if (await deps.takesMintedId(engine) !== !!opts.preassignedSessionId) {
    return opts.preassignedSessionId ? 'its engine issues its own session ids, and this run already has one' : 'its engine needs a session id this run does not have';
  }
  return deps.engineBlocker(host, engine);
}

/** How many hosts one run tries after its own (each a placement read and an admission). */
const MAX_TRIES = 8;

/**
 * How long the search for another host may take in all (WALNUT_ROUTINE_PLACE_MS): a routine's
 * delivery waits on it, so a host that does not answer never holds it longer. Past it the run
 * keeps the named host's refusal (its capacity wait).
 */
export function placementBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WALNUT_ROUTINE_PLACE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 12_000;
}

class PlacementTimeout extends Error {}

/** `work`, or a PlacementTimeout once `deadline` passed; `late` gets a result that came after it. */
async function bounded<T>(work: Promise<T>, deadline: number, what: string, late?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new PlacementTimeout(`${what} took longer than the placement budget`)); }, Math.max(0, deadline - Date.now()));
      timer.unref?.();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) void work.then((v) => late?.(v), () => undefined);
  }
}

/** How long a lost link may be down before its host counts as unavailable: a moment's drop is likely reconnecting. */
export const SOURCE_DOWN_AFTER_MS = 30_000;
const SOURCE_DOWN_REASON = 'it is not connected (asleep or unreachable)';
/** The fleet tag of a host that stays up (hosts/capabilities.ts). */
const ALWAYS_ON_TAG = 'always-on';

/**
 * Why a remote host whose link is not up counts as unavailable, by this machine's AWAKE time its
 * link that was up has been down (daemon-connection.ts getDaemonDisconnectedAwakeMs), or null.
 * Never wall-clock time: a Mac that slept 8 h and has not relinked yet is no proof the host is
 * gone. 0 (a link never made here, which the start may dial; one up now) and a drop under
 * SOURCE_DOWN_AFTER_MS (likely reconnecting) are not known to be down. Words without live
 * numbers: a waiting entry keeps them.
 */
export function sourceDownReason(awakeDownMs: number): string | null {
  return Number.isFinite(awakeDownMs) && awakeDownMs >= SOURCE_DOWN_AFTER_MS ? SOURCE_DOWN_REASON : null;
}

/**
 * Admit a routine's run: on the host its launch names, else (that host full, or for an
 * automatic run unavailable, and the work portable) on the host placement picks that passes
 * hostBlocker and admits it. An unavailable host is never admitted on, so a run kept there is
 * refused with a HostsFullError saying why (no slot words) and waits like one on a full host.
 * Throws the named host's refusal when nothing else takes it, or when the search ran past
 * placementBudgetMs (a slot taken after that is given back).
 */
export async function admitRoutineLaunch(
  launch: RoutineLaunch, opts: AdmitRoutineOpts, deps: RunPlacementDeps = defaultRunPlacementDeps(),
): Promise<RoutineAdmission> {
  const from = keyOf(launch.host);
  // A person's start goes to the host it names whatever it is doing (its errors are theirs to read).
  let deadline = Date.now() + placementBudgetMs();
  const down = opts.admit.automatic && from !== LOCAL_HOST
    ? await bounded(deps.unavailable(from), deadline, 'reading whether its host answers').catch((err: unknown) => {
      // Not known: the start goes on as before.
      log.cron.debug('routine placement: whether its host answers is not known', { host: from, error: err instanceof Error ? err.message : String(err) });
      return null;
    })
    : null;
  let refused: HostsFullError;
  if (down) {
    refused = new HostsFullError(`Not started: ${down.label} cannot take it (${down.reason}).`, { taskId: opts.admissionId, host: from, label: down.label, reason: down.reason });
  } else {
    try {
      return { launch, release: await deps.admit(opts.admissionId, from, opts.admit), host: from, moved: false };
    } catch (err) {
      if (!(err instanceof HostsFullError)) throw err;
      refused = err;
    }
    deadline = Date.now() + placementBudgetMs();
  }
  if (opts.keepHost) throw refused;
  try {
    return await searchElsewhere(launch, opts, deps, from, refused, !!down, deadline);
  } catch (err) {
    if (!(err instanceof PlacementTimeout)) throw err;
    log.cron.warn('routine placement: the search for another host ran out of time; the run keeps its host', { host: from, jobId: launch.jobId, why: refused.detail.reason, error: err.message });
    throw refused;
  }
}

async function searchElsewhere(
  launch: RoutineLaunch, opts: AdmitRoutineOpts, deps: RunPlacementDeps, from: string, refused: HostsFullError, unavailable: boolean, deadline: number,
): Promise<RoutineAdmission> {
  // A task that has a session keeps its host: its conversation is there, or a spawn whose outcome is unknown.
  if (opts.existingTaskId && await bounded(deps.hasSession(opts.existingTaskId), deadline, 'reading its sessions').catch((e: unknown) => {
    if (e instanceof PlacementTimeout) throw e;
    return true;
  })) throw refused;
  const portable = await bounded(portableWorkOf(launch, from, deps), deadline, 'reading what the run needs');
  if ('stays' in portable) {
    log.cron.debug('routine placement: the run keeps its host', { host: from, jobId: launch.jobId, refused: refused.detail.reason, why: portable.stays });
    throw refused;
  }
  // Work leaving a host that is asleep goes only to a host that stays up (fleet tag always-on,
  // hosts/capabilities.ts): a laptop could sleep the same way. A full host's work goes anywhere it fits.
  const work: PortableWork = unavailable
    ? { ...portable.work, tags: [...new Set([...portable.work.tags, ALWAYS_ON_TAG])] }
    : portable.work;
  const tried = new Map<string, string>([[from, unavailable ? refused.detail.reason : 'it is the full host']]);
  for (let round = 0; round < MAX_TRIES; round++) {
    const decision = await bounded(deps.place({
      defaultHost: from === LOCAL_HOST ? '' : from, text: portable.text, cwd: launch.cwd, toolsOnly: true,
      // Placement never keeps the work on a host that cannot take it now.
      ...(unavailable ? { unavailable: refused.detail.reason } : {}),
      eligible: async (host) => tried.get(host) ?? hostBlocker(host, work, launch, opts, deps),
    }), deadline, 'choosing a host').catch((err: unknown) => {
      if (err instanceof PlacementTimeout) throw err;
      log.cron.warn('routine placement: no host could be chosen', { error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (!decision?.moved) break;
    const to = keyOf(decision.host);
    if (tried.has(to)) break;
    const cwd = await bounded(mapWalnutHomeCwd(launch.cwd, from, to, deps), deadline, 'mapping its folder').catch((e: unknown) => {
      if (e instanceof PlacementTimeout) throw e;
      return null;
    });
    if (!cwd) {
      tried.set(to, 'its Walnut home is not known');
      continue;
    }
    let release: (holdMs?: number) => void;
    try {
      // An admission that answers after the budget is given back at once.
      release = await bounded(deps.admit(opts.admissionId, to, opts.admit), deadline, `admitting it on ${to}`, (late) => late());
    } catch (err) {
      if (!(err instanceof HostsFullError)) throw err;
      // Filled up between placement's reading and its slot lock: the next host.
      tried.set(to, `it filled up first (${err.detail.reason})`);
      continue;
    }
    // From here the slot is held: every way out but the return gives it back.
    let gone: string | null;
    try {
      gone = await bounded(deps.ensureDir(cwd, to), deadline, `making ${cwd} on ${to}`)
        .then(() => null, (e: unknown) => {
          if (e instanceof PlacementTimeout) throw e;
          return `its folder could not be made (${e instanceof Error ? e.message : String(e)})`;
        });
      // The link may have dropped while the slot was taken and the folder made.
      gone ??= to !== LOCAL_HOST && !await bounded(deps.connected(to), deadline, 'checking its link').catch((e: unknown) => {
        if (e instanceof PlacementTimeout) throw e;
        return false;
      }) ? 'it disconnected' : null;
    } catch (err) {
      release();
      throw err;
    }
    if (gone) {
      release();
      tried.set(to, gone);
      continue;
    }
    const placed: RoutineLaunch = { ...launch, cwd };
    if (to === LOCAL_HOST) delete placed.host;
    else placed.host = to;
    const view = decision.hosts.find((h) => h.host === to);
    const reason = `${refused.detail.label ?? from} ${unavailable ? 'cannot take it' : 'has no room'} (${refused.detail.reason}); ${view?.label ?? (to === LOCAL_HOST ? 'this Mac' : to)} has room`
      + (view ? ` (${view.running} of ${view.runningLimit} slots taken)` : '');
    log.cron.info('routine placement: the run starts on another host', { from, to, jobId: launch.jobId, what: work.what, cwd, reason });
    return { launch: placed, release, host: to, moved: true, reason };
  }
  throw refused;
}

/**
 * The engine a routine launch starts on at `host`, decided as quickStartSession decides it for
 * a launch that names none: the project's launch defaults (not for a console agent's run), else
 * the host's default engine, or its fallback while out of usage (a model-less routine run that
 * is no console agent's). undefined = Claude Code.
 */
export async function routineEngineOn(host: string, launch: Pick<RoutineLaunch, 'model' | 'project' | 'walnutAgent' | 'source'>): Promise<SessionEngine | undefined> {
  const h = host === LOCAL_HOST ? undefined : host;
  const [{ getConfig }, { resolveDefaultEngine }, { normalizeEngine }, fallbackEngine] = await Promise.all([
    import('../config-manager.js'), import('../agents/default-engine.js'), import('../agents/engine-registry.js'), import('../agents/fallback-engine.js'),
  ]);
  const config = await getConfig();
  const modelless = !launch.model || launch.model === 'default';
  if (!launch.walnutAgent && launch.project) {
    const { hasLaunchDefaults, pickLaunchDefaults, projectLaunchDefaultsOf } = await import('../sessions/project-launch-defaults.js');
    if (hasLaunchDefaults(await projectLaunchDefaultsOf(launch.project))) {
      const pick = await pickLaunchDefaults({ config, project: launch.project, host: h, named: { model: launch.model }, decidesFallback: modelless });
      return normalizeEngine(pick.engine);
    }
  }
  const inherited = resolveDefaultEngine(config, { host: h });
  const decides = modelless && fallbackEngine.selfDecidesFallback(launch.source, launch.walnutAgent);
  const fallback = decides ? await fallbackEngine.resolveFallbackLaunch(config, inherited, h, { quiet: true }).catch(() => null) : null;
  return normalizeEngine(fallback?.engine ?? inherited);
}

/** Test seam: host facts a test names in place of the real readers (the rest stay real). */
let overrides: Partial<RunPlacementDeps> | null = null;
export function __setRunPlacementDepsForTesting(next: Partial<RunPlacementDeps> | null): void { overrides = next; }

/** The real wiring, with any test overrides on top. */
export function defaultRunPlacementDeps(): RunPlacementDeps {
  return { ...realDeps(), ...(overrides ?? {}) };
}

function realDeps(): RunPlacementDeps {
  const conn = async (host: string) => (await import('../../providers/daemon-connection.js')).getConnectedDaemonConnection(host);
  return {
    async admit(id, host, opts) {
      const { admitHostStart } = await import('../sessions/host-admission.js');
      return admitHostStart(id, host, opts);
    },
    async place(input) {
      const placement = await import('../hosts/placement.js');
      return placement.choosePlacement(input);
    },
    connected: async (host) => !!await conn(host),
    hasDaemonCap: async (host, cap) => {
      const c = await conn(host);
      return c ? c.hasCapability(cap) : null;
    },
    remoteHome: async (host) => (await conn(host))?.remoteHome ?? null,
    closed: async (host) => (await import('../hosts/exec-grants.js')).isHostClosed(host),
    async capabilities(host) {
      // The fleet's last read (host_list, the Fleet page): a host no card was read for is unknown.
      const { lastFleetRead } = await import('../hosts/fleet.js');
      return lastFleetRead()?.cards.find((c) => c.host === host)?.capabilities ?? null;
    },
    engineOn: (host, launch) => routineEngineOn(host, launch),
    async engineBlocker(host, engine) {
      const { switchHostBlocker } = await import('../sessions/engine-switch.js');
      const blocked = await switchHostBlocker(host, engine ?? 'claude');
      if (blocked) return blocked;
      if ((engine ?? 'claude') !== 'claude') return null;
      const { claudeSessionBlocker } = await import('../hosts/host-readiness.js');
      return claudeSessionBlocker(host);
    },
    takesMintedId: async (engine) => (await import('../agents/engine-registry.js')).engineCaps(engine).idProvisioning !== 'provider-issued',
    async hasSession(taskId) {
      // Only a record whose start is known to have failed (it never ran, run-start.ts) frees it:
      // one that ran, runs, or may still come up (spawn outcome unknown) keeps the host.
      const [{ getSessionsForTask }, { startVerdictOf }] = await Promise.all([import('../session-tracker.js'), import('./run-start.js')]);
      return (await getSessionsForTask(taskId)).some((s) => startVerdictOf(s).kind !== 'failed');
    },
    async ensureDir(dir, host) {
      // The one thing sent on its link here: asked first, so a link that died out of sight is
      // passed over (quiet-link-ratchet), not waited on until the budget runs out.
      if (host !== LOCAL_HOST) {
        const { hostLinkAnswers } = await import('../hosts/remote-read-bound.js');
        if (!await hostLinkAnswers(host)) throw new Error('its link did not answer');
      }
      const { ensureCwd } = await import('../sessions/ensure-cwd.js');
      await ensureCwd(dir, host === LOCAL_HOST ? undefined : host);
    },
    localHome: async () => (await import('../../constants.js')).WALNUT_HOME,
    async unavailable(host) {
      // Only the link facts this server holds: nothing is dialled to ask (the start itself would dial).
      if (host === LOCAL_HOST || await conn(host)) return null;
      const { getDaemonDisconnectedAwakeMs } = await import('../../providers/daemon-connection.js');
      const reason = sourceDownReason(getDaemonDisconnectedAwakeMs(host));
      if (!reason) return null;
      const [{ getConfig }, { hostDisplayName }] = await Promise.all([import('../config-manager.js'), import('../hosts/host-display-name.js')]);
      return { label: hostDisplayName(host, (await getConfig()).hosts?.[host]?.label), reason };
    },
  };
}
