/**
 * Transfer a task to another engine or host, and read or edit what Walnut has
 * learned about a host (server: src/web/routes/transfer-v1.ts).
 */
import { apiGet, apiPatch, apiPost } from './client';

/** This machine, as the transfer routes name it. */
export const LOCAL_HOST = '__local__';

export type HostKind = 'laptop' | 'public-cloud-vm' | 'private-cloud-vm' | 'dev-box' | 'unknown';
export type TransferMode = 'carry' | 'brief';

export interface TransferSource {
  sessionId: string;
  engine: string;
  host: string;
  cwd: string | null;
}

export interface TransferOptions {
  taskId: string;
  source: TransferSource | null;
  engines: { id: string; displayName: string }[];
  hosts: { alias: string; label?: string; kind: HostKind | string; probedAt: string | null }[];
  options: { engine: string; host: string; blockedReason?: string }[];
}

export interface TransferBody {
  engine?: string;
  host?: string;
  cwd?: string;
  mode?: TransferMode;
  model?: string;
  message?: string;
  keep_source?: boolean;
}

export interface TransferResult {
  taskId: string;
  title: string;
  sessionId?: string;
  sourceTaskId: string;
  sourceCompleted: boolean;
  history: 'native-copy' | 'replay' | 'brief';
  target: { engine: string; host: string; cwd: string };
  workspace?: { route: 'direct' | 'relay'; bytes: number; bundleDir: string; files: string[] };
  transcriptPath?: string;
}

export interface HostProbe {
  os?: { prettyName?: string; platform?: string; release?: string };
  arch?: string;
  cpus?: number;
  memBytes?: number;
  home?: string;
  diskFreeBytes?: number;
  tools?: Record<string, string | null>;
  cloud?: unknown;
  proxyEnv?: unknown;
  internet?: unknown;
  uptimeSec?: number;
  probedAt?: string;
}

export interface HostProfile {
  host: string;
  kind: HostKind | string;
  kindReasons?: string[];
  kindSetByUser?: boolean;
  userNote?: string;
  probed?: HostProbe;
  observed?: {
    repoPaths?: Record<string, { path: string; at: string }>;
    reaches?: Record<string, { ok: boolean; at: string; error?: string }>;
  };
  notes?: { key: string; fact: string; evidence?: string; at: string; taskId?: string }[];
  updatedAt?: string;
}

export function fetchTransferOptions(taskId: string): Promise<TransferOptions> {
  return apiGet<TransferOptions>(`/api/v1/tasks/${encodeURIComponent(taskId)}/transfer-options`);
}

/** Packing and copying a workspace can take minutes, so the server runs a transfer
 *  as a job: POST waits a few seconds, then answers 202 with its id, and the
 *  client reads it back with short GETs (no request holds a connection for long). */
const POST_WAIT_MS = 8_000;
const POLL_EVERY_MS = 2_000;
/** Give up watching (the transfer keeps running on the server) after this long. */
export const TRANSFER_TIMEOUT_MS = 15 * 60_000;

type TransferAnswer = (TransferResult & { state?: 'done' }) | { state: 'running'; transferId: string };

export async function transferTask(taskId: string, body: TransferBody): Promise<TransferResult> {
  // A refused transfer is a designed answer (409 engine_host_unsupported, 400 bad_cwd).
  const quiet = { quietStatuses: [400, 404, 409] };
  let answer = await apiPost<TransferAnswer>(`/api/v1/tasks/${encodeURIComponent(taskId)}/transfer`,
    { ...body, wait_ms: POST_WAIT_MS }, { timeoutMs: POST_WAIT_MS + 15_000, ...quiet });
  const deadline = Date.now() + TRANSFER_TIMEOUT_MS;
  while (answer.state === 'running') {
    if (Date.now() > deadline) throw new DOMException('transfer still running', 'TimeoutError');
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    answer = await apiGet<TransferAnswer>(`/api/v1/transfers/${encodeURIComponent(answer.transferId)}`, undefined, { timeoutMs: 15_000, ...quiet });
  }
  return answer as TransferResult;
}

export function fetchHostProfile(host: string): Promise<{ profile: HostProfile; summary: string }> {
  return apiGet(`/api/v1/hosts/${encodeURIComponent(host)}/profile`);
}

export function updateHostProfile(
  host: string,
  body: { kind?: HostKind | null; user_note?: string; refresh?: true },
): Promise<{ profile: HostProfile }> {
  // A probe goes out to the host and back.
  return apiPatch(`/api/v1/hosts/${encodeURIComponent(host)}/profile`, body, { timeoutMs: body.refresh ? 60_000 : 15_000 });
}
