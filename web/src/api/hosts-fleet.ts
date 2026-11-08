/**
 * The fleet view (GET /api/v1/hosts, server: src/core/hosts/fleet-model.ts).
 * The shapes mirror FleetHost there; every reading may be null (a host that is
 * down, an older daemon, a host not probed yet).
 */
import { apiGet, apiPost } from './client';

export interface FleetWindow { days: number; minutes: number; up: number; linked: number; online: number | null; linkedShare: number | null; drops: number; downs: number; daemonStarts?: number; boots?: number }
export interface FleetBucket { start: number; minutes: number; up: number; linked: number; cpu: number | null; mem: number | null; sessionsMax: number }
export interface FleetOutage { from: number; to: number; minutes: number; kind: 'down' | 'unlinked' }
/** The last 12 hours in 15 minute steps, oldest first; shares 0..1, mem in use, gpu null without one. */
export interface FleetRecent { from: number; stepMinutes: number; up: number[]; cpu: Array<number | null>; mem: Array<number | null>; gpu: Array<number | null> | null; disk: Array<number | null>; sessions: number[] }

export interface FleetHost {
  host: string;
  label: string;
  local: boolean;
  line: string;
  checkedAt: number;
  connection: { kind: 'local' | 'ssh-tunnel' | 'host-network' | 'bridge'; connected: boolean; phase: string; phaseLabel: string; since: number | null; rttMs: number | null; error: string | null; unstable?: { drops: number; windowMin: number } };
  system: { os: string | null; platform?: string | null; arch: string | null; cpus: number | null; memBytes: number | null; diskFreeBytes: number | null; kind: string; probedAt: string | null } | null;
  now: { cpus: number; cpuUtil: number | null; load: [number, number, number] | null; memTotalBytes: number; memAvailBytes: number | null; uptimeSec: number; bootedAt: number; linked: boolean; gpuUtil?: number | null; disk?: { totalBytes: number; freeBytes: number } | null; at: number; stale: boolean } | null;
  history: { coverageFrom: number | null; bucketMinutes: number; buckets: FleetBucket[]; windows: FleetWindow[]; outages: FleetOutage[]; boots: number[]; daemonStarts: number; recent?: FleetRecent } | null;
  /**
   * `source`: the host's own count from its last reading (`at`, kept until a new one comes), or
   * Walnut's session records for a host never read; `why` when null (absent from an older server).
   */
  sessions: { running: number | null; source?: 'host' | 'records' | null; why?: string | null; at?: number | null };
  spend: { last30dUsd: number; from: string; basis: 'list-price' } | null;
  /** `phaseLabel` is the phase in words; show it, never `phase`. */
  server: { enabled: boolean; program: string | null; phase: string; phaseLabel: string; build: string | null; phone: string | null; message: string | null } | null;
  daemon: {
    version: string | null; startedAt: number | null; startup: string; startsAfterReboot: boolean; runtime: string | null; vitals: boolean;
    /** The host's own answer about a reboot (null until asked; absent from an older server). */
    bootStart?: { mode: 'boot' | 'login' | 'none'; backend: string | null; reason: string | null; checkedAt: number; setupRunning: boolean; setupError: string | null; next?: 'install' | 'recheck' | null } | null;
    /** That answer in words, from the server. */
    reboot?: string;
    /** A test server's or the Demo's own daemon, removed when that server stops: no reboot start by design. */
    throwaway?: boolean;
  } | null;
  placement: { score: number | null; busy: boolean | null; reasons: string[]; weight: number | null; longRunning: { ok: boolean; reasons: string[] } };
  /** What the host can do (src/core/hosts/capabilities.ts); absent from a server older than it. */
  capabilities?: FleetCapabilities;
  /**
   * The cached read (`?cached=1`, src/core/hosts/fleet-refresh.ts): when its readings were read
   * (null: never yet), whether a read of it runs now, and why its last read failed (the readings
   * are the older ones then). Absent from a live read and from an older server.
   */
  readAt?: number | null;
  refreshing?: boolean;
  readError?: string | null;
  readFailedAt?: number | null;
}

export interface FleetCapabilities {
  tags: string[];
  alwaysOn: boolean | null;
  placement: 'cloud' | 'local' | null;
  os: 'macos' | 'linux' | 'windows' | null;
  ios: { xcode: string; runtimes: string[] } | null;
  browsers: Array<{ name: string; relay: boolean }>;
  mcp: Array<{ name: string; plugin?: string; offered?: boolean; capability?: string }>;
  clis: string[];
  declared: string[];
  unknown: string[];
}

export interface FleetAnswer { hosts: FleetHost[]; checkedAt: number; refreshing?: boolean }

/**
 * The Overview's read: every card at once from what each host answered last (the server
 * never waits on a host for it), `refreshing` while a read started by refreshFleet runs.
 */
export function fetchFleet(opts?: { signal?: AbortSignal }): Promise<FleetAnswer> {
  return apiGet('/api/v1/hosts', { cached: '1' }, { signal: opts?.signal, timeoutMs: 10_000 });
}

type RefreshListener = (hosts: string[] | null) => void;
const refreshListeners = new Set<RefreshListener>();

/** Told whenever a read of the hosts starts on this page (the Overview polls while it runs). */
export function onFleetRefresh(fn: RefreshListener): () => void {
  refreshListeners.add(fn);
  return () => { refreshListeners.delete(fn); };
}

/**
 * Read these hosts again (every host when none is named): POST /api/v1/hosts/refresh starts
 * the reads and answers at once; each card changes in the cached read as its own read ends.
 */
export async function refreshFleet(hosts?: string[]): Promise<{ started: string[]; refreshing: string[] }> {
  const r = await apiPost<{ started: string[]; refreshing: string[] }>('/api/v1/hosts/refresh', hosts ? { hosts } : {}, { timeoutMs: 10_000, quietStatuses: [404] });
  for (const fn of refreshListeners) fn(hosts ?? null);
  return r;
}

/**
 * The Overview's "Set up": the host checks its start after a reboot now and sets it up
 * when due (POST /api/v1/hosts/:host/boot-start). Answers the host's card afterwards.
 */
export function setUpBootStart(host: string): Promise<{ host: FleetHost }> {
  return apiPost(`/api/v1/hosts/${encodeURIComponent(host)}/boot-start`, undefined, { timeoutMs: 30_000, quietStatuses: [404, 409] });
}
