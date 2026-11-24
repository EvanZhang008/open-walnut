/**
 * Host connect status: the wire types for "is this exec host reachable, and if
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
  /**
   * Only on the active `upload` step while the daemon's file goes onto the host: bytes
   * there so far of `total`, sent from this computer (`upload`) or downloaded by the host
   * itself (`download`). Absent from older servers.
   */
  progress?: { via: 'upload' | 'download'; done: number; total: number };
}

/** A readiness problem as the server words it (host-readiness-problems.ts). */
export interface HostStatusReadinessProblem {
  kind: string;
  /** One sentence naming the host; a command inside it is in `backticks`. */
  message: string;
  commands: string[];
  fix?: { action: string; state: 'running' | 'failed'; text: string; needsPassword?: boolean; detail?: string };
}

/** The daemon's host.preflight answer plus the problems the server derived from it. */
export interface HostStatusReadiness {
  claude?: {
    found?: boolean; unknown?: string; path?: string; version?: string; kind?: string; auth?: string;
    versionOk?: boolean; minVersion?: string; installMethod?: string;
  };
  compiler?: { found: boolean; name?: string };
  dtach?: { found: boolean; path?: string };
  platform?: string;
  arch?: string;
  /** Server epoch ms of the last ask (success or failure). */
  checkedAt?: number;
  problems?: HostStatusReadinessProblem[];
  checkError?: string;
  /** The automatic fix running on the host right now. */
  fixing?: { action: string; text: string; startedAt?: number };
  fixes?: unknown[];
  /** false: no project or open task uses the host for sessions, so its Claude Code problem takes no card. */
  usedForSessions?: boolean;
}

export interface HostStatus {
  /** Config alias: the key every surface uses. */
  host: string;
  label: string;
  hostname: string;
  user?: string;
  connected: boolean;
  /** 'off' = a test server that never dials remote hosts (by design). */
  phase: DaemonConnectPhase | 'off';
  /** Sentence for the UI, e.g. "Uploading the session daemon to Big remote host…". */
  phaseLabel: string;
  /** The 6 user-visible steps, in order. */
  steps: HostConnectStep[];
  /** First-connect explainer shown during upload. */
  note?: string;
  /**
   * The host's first connect is running: no daemon was there when it was probed, and its link
   * was never up in this server. The background card (HostConnectCard) follows these hosts; an
   * established host's reconnect never carries it. Absent from older servers.
   */
  firstConnect?: true;
  phaseElapsedMs: number;
  connectElapsedMs: number;
  error?: string;
  kind?: string;
  hint?: string;
  /** false = retrying cannot help by itself (auth, host key, ...): Walnut waits for the user. */
  retryable?: boolean;
  /** Epoch ms (server clock) of the next attempt Walnut really has scheduled. Absent = no promise. */
  retryAt?: number;
  /**
   * @deprecated The 60s failure-cache lifetime, not a retry schedule. Never read
   * it; `retryAt` is the real countdown.
   */
  retryInMs?: number;
  /** The last failure seen while reconnecting (phase stays 'reconnecting'). */
  lastError?: string;
  lastKind?: string;
  lastHint?: string;
  /** Server epoch ms when the current reconnect began. */
  reconnectSince?: number;
  /** Server epoch ms when the current connect attempt began. */
  attemptStartedAt?: number;
  /** Server epoch ms when the current connection came up. */
  connectedAt?: number;
  /** Server epoch ms of each time the link dropped by itself in the last hour, oldest first. */
  drops?: number[];
  /** Server clock when the frame was built (clock-skew correction). */
  serverNow?: number;
  warmup?: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  discovered?: boolean;
  readiness?: HostStatusReadiness;
  /** Informational lines for Settings (never a banner row). */
  warnings?: string[];
  daemonDir?: { path: string; display: string; fallback: boolean; reason?: string; freeMb?: number };
  /** false: the host cannot open a terminal now (its daemon has no terminal streams yet); its sessions' Terminal tab says why. */
  terminal?: false;
  /** Why `terminal` is false, in a sentence. */
  terminalWhy?: string;
  /** How this host's daemon gets a newer build, in the server's one sentence; absent on an older server. */
  daemonUpdateHow?: string;
  /**
   * false: this machine has no SSH route to the host (a host-network machine, the cloud box),
   * so what only SSH can do (VS Code desktop's Remote-SSH) is not offered there; `via` names
   * the route it has. Absent = an SSH host, and on an older server.
   */
  ssh?: false;
  via?: 'host-network' | 'cloud';
  /** The name the host's machine calls itself (its daemon's hello); absent on an older server. */
  machineName?: string;
  /** Tombstone on the host:status event: the host left the config (or was disabled). */
  removed?: true;
  /** Server clock (ms epoch) when this snapshot was built: the ordering key. */
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
 * `agents`: the Install / Update click on the coding agent's line, the only ask that
 * installs or updates one (the server never does it by itself).
 */
export async function connectHost(host: string, opts: { agents?: boolean } = {}): Promise<HostStatus> {
  const res = await apiPost<{ ok: true; status: HostStatus }>(
    `/api/hosts/${encodeURIComponent(host)}/connect`,
    opts.agents ? { agents: true } : undefined,
    { quietStatuses: [404, 409] },
  );
  return res.status;
}

/**
 * The person's answer to "Connect to it?" for a host found in ~/.ssh/config
 * (src/core/hosts/found-hosts.ts): `yes` makes it a normal host and dials it now,
 * `not_now` keeps it listed and quiet. The config change arrives as config:changed.
 */
export async function answerFoundHost(host: string, answer: 'yes' | 'not_now'): Promise<{ ok: true; host: string; answer: 'yes' | 'not_now'; status?: HostStatus }> {
  return apiPost(`/api/hosts/${encodeURIComponent(host)}/found-answer`, { answer });
}

/** What `ssh -G <name>` resolves on the server's machine (src/core/hosts/ssh-resolve.ts). */
export interface SshResolved { name: string; hostname: string; port: number; user: string; fromConfig: boolean }

/**
 * The HostName, Port and User ssh would use for `name`, read from ~/.ssh/config on the Walnut
 * machine (it never connects). Null when there is no answer (an older server, a replica, no ssh).
 */
export async function resolveSshName(name: string): Promise<SshResolved | null> {
  const res = await apiGet<SshResolved | undefined>('/api/hosts/ssh-resolve', { name }, { quietStatuses: [400, 404], priority: 'low' }).catch(() => undefined);
  return res && typeof res === 'object' && typeof res.port === 'number' ? res : null;
}

/**
 * Re-run the host's readiness check now (the "Check again" button). Answers the
 * fresh status; the same answer also arrives as a host:status push. On a replica
 * the server relays the ask to the Mac.
 *
 * `background: true` is for a check nobody clicked (the window-focus re-check):
 * it queues like a GET instead of jumping ahead of what paints the screen.
 */
export async function checkHostReadiness(host: string, opts?: { background?: boolean }): Promise<HostStatus> {
  const res = await apiPost<{ ok?: true; status: HostStatus }>(
    `/api/hosts/${encodeURIComponent(host)}/check`,
    undefined,
    { quietStatuses: [404, 409], ...(opts?.background ? { background: true } : {}) },
  );
  return res.status;
}

/** The answer of a daemon update ask (src/core/hosts/host-daemon-update.ts). */
export interface HostDaemonUpdateAnswer { host: string; phase?: string; message?: string }

/**
 * Update the host's Walnut daemon to this server's build now (POST
 * /api/v1/hosts/:host/daemon-update). Only a host-network machine is updated this way; for
 * any other kind the server answers 409 with the way it is updated instead. It answers once
 * the update is decided or started (the upload and handover take minutes); the host's
 * status frame says how it went.
 */
export function requestHostDaemonUpdate(host: string): Promise<HostDaemonUpdateAnswer> {
  return apiPost<HostDaemonUpdateAnswer>(`/api/v1/hosts/${encodeURIComponent(host)}/daemon-update`, undefined, {
    timeoutMs: 30_000, quietStatuses: [403, 404, 409, 503],
  });
}
