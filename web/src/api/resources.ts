/**
 * What each session costs its machine: GET /api/resources
 * (src/web/routes/resources.ts). The live frames arrive as the
 * `session:resources` WS event; this read hydrates, with `fresh` it asks the
 * hosts' daemons to sample now, and with `watch` (the open Machine readout) it
 * keeps them sampling fast for a minute.
 */
import { apiGet } from './client';

export interface ResourcePoint { at: number; rssBytes: number; cpuPct: number | null }

export interface ProcUsageEntry { pid: number; comm: string; rssBytes: number; cpuPct: number | null }

export interface SessionResourceRow {
  /** The daemon's session id (the Claude session id, or an ACP runtime id). */
  sid: string;
  kind: 'cli' | 'acp';
  rootPid: number;
  /** False: the CLI is gone and these are processes it left running. */
  alive: boolean;
  procCount: number;
  rssBytes: number;
  /** Null until a full cpu window has seen this session. */
  cpuPct: number | null;
  top: ProcUsageEntry[];
  /** The Walnut session id, when the server knows the session (an ACP row's `sid` is not it). */
  sessionId?: string;
  taskId?: string;
  title?: string;
  /** False for a session the daemon runs for another Walnut. */
  known: boolean;
  heavy: boolean;
  history?: ResourcePoint[];
}

/** The id a column, a route or a menu knows this session by. */
export function rowSessionId(row: SessionResourceRow): string {
  return row.sessionId ?? row.sid;
}

export interface HostResourceFrame {
  /** '__local__' or the host alias. */
  host: string;
  at: number;
  ok: boolean;
  /** With ok: `error` means the newest sample failed and `stale` rows are the last good ones. */
  reason?: 'not_connected' | 'daemon_needs_upgrade' | 'error' | 'sampling';
  error?: string;
  stale?: boolean;
  goodAt?: number;
  machine?: { platform: string; totalMemBytes: number; loadavg1: number; cpuCount: number };
  processCount: number;
  sampleMs?: number;
  sessions: SessionResourceRow[];
  totals: { sessions: number; rssBytes: number; cpuPct: number | null };
}

export interface ResourcesRead {
  hosts: HostResourceFrame[];
  watching: boolean;
}

/**
 * 204 (a replica, or sampling switched off) answers `null`: the readout says
 * so instead of showing an empty machine. 404 is an older server.
 */
export async function fetchResources(opts: { fresh?: boolean; history?: boolean; watch?: boolean; host?: string } = {}): Promise<ResourcesRead | null> {
  const params: Record<string, string> = {};
  if (opts.fresh) params.fresh = '1';
  if (opts.history) params.history = '1';
  if (opts.watch) params.watch = '1';
  if (opts.host) params.host = opts.host;
  const res = await apiGet<ResourcesRead | undefined>('/api/resources', params, { quietStatuses: [404], timeoutMs: 15_000 });
  return res ?? null;
}
