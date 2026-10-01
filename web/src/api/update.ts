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

export type UpdateChannel = 'stable' | 'nightly';

export interface UpdateStatus {
  enabled: boolean;
  reason?: UpdateCheckDisabledReason;
  install: UpdateInstallInfo;
  current: string;
  /** Which dist-tag this install follows: a `-nightly.*` build follows nightly, a release follows latest. */
  channel: UpdateChannel;
  /** The newest version on this channel, or null before the first successful check. */
  latest: string | null;
  tags: { latest: string | null; nightly: string | null };
  available: boolean;
  /** `open-walnut web` installs a newer release before it starts (config `updates.auto`, default on). Route-only. */
  autoUpdate?: boolean;
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
