/**
 * An engine CLI's own sign-in and install, per host (server: src/web/routes/engine-sign-in.ts,
 * src/core/agents/engine-sign-in.ts). Every call has a deadline a little past the server's own
 * (its per-step deadline plus the daemon's), so a host that does not answer ends in words, never
 * in a spinner that never stops.
 */
import { apiDelete, apiGet, apiPost, apiPut } from './client';

export type EngineSignInState = 'signed_in' | 'not_signed_in' | 'not_installed' | 'unknown';

export interface EngineInstallState {
  state: 'idle' | 'running' | 'done' | 'failed';
  startedAt?: number;
  endedAt?: number;
  installed?: boolean;
  version?: string | null;
  exitCode?: number | null;
  log?: string;
  error?: string;
}

export interface EngineSignInLink {
  id: string;
  link: string;
  startedAt: number;
  expiresAt: number;
  phase: 'waiting_code' | 'checking';
}

export interface EngineSignInStatus {
  engine: string;
  host: string;
  hostName: string;
  state: EngineSignInState;
  installed: boolean | null;
  version: string | null;
  reason: string | null;
  method: 'google' | 'api-key' | null;
  google: boolean | null;
  apiKey: { set: boolean; source: 'settings' | 'host-env' | null };
  signIn: EngineSignInLink | null;
  install: EngineInstallState & { command: string; canInstall: boolean };
  needsDaemonUpdate?: boolean;
  /** false: the host had no open link and was not dialled (the hosts list). */
  connected?: boolean;
  checkedAt: string;
}

const base = (engine: string) => `/api/engines/${encodeURIComponent(engine)}`;

export function engineSignInHosts(engine: string): Promise<{ engine: string; hosts: EngineSignInStatus[] }> {
  return apiGet(`${base(engine)}/sign-in/hosts`, undefined, { timeoutMs: 35_000 });
}

/** One host's status; `fresh` asks the CLI again instead of the daemon's last answer. Dials the host. */
export function engineSignInStatus(engine: string, host: string, fresh = false): Promise<EngineSignInStatus> {
  return apiGet(`${base(engine)}/sign-in`, { host, ...(fresh ? { fresh: '1' } : {}) }, { timeoutMs: 45_000 });
}

export function startEngineSignIn(engine: string, host: string, restart = false): Promise<EngineSignInLink & { host: string; reused?: boolean }> {
  return apiPost(`${base(engine)}/sign-in`, { host, ...(restart ? { restart: true } : {}) }, { timeoutMs: 50_000 });
}

export function finishEngineSignIn(engine: string, host: string, id: string, code: string): Promise<{ status: EngineSignInStatus }> {
  return apiPost(`${base(engine)}/sign-in/finish`, { host, id, code }, { timeoutMs: 95_000, quietStatuses: [400, 504] });
}

export function cancelEngineSignIn(engine: string, host: string, id?: string): Promise<{ cancelled: boolean }> {
  return apiPost(`${base(engine)}/sign-in/cancel`, { host, ...(id ? { id } : {}) }, { timeoutMs: 20_000 });
}

export function signOutEngine(engine: string, host: string): Promise<{ status: EngineSignInStatus }> {
  return apiPost(`${base(engine)}/sign-out`, { host }, { timeoutMs: 45_000 });
}

/** The key is one setting for every host; `host` picks whose status comes back with it. */
export function saveEngineApiKey(engine: string, key: string, host: string): Promise<{ apiKey: { set: boolean }; status?: EngineSignInStatus }> {
  return apiPut(`${base(engine)}/api-key`, { key, host }, { timeoutMs: 45_000, quietStatuses: [400] });
}

export function removeEngineApiKey(engine: string, host: string): Promise<{ apiKey: { set: boolean }; status?: EngineSignInStatus }> {
  return apiDelete(`${base(engine)}/api-key?host=${encodeURIComponent(host)}`, { timeoutMs: 45_000 });
}

export function startEngineInstall(engine: string, host: string): Promise<EngineInstallState> {
  return apiPost(`${base(engine)}/install`, { host }, { timeoutMs: 20_000, quietStatuses: [409] });
}

export function engineInstallStatus(engine: string, host: string): Promise<EngineInstallState> {
  return apiGet(`${base(engine)}/install`, { host }, { timeoutMs: 20_000 });
}
