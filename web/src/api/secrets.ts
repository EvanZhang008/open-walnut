/**
 * The Mac's secrets and the hosts each is copied to (server:
 * src/core/secrets/fleet-secrets.ts, routes/secrets-v1.ts). No response ever
 * carries a value; the value only goes up, in a PUT.
 */
import { apiDelete, apiGet, apiPut } from './client';

export interface SecretCopy {
  version: number | null;
  at: number;
  error?: string;
}

export interface FleetSecret {
  name: string;
  description?: string;
  hosts: string[];
  env?: string;
  sessions?: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  copies: Record<string, SecretCopy>;
}

export interface SecretChange {
  value?: string;
  hosts?: string[];
  env?: string | null;
  sessions?: boolean;
  description?: string;
  /** Adding: the server refuses a name already taken (409 exists). */
  create?: boolean;
}

export function fetchSecrets(): Promise<{ active: boolean; secrets: FleetSecret[] }> {
  return apiGet('/api/v1/secrets', undefined, { timeoutMs: 10_000, quietStatuses: [404] });
}

export function saveSecret(name: string, change: SecretChange): Promise<{ secret: FleetSecret }> {
  return apiPut(`/api/v1/secrets/${encodeURIComponent(name)}`, change);
}

export function deleteSecret(name: string): Promise<{ name: string; pending: string[] }> {
  return apiDelete(`/api/v1/secrets/${encodeURIComponent(name)}`, { timeoutMs: 30_000 });
}
