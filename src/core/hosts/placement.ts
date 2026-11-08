/**
 * Where a task's first session runs, by load (2026-10-31, the user: "it is overloaded
 * why u keep put it in mac?", "they can load balance we should be able to"). The Mac
 * ran 14 task sessions at load 400 to 800 while clouddev sat idle, because every start
 * took its project's default host (or its lead's) whatever that host was doing.
 *
 * The rule, decided on the leader (one answer for every surface, never a different one
 * per client):
 *   - a start that names a host, a task that already has a session, and Mac-only work
 *     (iOS, the Mac app, the user's screen) are never placed;
 *   - otherwise the host the start would use keeps it while it is under every cap;
 *   - over a cap, the eligible host with the most room takes it, when one is under
 *     every cap; when none is, the start stays where it was (no worse place to go).
 * Caps (each env-tunable): load average per CPU 3 (the macOS load also counts threads
 * stalled on memory, which CPU use alone misses; over the cap, only our own processes' share
 * of it counts, hosts/own-load.ts), CPU busy 95%, memory available 5%,
 * free disk 20 GB, and the host's slots (hostSlots: sessions in a turn at once). A host's
 * numbers come from its daemon (`host.load`, 'host-load-v1'), the Mac's from this
 * process; one older than 15 s is asked again, and a host that does not answer in 4 s
 * is unknown and never chosen. A placed task keeps its host (no rebalancing), and
 * each host carries a weight (config placement_weights: 100 prefer, 50 normal, 25 less
 * often, 0 never) that scales its room score.
 *
 * Files first (2026-11-05, hosts/named-paths.ts): a move for load never goes to a host
 * with fewer of the files the task names than the host it leaves, and a file written in
 * a task's own directory (a brief) takes the work to the host that has it, from a host
 * with room too.
 *
 * Slots per host (2026-11-05, the user: "per host can handle x amount ... make limit per
 * host, and auto able to assign based on each host"): each host runs as many sessions in a
 * turn as its cores and memory allow (hostSlots), counting the starts admitted there and not
 * yet running (sessions/host-admission.ts). An automatic start that finds its host full waits
 * in the start queue; a person's own start never does.
 */
import os from 'node:os';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { log } from '../../logging/index.js';
import type { HostLoad } from '../../providers/host-facts-core.js';
import { isWorkFile, pathsOnHost, type PathsOnHost } from './named-paths.js';
import { ownLoadPerCpu } from './own-load.js';

export const LOCAL = '__local__';
/** A host's numbers are asked again after this (a sample older than 15 s is dropped). */
const FRESH_MS = 15_000;
/** placement_weights' default step ("Normal"). */
export const DEFAULT_WEIGHT = 50;

/** A host's placement weight: config placement_weights, 0 for `place: false`, else 50. */
export function placementWeight(host: string, config: { placement_weights?: Record<string, number>; hosts?: Record<string, { place?: boolean }> }): number {
  if (host !== LOCAL && config.hosts?.[host]?.place === false) return 0;
  const w = config.placement_weights;
  const raw = host === LOCAL ? w?.local ?? w?.[LOCAL] : w?.[host];
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : DEFAULT_WEIGHT;
}
const ASK_MS = 4_000;

function num(env: string | undefined, dflt: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function placementCaps(env: NodeJS.ProcessEnv = process.env) {
  return {
    loadPerCpu: num(env.WALNUT_PLACE_MAX_LOAD_PER_CPU, 3),
    cpuBusy: Math.min(1, num(env.WALNUT_PLACE_MAX_CPU_BUSY, 0.95)),
    memAvailShare: Math.min(1, num(env.WALNUT_PLACE_MIN_MEM_SHARE, 0.05)),
    diskFreeBytes: num(env.WALNUT_PLACE_MIN_DISK_GB, 20) * 1024 ** 3,
  };
}

export interface HostLoadView {
  host: string;
  label: string;
  /** The daemon answered (or this is the Mac). */
  known: boolean;
  cpus?: number;
  load1?: number;
  loadPerCpu?: number;
  /** Our own processes' share of the load per CPU, set when the caps judged by it (hosts/own-load.ts). */
  ownLoadPerCpu?: number;
  /** Runnable threads of our processes and of the others (HostLoad.ownThreads), for gates with a line of their own. */
  ownThreads?: { ours: number; others: number } | null;
  cpuBusy?: number | null;
  /** Cores idle now (cpus x (1 - cpuBusy)): the free CPU a gate judges by, the load being threads. */
  freeCpus?: number | null;
  memAvailShare?: number | null;
  diskFreeBytes?: number | null;
  /** Sessions in a turn on it, plus the starts admitted there that are not running yet. */
  running: number;
  /** Its slots (hostSlots). */
  runningLimit: number;
  memTotalBytes?: number;
  /** How much placement prefers it (placement_weights; 50 normal, 0 never). */
  weight?: number;
  /** Over at least one cap (`reasons` say which), or unknown: placement looks for another host. */
  busy: boolean;
  reasons: string[];
  /**
   * No room for an automatic start (sessions/host-admission.ts): every slot taken, memory
   * nearly gone, or load past twice its cap. The load caps alone only steer placement.
   * `fullReasons` says which, in words without live numbers (they are kept on a queued task).
   */
  full: boolean;
  fullReasons: string[];
  /** Room to take work: higher is more (0 when busy or unknown). */
  score: number;
  at?: string;
  error?: string;
}

const cache = new Map<string, { at: number; load: HostLoad }>();
/** A host that did not answer is not asked again for as long (each start would wait 4 s for it). */
const failed = new Map<string, { at: number; error: string }>();

let localFacts: { load(cmd?: Record<string, unknown>): Promise<HostLoad> } | null = null;
async function localLoad(): Promise<HostLoad> {
  if (!localFacts) {
    const { createHostFacts } = await import('../../providers/host-facts-core.js');
    localFacts = createHostFacts({
      fs, os, execFile: execFile as never, http, https, env: process.env, home: os.homedir(),
      platform: process.platform, arch: process.arch,
    });
  }
  const { localTaskDirRoot } = await import('../sessions/task-dir-place.js');
  return localFacts.load({ path: existingParent(localTaskDirRoot()) });
}

/** The nearest folder of `p` that exists (df needs one). */
function existingParent(p: string): string {
  let cur = p;
  for (let i = 0; i < 12 && cur && cur !== '/'; i++) {
    if (fs.existsSync(cur)) return cur;
    cur = cur.replace(/\/[^/]*$/, '') || '/';
  }
  return os.homedir();
}

/** Test seam: the numbers a host reports. */
type Prober = (host: string) => Promise<HostLoad>;
let prober: Prober | null = null;
export function __setHostLoadProberForTesting(p: Prober | null): void { prober = p; cache.clear(); failed.clear(); }

async function probe(host: string): Promise<HostLoad> {
  if (prober) return prober(host);
  if (host === LOCAL) return localLoad();
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  // Only a link already open: placement never dials a host to ask how busy it is.
  if (!getConnectedDaemonConnection(host)) throw new Error('not connected');
  const { probeHostLoad } = await import('../transfer/daemon-transfer-client.js');
  return probeHostLoad(host, { path: '~/.local/state', timeoutMs: ASK_MS });
}

/** One probe per host at a time: callers that ask meanwhile share it (a restart's recovery asks for each queued session). */
const inFlight = new Map<string, Promise<{ load?: HostLoad; error?: string }>>();

async function loadOf(host: string): Promise<{ load?: HostLoad; error?: string }> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < FRESH_MS) return { load: hit.load };
  const miss = failed.get(host);
  if (miss && Date.now() - miss.at < FRESH_MS) return { error: miss.error };
  const going = inFlight.get(host);
  if (going) return going;
  const p = askLoad(host, hit);
  inFlight.set(host, p);
  try { return await p; } finally { inFlight.delete(host); }
}

/**
 * Our share of the runnable threads, two samples a few hundred ms apart, averaged with the share
 * of the read before it (at most two minutes old): the load it scales is a 1-minute average.
 */
function smoothShare(load: HostLoad, prev: { at: number; load: HostLoad } | undefined): HostLoad {
  const now = load.ownThreads, was = prev && Date.now() - prev.at < 120_000 ? prev.load.ownThreads : null;
  if (!now || !was) return load;
  const avg = (a: number, b: number) => Math.round(((a + b) / 2) * 10) / 10;
  return { ...load, ownThreads: { ours: avg(now.ours, was.ours), others: avg(now.others, was.others) } };
}

async function askLoad(host: string, prev: { at: number; load: HostLoad } | undefined): Promise<{ load?: HostLoad; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const load = smoothShare(await Promise.race([
      probe(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in 4 s')), ASK_MS); timer.unref?.(); }),
    ]), prev);
    cache.set(host, { at: Date.now(), load });
    failed.delete(host);
    return { load };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failed.set(host, { at: Date.now(), error });
    return { error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * This Mac's 1-minute load per CPU for a gate that cannot wait for a probe (sync): over `line`,
 * our own processes' share of it, by the share of the last read here (at most a minute old); else
 * the whole load. A read older than FRESH_MS is asked for again in the background.
 */
export function localLoadPerCpu(line: number): number {
  const hit = cache.get(LOCAL);
  const cpus = Math.max(1, os.cpus().length);
  // Only over the line is the share needed; loadOf shares one probe among callers.
  if (os.loadavg()[0] / cpus >= line && (!hit || Date.now() - hit.at >= FRESH_MS)) void loadOf(LOCAL).catch(() => undefined);
  const share = hit && Date.now() - hit.at < 60_000 ? hit.load.ownThreads : null;
  return ownLoadPerCpu({ load: [os.loadavg()[0]], cpus, ownThreads: share }, line).perCpu;
}

/** Judge one host's numbers against the caps (pure). */
export function judgeHost(
  host: string, label: string, load: HostLoad | undefined, running: number, runningLimit: number,
  caps = placementCaps(), error?: string,
): HostLoadView {
  const view: HostLoadView = { host, label, known: !!load, running, runningLimit, busy: false, reasons: [], full: false, fullReasons: [], score: 0 };
  // Its slots hold whether or not its load can be read (review round 3, Sol).
  if (running >= runningLimit) {
    view.full = true;
    view.fullReasons.push(`all ${runningLimit} slots taken`);
  }
  if (!load) {
    view.busy = true;
    view.reasons.push(`its load is unknown${error ? ` (${error})` : ''}`);
    if (error) view.error = error;
    return view;
  }
  const cpus = Math.max(1, load.cpus || 1);
  const load1 = load.load[0] ?? 0;
  // Over the cap, the load is judged by our own processes' share of it: other apps' threads are
  // not ours to wait for, and what they take of the CPU and memory still counts below.
  const own = ownLoadPerCpu(load, caps.loadPerCpu);
  const perCpu = own.rawPerCpu ?? own.perCpu;
  const judged = own.perCpu;
  const memShare = load.memAvailBytes != null && load.memTotalBytes > 0 ? Math.round((load.memAvailBytes / load.memTotalBytes) * 1000) / 1000 : null;
  Object.assign(view, {
    cpus, load1, loadPerCpu: perCpu, ...(own.rawPerCpu != null ? { ownLoadPerCpu: judged } : {}),
    ...(load.ownThreads !== undefined ? { ownThreads: load.ownThreads } : {}), cpuBusy: load.cpuBusy,
    freeCpus: load.cpuBusy != null ? Math.round(cpus * (1 - load.cpuBusy) * 10) / 10 : null, memAvailShare: memShare, diskFreeBytes: load.diskFreeBytes, at: load.at,
    ...(load.memTotalBytes > 0 ? { memTotalBytes: load.memTotalBytes } : {}),
  });
  if (judged >= caps.loadPerCpu) {
    view.reasons.push(own.rawPerCpu != null
      ? `our share of the load ${Math.round(judged * cpus * 10) / 10} on ${cpus} CPUs (${judged} per CPU, cap ${caps.loadPerCpu}; whole load ${load1})`
      : `load ${load1} on ${cpus} CPUs (${perCpu} per CPU, cap ${caps.loadPerCpu})`);
  }
  if (load.cpuBusy != null && load.cpuBusy >= caps.cpuBusy) view.reasons.push(`CPU ${Math.round(load.cpuBusy * 100)}% busy`);
  if (memShare != null && memShare <= caps.memAvailShare) view.reasons.push(`${Math.round(memShare * 100)}% memory available`);
  if (load.diskFreeBytes != null && load.diskFreeBytes < caps.diskFreeBytes) {
    view.reasons.push(`${(load.diskFreeBytes / 1024 ** 3).toFixed(1)} GB disk free (floor ${Math.round(caps.diskFreeBytes / 1024 ** 3)} GB)`);
  }
  if (running >= runningLimit) view.reasons.push(`${running} sessions in a turn (limit ${runningLimit})`);
  view.busy = view.reasons.length > 0;
  if (memShare != null && memShare <= caps.memAvailShare) view.fullReasons.push('memory nearly full');
  if (judged >= caps.loadPerCpu * 2) view.fullReasons.push(`load past ${caps.loadPerCpu * 2} per CPU`);
  view.full = view.fullReasons.length > 0;
  if (!view.busy) {
    // The score (cores x idle share x memory share), with the load and the sessions in it.
    const idle = load.cpuBusy != null ? 1 - load.cpuBusy : 1;
    view.score = Math.round(cpus * Math.max(0.05, 1 - judged / caps.loadPerCpu) * Math.max(0.05, idle)
      * Math.max(0.05, memShare ?? 0.5) * Math.max(0.05, 1 - running / runningLimit) * 1000) / 1000;
  }
  return view;
}

/** Most slots a host gets from its size (a setting may give more). */
export const MAX_HOST_SLOTS = 32;
const GB = 1024 ** 3;

/**
 * How many sessions a host runs in a turn at once. The host's own setting
 * (config `session_limits`, keyed 'local' for this Mac or by alias) wins; else one
 * per two CPUs and one per 3 GB of memory, whichever is fewer, 2 to MAX_HOST_SLOTS
 * (this Mac's 14 CPUs: 7, clouddev's 48 CPUs and 184 GB: 24). A host whose numbers
 * are unknown keeps the old default (7 here, 20 on another host).
 */
export function hostSlots(
  key: string, load: Pick<HostLoad, 'cpus' | 'memTotalBytes'> | undefined, sessionLimits: Record<string, number> | undefined,
  fallback: (key: string) => number,
): number {
  const set = Number(sessionLimits?.[key]);
  if (sessionLimits?.[key] !== undefined && Number.isFinite(set)) return Math.max(1, Math.floor(set));
  if (!load || !(load.cpus > 0)) return fallback(key);
  const byCpu = Math.floor(load.cpus / 2);
  const byMem = load.memTotalBytes > 0 ? Math.floor(load.memTotalBytes / (3 * GB)) : byCpu;
  return Math.min(MAX_HOST_SLOTS, Math.max(2, Math.min(byCpu, byMem)));
}

/** Every host work may run on (this Mac and each enabled host), with its load judged. */
export async function hostLoads(opts: { hosts?: string[] } = {}): Promise<HostLoadView[]> {
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  // Each machine once (hosts/joined-twins.ts): the Move to host menu reads this list.
  const { pickableHosts } = await import('./joined-twins.js');
  const entries = pickableHosts(config.hosts ?? {}, config.net).filter(([, h]) => !h.cloud_box);
  const names = opts.hosts ?? [LOCAL, ...entries.map(([k]) => k)];
  const { getActiveSessionsByHost, activeSessionLimitFor } = await import('../session-tracker.js');
  // The starts holding slots, read before the sessions: one whose record turns running in between
  // is counted by its hold, and once (by task) when both see it (review round 3, Sol).
  const { slotHoldersOn } = await import('../sessions/host-admission.js');
  const holders = new Map(names.map((h) => [h, slotHoldersOn(h)] as const));
  const active = await getActiveSessionsByHost().catch(() => ({} as Record<string, import('../types.js').SessionRecord[]>));
  // A slot is a turn: a session that only waits after its turn (an armed wakeup, a background
  // command such as a land it waits on) reads as running but holds none (2026-11-06, the VP:
  // sessions only waiting on lands filled the cap; review round 6, Sol). Its CPU, if any, shows
  // in the host's load. Unknown to this server's runner: counted.
  const runner = await import('../../providers/claude-code-session.js').then((m) => m.sessionRunner).catch(() => null);
  const inTurn = (s: import('../types.js').SessionRecord) => runner?.isInTurn(s.claudeSessionId) !== false;
  const { hostDisplayName } = await import('./host-display-name.js');
  const caps = placementCaps();
  return Promise.all(names.map(async (host) => {
    const key = host === LOCAL ? 'local' : host;
    // Its sessions in a turn and the starts holding a slot there, each task once.
    const taken = new Set((active[key] ?? []).filter(inTurn).map((s) => (s.taskId ? `task:${s.taskId}` : `sid:${s.claudeSessionId}`)));
    for (const id of holders.get(host) ?? []) taken.add(`task:${id}`);
    const running = taken.size;
    const got = await loadOf(host);
    const label = host === LOCAL ? 'this Mac' : hostDisplayName(host, config.hosts?.[host]?.label);
    const slots = hostSlots(key, got.load, config.session_limits, (k) => activeSessionLimitFor(k, undefined));
    const view = judgeHost(host, label, got.load, running, slots, caps, got.error);
    // The weight: the room score scaled by how much the user prefers this host.
    view.weight = placementWeight(host, config);
    view.score = Math.round(view.score * (view.weight / DEFAULT_WEIGHT) * 1000) / 1000;
    return view;
  }));
}

/** Words that say the work needs the Mac itself (or its user's screen). */
const MAC_ONLY = /\b(ios|ipados|iphone|ipad|xcode|xcodebuild|xcrun|simulators?|testflight|swiftui|app store connect|mac app|macos|wkwebview|webkit|safari|peekaboo|osascript|browser[- ]relay|keychain|launchctl|launchd|touch id|(?:on|this|the|my|his|her|their) mac|mac's|my screen|his screen|her screen|their screen|the user's screen|screen recording)\b/i;

/** The Mac's own tools by name: work that needs them runs on a Mac whatever else it says. */
const MAC_TOOLS = /\b(ios|ipados|iphone|ipad|xcode|xcodebuild|xcrun|simulators?|testflight|swiftui|app store connect|mac app|wkwebview|peekaboo|osascript)\b/i;

/**
 * Narrower than macOnlyReason: a tag, an iOS or Xcode folder, or a Mac tool by name.
 * Plain words about the Mac ("it lands on the Mac", "WebKit") are in most of this
 * repository's briefs and say nothing about where the work runs (task-launch-plan.ts).
 */
export function needsMacTools(text: string, cwd: string | undefined, tags: readonly string[] = []): boolean {
  if (tags.some((t) => /^(mac-only|host:mac|host:local)$/i.test(t))) return true;
  if (cwd && /(^|\/)(ios-native|[^/]+\.xcodeproj|[^/]+\.xcworkspace)(\/|$)/.test(cwd)) return true;
  return MAC_TOOLS.test(text);
}

/** Why a task's work must stay on the Mac, or null. */
export function macOnlyReason(text: string, cwd: string | undefined, tags: readonly string[] = []): string | null {
  if (tags.some((t) => /^(mac-only|host:mac|host:local)$/i.test(t))) return 'it is tagged to stay on the Mac';
  if (cwd && /(^|\/)(ios-native|[^/]+\.xcodeproj|[^/]+\.xcworkspace)(\/|$)/.test(cwd)) return `its folder ${cwd} is iOS or Xcode work`;
  const m = MAC_ONLY.exec(text);
  return m ? `it mentions "${m[0]}", which needs the Mac` : null;
}

export interface PlacementDecision {
  /** The host the start goes to ('' = this Mac, as task-launch-plan spells it). */
  host: string;
  /** Moved off the host the start would have used. */
  moved: boolean;
  from: string;
  reason: string;
  hosts: HostLoadView[];
  /** Moved because the files the task names are there, not on the host it would have used. */
  forFiles?: boolean;
}

interface FileView {
  /** The named paths some host asked has (the rest name nothing anywhere). */
  needed: string[];
  /** Of those, the files the work reads (named-paths.ts isWorkFile): a task directory's, a document. */
  strong: string[];
  /** How many of `list` a host has. */
  count: (host: string, list: string[]) => number;
  lacks: (host: string, list: string[]) => string[];
}

/**
 * Which hosts have the files a task names (hosts/named-paths.ts). The host the start
 * would use is asked first: when it has them all and room, nothing moves and no other
 * host is asked. Null when no path names a file on any host asked.
 */
async function fileHosts(
  hosts: HostLoadView[], here: HostLoadView, paths: readonly string[],
  check: (host: string, paths: string[]) => Promise<PathsOnHost | null>,
): Promise<FileView | null> {
  if (paths.length === 0) return null;
  const ask = (host: string) => check(host, [...paths]).catch(() => null);
  const own = await ask(here.host);
  // With room, only a work file it lacks (a task directory's, a document) can move the work: no
  // other host is asked otherwise (one it could not be asked about counts as having them all).
  if (here.known && !here.busy && (!own || !own.missing.some(isWorkFile))) return null;
  // A host whose load is unknown is never chosen, so it is not asked either.
  const others = hosts.filter((h) => h.known && h.host !== here.host);
  const answers = new Map<string, PathsOnHost | null>([[here.host, own], ...await Promise.all(others.map(async (h) => [h.host, await ask(h.host)] as const))]);
  // Unasked, the host the start would use may have any of them: all must then be kept.
  const needed = own ? paths.filter((p) => [...answers.values()].some((a) => a?.present.includes(p))) : [...paths];
  if (needed.length === 0) return null;
  // The host the start would use counts as having what it could not be asked about (it
  // keeps the work then); any other host has only what it said it has.
  const has = (host: string, p: string) => {
    const a = answers.get(host);
    return a ? a.present.includes(p) : host === here.host;
  };
  return {
    needed, strong: needed.filter(isWorkFile),
    count: (host, list) => list.filter((p) => has(host, p)).length,
    lacks: (host, list) => list.filter((p) => !has(host, p)),
  };
}

function pathList(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/**
 * Where a first start goes. `defaultHost` is what the start would use without
 * placement ('' = this Mac). `eligible` says whether the work can run on a host
 * (the repository can be had there, the engine is installed); `forFiles` is set when
 * the host is asked because it has the task's files (the repository may then be
 * cloned there by the session). `paths` are the files the task names: a move for load
 * never goes to a host with fewer of them, and one in a task's directory that the host
 * the start would use lacks takes the work to a host that has it.
 */
export async function choosePlacement(input: {
  defaultHost: string; text: string; cwd?: string; tags?: readonly string[];
  eligible?: (host: string, why: { forFiles: boolean }) => Promise<string | null>;
  paths?: readonly string[];
  checkPaths?: (host: string, paths: string[]) => Promise<PathsOnHost | null>;
}): Promise<PlacementDecision | null> {
  if (process.env.WALNUT_PLACE_BY_LOAD === '0') return null;
  const from = input.defaultHost || LOCAL;
  const pinned = macOnlyReason(input.text, input.cwd, input.tags);
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const { pickableHosts } = await import('./joined-twins.js');
  const candidates = [LOCAL, ...pickableHosts(config.hosts ?? {}, config.net)
    .filter(([k, h]) => !h.cloud_box && placementWeight(k, config) > 0).map(([k]) => k)];
  if (!candidates.includes(from)) candidates.push(from);
  if (candidates.length < 2) return null;
  const hosts = await hostLoads({ hosts: candidates });
  const here = hosts.find((h) => h.host === from)!;
  const name = (h: HostLoadView) => h.label;
  if (pinned) {
    return from === LOCAL ? { host: '', moved: false, from, reason: `stays on this Mac: ${pinned}`, hosts } : null;
  }
  const files = await fileHosts(hosts, here, input.paths ?? [], input.checkPaths ?? pathsOnHost);
  const eligible = (h: HostLoadView, forFiles: boolean) => (input.eligible
    ? input.eligible(h.host, { forFiles }).catch((e: unknown) => String(e)) : Promise.resolve(null));
  // A host keeps every named file the host the start would use has (another file there
  // never makes up for one it lacks); the work never goes to a host that does not.
  const fromHas = files ? files.needed.filter((p) => !files.lacks(from, [p]).length) : [];
  const keeps = (h: HostLoadView) => !files || files.lacks(h.host, fromHas).length === 0;
  const canTake = (h: HostLoadView) => h.host !== from && h.known && (h.weight ?? DEFAULT_WEIGHT) > 0;
  const strongLacks = files ? files.lacks(from, files.strong) : [];
  if (files && strongLacks.length) {
    // The host the start would use lacks files the work reads that another host has (a
    // task directory's brief or plan, a document, data): the work goes where they are, even from a host
    // with room, to a host that has every one of them and keeps every file this one has,
    // room first. A busy host with them still beats one without (the work cannot run
    // there); weight 0 never. The host it goes to has every named file this one lacks, not only
    // those (review round 5, Sol: a brief on B and data only on C never goes to B). No such
    // host: it stays (review round 4: a host with only some of them, or none, is never chosen,
    // for its files or for load).
    const lacks = strongLacks;
    const required = files.lacks(from, files.needed);
    const withFiles = hosts.filter((h) => canTake(h) && keeps(h) && files.lacks(h.host, required).length === 0)
      .sort((a, b) => files.count(b.host, lacks) - files.count(a.host, lacks) || files.count(b.host, files.needed) - files.count(a.host, files.needed)
        || Number(a.busy) - Number(b.busy) || b.score - a.score || (a.ownLoadPerCpu ?? a.loadPerCpu ?? 0) - (b.ownLoadPerCpu ?? b.loadPerCpu ?? 0));
    for (const h of hosts) {
      const missing = h === here ? [] : [...files.lacks(h.host, required), ...files.lacks(h.host, fromHas)];
      if (missing.length) h.reasons.push(`it does not have ${pathList(missing)}, which the task names`);
    }
    for (const best of withFiles) {
      const why = await eligible(best, true);
      if (why) { best.reasons.push(`not eligible: ${why}`); continue; }
      const got = lacks.filter((p) => !files.lacks(best.host, [p]).length);
      const reason = `${name(here)} does not have ${pathList(lacks)}, which the task names; ${name(best)} has ${got.length === lacks.length ? (lacks.length > 1 ? 'them' : 'it') : pathList(got)}`
        + ` (load ${best.load1} on ${best.cpus} CPUs, ${best.running} of ${best.runningLimit} sessions in a turn${best.busy ? `; busy: ${best.reasons.join('; ')}` : ''})`;
      log.session.info('placement: a start goes to the host with its files', { from, to: best.host, reason });
      return { host: best.host === LOCAL ? '' : best.host, moved: true, from, reason, hosts, forFiles: true };
    }
    return { host: input.defaultHost, moved: false, from, reason: `${name(here)} does not have ${pathList(lacks)}, which the task names, and no host that has ${required.length > 1 ? 'every file it lacks' : 'it'} and every file it has can take the work; it stays`, hosts };
  }
  const enoughFiles = keeps;
  if (files && here.busy) {
    for (const h of hosts) {
      if (h !== here && !keeps(h)) h.reasons.push(`it does not have ${pathList(files.lacks(h.host, fromHas))}, which the task names`);
    }
  }
  if (!here.busy || !here.known) {
    return { host: input.defaultHost, moved: false, from, reason: here.known ? `${name(here)} has room` : `${name(here)}'s load is unknown; it stays there`, hosts };
  }
  // Weight 0 ("never") is no place to go; the Mac stays a candidate only above it.
  // A host without the files the task names (that the start's own host has) never is.
  const others = hosts.filter((h) => h.host !== from && !h.busy && (h.weight ?? DEFAULT_WEIGHT) > 0 && h.score > 0 && enoughFiles(h)).sort((a, b) => b.score - a.score);
  // Hosts with room that cannot take it, said in the reason (review round 6: "no other host has
  // room" read as every host full when one had room but no checkout).
  const cannot: string[] = [];
  for (const best of others) {
    const why = await eligible(best, false);
    if (why) { best.reasons.push(`not eligible: ${why}`); cannot.push(`${name(best)} has room but ${why}`); continue; }
    const reason = `${name(here)} is overloaded (${here.reasons.join('; ')}); ${name(best)} has room `
      + `(load ${best.load1} on ${best.cpus} CPUs, ${best.running} of ${best.runningLimit} sessions in a turn`
      + `${best.diskFreeBytes != null ? `, ${(best.diskFreeBytes / 1024 ** 3).toFixed(0)} GB free` : ''})`;
    log.session.info('placement: a start goes to another host', { from, to: best.host, reason });
    return { host: best.host === LOCAL ? '' : best.host, moved: true, from, reason, hosts };
  }
  const rest = cannot.length ? `; ${cannot.join('; ')}` : ', and no other host has room';
  return { host: input.defaultHost, moved: false, from, reason: `${name(here)} is overloaded (${here.reasons.join('; ')})${rest}`, hosts };
}
