/**
 * Cloud-companion setup API client (/api/cloud-setup).
 *
 * Mirrors src/web/routes/cloud-setup.ts one-for-one. The types are the REDACTED
 * shapes — the pairing code never reaches the browser through any of these calls
 * except getUserData(), whose whole purpose is handing the operator the blob they
 * paste into their VM.
 */

import { apiDelete, apiGet, apiPost } from './client';
import { log } from '@/utils/log';

export type CloudSetupStepId =
  | 'preflight'
  | 'generate'
  | 'provision'
  | 'await-vm'
  | 'dns'
  | 'await-server'
  | 'claim-and-wire'
  | 'verify-sync'
  | 'done';

/** Execution order — also the checklist render order. */
export const CLOUD_SETUP_STEP_IDS: readonly CloudSetupStepId[] = [
  'preflight',
  'generate',
  'provision',
  'await-vm',
  'dns',
  'await-server',
  'claim-and-wire',
  'verify-sync',
  'done',
];

/** Mirrors the server's CLOUD_SETUP_LOG_TAIL_MAX (src/core/cloud-setup/job-types.ts). */
export const CLOUD_SETUP_LOG_TAIL_MAX = 200;

export type CloudSetupProviderId = 'aws' | 'hetzner' | 'azure' | 'gcp' | 'manual';
export type CloudSetupDomainMode = 'own-domain' | 'sslip';
export type CloudSetupJobStatus = 'running' | 'awaiting-input' | 'failed' | 'done' | 'cancelled';
export type CloudSetupStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface CloudSetupStepState {
  status: CloudSetupStepStatus;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface CloudSetupAwaitingInput {
  kind: 'vm-ip' | 'credentials' | 'dns-confirm';
  prompt: string;
}

/** GET /job — the redacted job state (no pairingCode field exists here). */
export interface CloudSetupJob {
  version: 1;
  id: string;
  provider: CloudSetupProviderId;
  domainMode: CloudSetupDomainMode;
  domain?: string;
  ip?: string;
  region?: string;
  instanceType?: string;
  instanceRef?: string;
  status: CloudSetupJobStatus;
  currentStep: CloudSetupStepId;
  steps: Record<CloudSetupStepId, CloudSetupStepState>;
  awaitingInput?: CloudSetupAwaitingInput;
  logTail: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** SSE 'progress' payload. `logLines` is a DELTA, not the whole tail. */
export interface CloudSetupProgress {
  jobId: string;
  status: CloudSetupJobStatus;
  currentStep: CloudSetupStepId;
  steps: Record<CloudSetupStepId, CloudSetupStepState>;
  logLines?: string[];
  awaitingInput?: CloudSetupAwaitingInput;
  error?: string;
  updatedAt: string;
}

export interface CloudSetupDetect {
  available: boolean;
  detail: string;
  needs?: 'api-token' | 'cli-login' | 'nothing';
  /**
   * Selectable local credential profiles (aws: ~/.aws profile names), when the
   * driver found more than the default. Rendered as a picker. Server-side these
   * are kept out of every log line — do not put them in a log call here either.
   */
  profiles?: string[];
  /** Which profile the server actually probed with, when one was requested. */
  activeProfile?: string;
}

export interface CloudSetupProvider {
  id: CloudSetupProviderId;
  label: string;
  costHint: string;
  /** False = instructions-only driver (the operator creates the VM by hand). */
  canProvision: boolean;
  detect: CloudSetupDetect;
}

export interface StartCloudSetupBody {
  provider: CloudSetupProviderId;
  domainMode: CloudSetupDomainMode;
  domain?: string;
  region?: string;
  instanceType?: string;
  /** Local CLI credential profile to deploy with (aws: an ~/.aws profile name). */
  profile?: string;
  credentials?: string;
  force?: boolean;
}

export interface CloudSetupUserData {
  userData: string;
  steps: string[];
  consoleUrl?: string;
}

/**
 * `awsProfile` re-probes the aws driver with that local profile, so the picker can
 * report whether the chosen account authenticates before a deploy is started.
 */
export function getProviders(awsProfile?: string): Promise<{ providers: CloudSetupProvider[] }> {
  // Each card's detect probe shells out server-side (5s cap per driver), so the
  // default 15s client timeout is too tight once a few drivers ship.
  const query = awsProfile ? `?awsProfile=${encodeURIComponent(awsProfile)}` : '';
  return apiGet<{ providers: CloudSetupProvider[] }>(`/api/cloud-setup/providers${query}`, undefined, { timeoutMs: 30_000 });
}

export function startSetup(body: StartCloudSetupBody): Promise<{ job: CloudSetupJob }> {
  return apiPost<{ job: CloudSetupJob }>('/api/cloud-setup/start', body);
}

/** Current job, or null when none exists (the route answers 404 for that). */
export async function getJob(): Promise<CloudSetupJob | null> {
  try {
    const res = await apiGet<{ job: CloudSetupJob }>('/api/cloud-setup/job');
    return res.job;
  } catch (err) {
    if (err instanceof Error && /404|No cloud setup job/i.test(err.message)) return null;
    // ApiError carries the status on the instance, but the message is the
    // server's text — check both so a plain 404 statusText also lands here.
    if (typeof err === 'object' && err !== null && (err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export function provideInput(body: { ip?: string; credentials?: string; confirmDnsSkip?: boolean }): Promise<{ job: CloudSetupJob }> {
  return apiPost<{ job: CloudSetupJob }>('/api/cloud-setup/job/input', body);
}

export function retryJob(): Promise<{ job: CloudSetupJob }> {
  return apiPost<{ job: CloudSetupJob }>('/api/cloud-setup/job/retry');
}

export function cancelJob(): Promise<{ job: CloudSetupJob }> {
  return apiPost<{ job: CloudSetupJob }>('/api/cloud-setup/job/cancel');
}

export function clearJob(): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>('/api/cloud-setup/job');
}

/**
 * The manual path's copy box. Needs a started job — the code baked into the blob
 * comes from that job, so a fresh one per request would strand a booted VM.
 */
export function getUserData(params: {
  provider: CloudSetupProviderId;
  domainMode: CloudSetupDomainMode;
  domain?: string;
}): Promise<CloudSetupUserData> {
  const query: Record<string, string> = { provider: params.provider, domainMode: params.domainMode };
  if (params.domain) query.domain = params.domain;
  return apiGet<CloudSetupUserData>('/api/cloud-setup/user-data', query);
}

export interface StreamJobHandlers {
  /** Full state, written once per connection before any replay. */
  onSnapshot?: (job: CloudSetupJob) => void;
  onProgress?: (progress: CloudSetupProgress) => void;
  /**
   * Latest SSE event id seen. Hold it and pass it back as `lastEventId` on the
   * next mount so the ring buffer replays only what was missed. Snapshot frames
   * carry no id by design, so they never move this.
   */
  onEventId?: (id: string) => void;
  /** The stream dropped. Caller decides whether to fall back to polling. */
  onError?: () => void;
}

/**
 * Subscribe to the replayable 'cloud-setup' SSE channel.
 *
 * `lastEventId` is passed as a query param (the route reads either that or the
 * Last-Event-ID header) so a REMOUNT resumes where the previous mount stopped —
 * the browser only sends the header on its own auto-reconnect, which a fresh
 * EventSource is not. Returns a close function.
 */
export function streamJob(handlers: StreamJobHandlers, lastEventId?: string): () => void {
  const url = lastEventId
    ? `/api/cloud-setup/job/stream?lastEventId=${encodeURIComponent(lastEventId)}`
    : '/api/cloud-setup/job/stream';
  let source: EventSource;
  try {
    source = new EventSource(url);
  } catch (err) {
    log.warn('cloud-setup', 'EventSource unavailable — falling back to polling', { error: String(err) });
    handlers.onError?.();
    return () => {};
  }

  source.addEventListener('snapshot', (ev) => {
    try {
      handlers.onSnapshot?.((JSON.parse((ev as MessageEvent<string>).data) as { job: CloudSetupJob }).job);
    } catch (err) {
      log.warn('cloud-setup', 'bad snapshot frame', { error: String(err) });
    }
  });
  source.addEventListener('progress', (ev) => {
    const msg = ev as MessageEvent<string>;
    if (msg.lastEventId) handlers.onEventId?.(msg.lastEventId);
    try {
      handlers.onProgress?.(JSON.parse(msg.data) as CloudSetupProgress);
    } catch (err) {
      log.warn('cloud-setup', 'bad progress frame', { error: String(err) });
    }
  });
  source.addEventListener('error', () => {
    // EventSource retries on its own; surface it so the caller can start polling
    // as a belt (a 401 in a token-authed deployment never recovers, since the
    // browser API cannot attach an Authorization header).
    handlers.onError?.();
  });

  return () => {
    try { source.close(); } catch { /* already closed */ }
  };
}
