/**
 * The host network from Settings > Remote Hosts (server: src/web/routes/hosts-net.ts):
 * machines that joined with an invite link, and the invites themselves.
 */
import { apiDelete, apiGet, apiPost, apiPut } from './client';

export type NetPath = 'direct' | 'relay' | 'none' | 'unknown';

export interface NetMachine {
  host: string;
  endpoint: string;
  enabled: boolean;
  platform?: string;
  addedAt?: number;
  path: NetPath;
  rttMs?: number;
}

/** How machines reach each other when they cannot connect directly. */
export type NetRelay = 'own' | 'public' | 'none';

export interface NetOverview {
  enabled: boolean;
  macId: string | null;
  /** A cloud companion is paired (it keeps the list; with none, this Mac does). Absent from an older server. */
  companion?: boolean;
  /** The relay in use. Absent from an older server, which only had the companion's. */
  relay?: NetRelay;
  relays: string[];
  syncedAt: number | null;
  error: string | null;
  machines: NetMachine[];
  /** Rows found in ~/.ssh/config that are one of `machines` (found alias to machine): listed once. Absent from an older server. */
  twins?: Record<string, string>;
}

export interface NetInvite {
  id: string;
  link: string;
  command: string;
  /** PowerShell on a Windows PC; absent from a companion older than the Windows join. */
  windowsCommand?: string;
  /** Walnut for Windows to download (the app takes `link`), once the newest release carries it. */
  windowsApp?: string;
  expiresAt: number;
  /** `cancelled`: called back here before a machine used it (absent from an older server). */
  state: 'waiting' | 'joined' | 'expired' | 'failed' | 'cancelled';
  member?: { id: string; name: string; platform?: string };
  error?: string;
}

export function fetchNet(opts?: { signal?: AbortSignal }): Promise<NetOverview> {
  return apiGet<NetOverview>('/api/hosts/net', undefined, { signal: opts?.signal, timeoutMs: 15_000 });
}

export function makeNetInvite(name?: string): Promise<NetInvite> {
  return apiPost<NetInvite>('/api/hosts/net/invites', name ? { name } : {}, { timeoutMs: 70_000 });
}

export function fetchNetInvite(id: string): Promise<NetInvite> {
  return apiGet<NetInvite>(`/api/hosts/net/invites/${encodeURIComponent(id)}`, undefined, { timeoutMs: 10_000, quietStatuses: [404] });
}

/** Call a link back before a machine used it: its code takes no machine in from then on. */
export function cancelNetInvite(id: string): Promise<NetInvite> {
  return apiDelete<NetInvite>(`/api/hosts/net/invites/${encodeURIComponent(id)}`, { timeoutMs: 70_000 });
}

/** Turn the host network on (and read its list); refused with why it did not start. */
export function startNet(): Promise<unknown> {
  return apiPost<unknown>('/api/hosts/net/sync', { enable: true }, { timeoutMs: 70_000 });
}

export function removeNetMachine(host: string): Promise<{ removed: string }> {
  return apiDelete<{ removed: string }>(`/api/hosts/net/machines/${encodeURIComponent(host)}`, { timeoutMs: 70_000 });
}

export function setNetRelay(relay: NetRelay): Promise<unknown> {
  return apiPut<unknown>('/api/hosts/net/relay', { relay }, { timeoutMs: 70_000 });
}
