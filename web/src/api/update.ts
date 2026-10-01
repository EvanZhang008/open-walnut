/**
 * Is a newer Open Walnut published? Twin of the server's
 * src/core/self-update/update-check.ts `UpdateStatus` (no shared package
 * between server and SPA, so keep the two in step by hand).
 */

export type InstallKind = 'source' | 'npm' | 'other' | 'replica';
export type UpdateCheckDisabledReason = 'source' | 'replica' | 'opted-out' | 'test' | 'unknown-version';

export interface UpdateInstallInfo {
  kind: InstallKind;
  sourceDir: string | null;
  packageRoot: string | null;
  manager: 'npm' | 'pnpm' | 'bun' | 'yarn' | null;
  updateCommand: string | null;
}

export interface UpdateStatus {
  enabled: boolean;
  reason?: UpdateCheckDisabledReason;
  install: UpdateInstallInfo;
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: string | null;
  error: string | null;
  checking: boolean;
  packageUrl: string;
}

const STATUS_URL = '/api/system/update';

/** The server's cached answer; never makes the server call the registry. */
export async function fetchUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  const res = await fetch(STATUS_URL, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<UpdateStatus>;
}

/** Ask the registry now. 202 = the check outran the server's deadline; the body is the stored status. */
export async function checkForUpdateNow(signal?: AbortSignal): Promise<UpdateStatus> {
  const res = await fetch(`${STATUS_URL}/check`, { method: 'POST', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<UpdateStatus>;
}
