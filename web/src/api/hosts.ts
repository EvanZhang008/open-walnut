/**
 * Host connect status — the wire types for "is this exec host reachable, and if
 * it is still connecting, where in the chain is it".
 *
 * Deliberately a file of its own (not part of api/sessions.ts): the status is a
 * property of the HOST, shared by the folder picker, Settings › Remote hosts and
 * the notification System pane, none of which are session code.
 */
import { apiGet, apiPost } from './client';

/**
 * One link in the first-connect chain, in the order the server walks it.
 *
 * `idle` = never attempted. `reconnecting` = it was connected and is coming back
 * (no install/upload work, so the step list re-runs from `ssh`). `failed` keeps
 * the last attempted phase in `steps` so the card can say where it broke.
 */
export type DaemonConnectPhase =
  | 'idle'
  | 'ssh'
  | 'probe'
  | 'install-runtime'
  | 'upload'
  | 'start'
  | 'tunnel'
  | 'handshake'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  /** Waiting its turn: the server warms hosts one at a time, and another host is
   *  connecting first. Nothing has started for this one yet. */
  | 'queued';

export interface HostConnectStep {
  phase: DaemonConnectPhase;
  /** Short chip label ("Upload daemon"), not a sentence. */
  label: string;
  status: 'done' | 'active' | 'todo';
}

export interface HostStatus {
  /** Config alias — the key every surface uses. */
  host: string;
  label: string;
  hostname: string;
  user?: string;
  connected: boolean;
  phase: DaemonConnectPhase;
  /** Sentence for the UI, e.g. "Installing the session daemon runtime on Big remote host…". */
  phaseLabel: string;
  /** The 7 user-visible steps, in order. */
  steps: HostConnectStep[];
  /** First-connect explainer shown during install-runtime/upload. */
  note?: string;
  phaseElapsedMs: number;
  connectElapsedMs: number;
  error?: string;
  kind?: string;
  hint?: string;
  retryInMs?: number;
  warmup?: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  discovered?: boolean;
  /** Server clock (ms epoch) when this snapshot was built — the ordering key. */
  at: number;
}

/**
 * Every configured host's current connect status.
 *
 * 404 is a designed answer, not a fault: a cloud replica or a Mac running an older
 * build has no such route, and the picker still works off list-dirs polling there.
 * It rides `quietStatuses` so it stays out of the error-log audit.
 */
export async function fetchHostStatus(): Promise<HostStatus[]> {
  const res = await apiGet<{ hosts?: HostStatus[] }>('/api/hosts/status', undefined, { quietStatuses: [404] });
  return res.hosts ?? [];
}

/**
 * Ask the server to connect this host NOW (the "Connect now" / "Retry" button).
 *
 * Answers the fresh status so the caller can seed the store without waiting for
 * the WS push. 409 = a connect is already running, 404 = unknown host: both are
 * designed outcomes, so they ride `quietStatuses` and stay out of the error audit.
 */
export async function connectHost(host: string): Promise<HostStatus> {
  const res = await apiPost<{ ok: true; status: HostStatus }>(
    `/api/hosts/${encodeURIComponent(host)}/connect`,
    undefined,
    { quietStatuses: [404, 409] },
  );
  return res.status;
}
