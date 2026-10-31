/**
 * Where a task's first session runs, by load (2026-10-31, the user: "it is overloaded
 * why u keep put it in mac?", "they can load balance we should be able to"). The Mac
 * ran 14 task sessions at load 400 to 800 while clouddev sat idle, because every start
 * took its project's default host (or its lead's) whatever that host was doing.
 *
 * The rule, decided on the leader (one answer for every surface; T3 Code decides it in
 * each client and so gives different answers):
 *   - a start that names a host, a task that already has a session, and Mac-only work
 *     (iOS, the Mac app, the user's screen) are never placed;
 *   - otherwise the host the start would use keeps it while it is under every cap;
 *   - over a cap, the eligible host with the most room takes it, when one is under
 *     every cap; when none is, the start stays where it was (no worse place to go).
 * Caps (each env-tunable): load average per CPU 3 (the macOS load also counts threads
 * stalled on memory, which CPU use alone misses), CPU busy 95%, memory available 5%,
 * free disk 20 GB, and the host's running-session limit (`session_limits`). A host's
 * numbers come from its daemon (`host.load`, 'host-load-v1'), the Mac's from this
 * process; one older than 15 s is asked again (as T3 Code), and a host that does not answer in 4 s
 * is unknown and never chosen. Like T3: a placed task keeps its host (no rebalancing), and
 * each host carries a weight (config placement_weights: 100 prefer, 50 normal, 25 less
 * often, 0 never) that scales its room score.
 */
import os from 'node:os';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { log } from '../../logging/index.js';
import type { HostLoad } from '../../providers/host-facts-core.js';

export const LOCAL = '__local__';
/** A host's numbers are asked again after this (T3 Code drops a sample older than 15 s). */
const FRESH_MS = 15_000;
/** placement_weights' default step (T3 Code's "Normal"). */
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
  cpuBusy?: number | null;
  memAvailShare?: number | null;
  diskFreeBytes?: number | null;
  running: number;
  runningLimit: number;
  /** How much placement prefers it (placement_weights; 50 normal, 0 never). */
  weight?: number;
  /** Over at least one cap (`reasons` say which), or unknown. */
  busy: boolean;
  reasons: string[];
  /** Room to take work: higher is more (0 when busy or unknown). */
  score: number;
  at?: string;
  error?: string;
}

const cache = new Map<string, { at: number; load: HostLoad }>();

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
export function __setHostLoadProberForTesting(p: Prober | null): void { prober = p; cache.clear(); }

async function probe(host: string): Promise<HostLoad> {
  if (prober) return prober(host);
  if (host === LOCAL) return localLoad();
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  // Only a link already open: placement never dials a host to ask how busy it is.
  if (!getConnectedDaemonConnection(host)) throw new Error('not connected');
  const { probeHostLoad } = await import('../transfer/daemon-transfer-client.js');
  return probeHostLoad(host, { path: '~/.local/state', timeoutMs: ASK_MS });
}

async function loadOf(host: string): Promise<{ load?: HostLoad; error?: string }> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < FRESH_MS) return { load: hit.load };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const load = await Promise.race([
      probe(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in 4 s')), ASK_MS); timer.unref?.(); }),
    ]);
    cache.set(host, { at: Date.now(), load });
    return { load };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Judge one host's numbers against the caps (pure). */
export function judgeHost(
  host: string, label: string, load: HostLoad | undefined, running: number, runningLimit: number,
  caps = placementCaps(), error?: string,
): HostLoadView {
  const view: HostLoadView = { host, label, known: !!load, running, runningLimit, busy: false, reasons: [], score: 0 };
  if (!load) {
    view.busy = true;
    view.reasons.push(`its load is unknown${error ? ` (${error})` : ''}`);
    if (error) view.error = error;
    return view;
  }
  const cpus = Math.max(1, load.cpus || 1);
  const load1 = load.load[0] ?? 0;
  const perCpu = Math.round((load1 / cpus) * 100) / 100;
  const memShare = load.memAvailBytes != null && load.memTotalBytes > 0 ? Math.round((load.memAvailBytes / load.memTotalBytes) * 1000) / 1000 : null;
  Object.assign(view, {
    cpus, load1, loadPerCpu: perCpu, cpuBusy: load.cpuBusy, memAvailShare: memShare, diskFreeBytes: load.diskFreeBytes, at: load.at,
  });
  if (perCpu >= caps.loadPerCpu) view.reasons.push(`load ${load1} on ${cpus} CPUs (${perCpu} per CPU, cap ${caps.loadPerCpu})`);
  if (load.cpuBusy != null && load.cpuBusy >= caps.cpuBusy) view.reasons.push(`CPU ${Math.round(load.cpuBusy * 100)}% busy`);
  if (memShare != null && memShare <= caps.memAvailShare) view.reasons.push(`${Math.round(memShare * 100)}% memory available`);
  if (load.diskFreeBytes != null && load.diskFreeBytes < caps.diskFreeBytes) {
    view.reasons.push(`${(load.diskFreeBytes / 1024 ** 3).toFixed(1)} GB disk free (floor ${Math.round(caps.diskFreeBytes / 1024 ** 3)} GB)`);
  }
  if (running >= runningLimit) view.reasons.push(`${running} sessions in a turn (limit ${runningLimit})`);
  view.busy = view.reasons.length > 0;
  if (!view.busy) {
    // T3 Code's score (cores x idle share x memory share), with the load and the sessions in it.
    const idle = load.cpuBusy != null ? 1 - load.cpuBusy : 1;
    view.score = Math.round(cpus * Math.max(0.05, 1 - perCpu / caps.loadPerCpu) * Math.max(0.05, idle)
      * Math.max(0.05, memShare ?? 0.5) * Math.max(0.05, 1 - running / runningLimit) * 1000) / 1000;
  }
  return view;
}

/** Every host work may run on (this Mac and each enabled host), with its load judged. */
export async function hostLoads(opts: { hosts?: string[] } = {}): Promise<HostLoadView[]> {
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const entries = Object.entries(config.hosts ?? {}).filter(([, h]) => h.enabled !== false && !h.cloud_box);
  const names = opts.hosts ?? [LOCAL, ...entries.map(([k]) => k)];
  const { getActiveSessionsByHost, activeSessionLimitFor } = await import('../session-tracker.js');
  const active = await getActiveSessionsByHost().catch(() => ({} as Record<string, import('../types.js').SessionRecord[]>));
  const { hostDisplayName } = await import('./host-display-name.js');
  const caps = placementCaps();
  return Promise.all(names.map(async (host) => {
    const key = host === LOCAL ? 'local' : host;
    const running = (active[key] ?? []).length;
    const got = await loadOf(host);
    const label = host === LOCAL ? 'this Mac' : hostDisplayName(host, config.hosts?.[host]?.label);
    const view = judgeHost(host, label, got.load, running, activeSessionLimitFor(key, config.session_limits), caps, got.error);
    // T3 Code's weight: the room score scaled by how much the user prefers this host.
    view.weight = placementWeight(host, config);
    view.score = Math.round(view.score * (view.weight / DEFAULT_WEIGHT) * 1000) / 1000;
    return view;
  }));
}

/** Words that say the work needs the Mac itself (or its user's screen). */
const MAC_ONLY = /\b(ios|ipados|iphone|ipad|xcode|xcodebuild|xcrun|simulators?|testflight|swiftui|app store connect|mac app|macos|wkwebview|webkit|safari|peekaboo|osascript|browser[- ]relay|keychain|launchctl|launchd|touch id|(?:on|this|the|my|his|her|their) mac|mac's|my screen|his screen|her screen|their screen|the user's screen|screen recording)\b/i;

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
}

/**
 * Where a first start goes. `defaultHost` is what the start would use without
 * placement ('' = this Mac). `eligible` says whether the work can run on a host
 * (the repository can be had there, the engine is installed).
 */
export async function choosePlacement(input: {
  defaultHost: string; text: string; cwd?: string; tags?: readonly string[];
  eligible?: (host: string) => Promise<string | null>;
}): Promise<PlacementDecision | null> {
  if (process.env.WALNUT_PLACE_BY_LOAD === '0') return null;
  const from = input.defaultHost || LOCAL;
  const pinned = macOnlyReason(input.text, input.cwd, input.tags);
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const candidates = [LOCAL, ...Object.entries(config.hosts ?? {})
    .filter(([k, h]) => h.enabled !== false && !h.cloud_box && placementWeight(k, config) > 0).map(([k]) => k)];
  if (!candidates.includes(from)) candidates.push(from);
  if (candidates.length < 2) return null;
  const hosts = await hostLoads({ hosts: candidates });
  const here = hosts.find((h) => h.host === from)!;
  const name = (h: HostLoadView) => h.label;
  if (pinned) {
    return from === LOCAL ? { host: '', moved: false, from, reason: `stays on this Mac: ${pinned}`, hosts } : null;
  }
  if (!here.busy || !here.known) {
    return { host: input.defaultHost, moved: false, from, reason: here.known ? `${name(here)} has room` : `${name(here)}'s load is unknown; it stays there`, hosts };
  }
  // Weight 0 ("never") is no place to go; the Mac stays a candidate only above it.
  const others = hosts.filter((h) => h.host !== from && !h.busy && (h.weight ?? DEFAULT_WEIGHT) > 0 && h.score > 0).sort((a, b) => b.score - a.score);
  for (const best of others) {
    const why = input.eligible ? await input.eligible(best.host).catch((e: unknown) => String(e)) : null;
    if (why) { best.reasons.push(`not eligible: ${why}`); continue; }
    const reason = `${name(here)} is overloaded (${here.reasons.join('; ')}); ${name(best)} has room `
      + `(load ${best.load1} on ${best.cpus} CPUs, ${best.running} of ${best.runningLimit} sessions in a turn`
      + `${best.diskFreeBytes != null ? `, ${(best.diskFreeBytes / 1024 ** 3).toFixed(0)} GB free` : ''})`;
    log.session.info('placement: a start goes to another host', { from, to: best.host, reason });
    return { host: best.host === LOCAL ? '' : best.host, moved: true, from, reason, hosts };
  }
  return { host: input.defaultHost, moved: false, from, reason: `${name(here)} is overloaded (${here.reasons.join('; ')}), and no other host has room`, hosts };
}
