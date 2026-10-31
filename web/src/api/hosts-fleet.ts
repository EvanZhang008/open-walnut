/**
 * The fleet view (GET /api/v1/hosts, server: src/core/hosts/fleet-model.ts).
 * The shapes mirror FleetHost there; every reading may be null (a host that is
 * down, an older daemon, a host not probed yet).
 */
import { apiGet } from './client';

export interface FleetWindow { days: number; minutes: number; up: number; linked: number; online: number | null; linkedShare: number | null; drops: number; downs: number; daemonStarts?: number; boots?: number }
export interface FleetBucket { start: number; minutes: number; up: number; linked: number; cpu: number | null; mem: number | null; sessionsMax: number }
export interface FleetOutage { from: number; to: number; minutes: number; kind: 'down' | 'unlinked' }

export interface FleetHost {
  host: string;
  label: string;
  local: boolean;
  line: string;
  checkedAt: number;
  connection: { kind: 'local' | 'ssh-tunnel' | 'bridge'; connected: boolean; phase: string; phaseLabel: string; since: number | null; rttMs: number | null; error: string | null };
  system: { os: string | null; platform?: string | null; arch: string | null; cpus: number | null; memBytes: number | null; diskFreeBytes: number | null; kind: string; probedAt: string | null } | null;
  now: { cpus: number; cpuUtil: number | null; load: [number, number, number] | null; memTotalBytes: number; memAvailBytes: number | null; uptimeSec: number; bootedAt: number; linked: boolean; at: number; stale: boolean } | null;
  history: { coverageFrom: number | null; bucketMinutes: number; buckets: FleetBucket[]; windows: FleetWindow[]; outages: FleetOutage[]; boots: number[]; daemonStarts: number } | null;
  sessions: { running: number | null };
  spend: { last30dUsd: number; from: string; basis: 'list-price' } | null;
  /** `phaseLabel` is the phase in words; show it, never `phase`. */
  server: { enabled: boolean; program: string | null; phase: string; phaseLabel: string; build: string | null; phone: string | null; message: string | null } | null;
  daemon: { version: string | null; startedAt: number | null; startup: string; startsAfterReboot: boolean; runtime: string | null; vitals: boolean } | null;
  placement: { score: number | null; busy: boolean | null; reasons: string[]; weight: number | null; longRunning: { ok: boolean; reasons: string[] } };
  /** What the host can do (src/core/hosts/capabilities.ts); absent from a server older than it. */
  capabilities?: FleetCapabilities;
}

export interface FleetCapabilities {
  tags: string[];
  alwaysOn: boolean | null;
  placement: 'cloud' | 'local' | null;
  os: 'macos' | 'linux' | 'windows' | null;
  ios: { xcode: string; runtimes: string[] } | null;
  browsers: Array<{ name: string; relay: boolean }>;
  mcp: Array<{ name: string; plugin?: string }>;
  clis: string[];
  declared: string[];
  unknown: string[];
}

export function fetchFleet(opts?: { signal?: AbortSignal }): Promise<{ hosts: FleetHost[]; checkedAt: number }> {
  // The server holds each host to 3 s; a little more covers the gathering.
  return apiGet('/api/v1/hosts', undefined, { signal: opts?.signal, timeoutMs: 12_000, priority: 'low' });
}
