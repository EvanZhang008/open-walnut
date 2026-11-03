/**
 * Is a newer Open Walnut published? Twin of the server's
 * src/core/self-update/update-check.ts `UpdateStatus` (no shared package
 * between server and SPA, so keep the two in step by hand).
 */

export type InstallKind = 'source' | 'npm' | 'binary' | 'other' | 'replica';
export type UpdateCheckDisabledReason = 'source' | 'replica' | 'opted-out' | 'test' | 'unknown-version';

export interface UpdateInstallInfo {
  kind: InstallKind;
  sourceDir: string | null;
  packageRoot: string | null;
  manager: 'npm' | 'pnpm' | 'bun' | 'yarn' | null;
  updateCommand: string | null;
}

export type UpdateChannel = 'stable' | 'nightly';

export type LiveUpdateState = 'off' | 'idle' | 'downloading' | 'installed' | 'waiting' | 'restarting' | 'failed';

/** The running server's own install-and-restart (src/core/self-update/live-update.ts). Route-only; absent from an older server. */
export interface LiveUpdate {
  state: LiveUpdateState;
  /** The version being installed, installed, or restarted into. */
  version: string | null;
  error: string | null;
  /** This server can install AND restart itself (npm or the compiled file, writable, a restart handler). */
  canInstall: boolean;
  /** Why `latest` is held back here, or null. */
  held: string | null;
  /** Config `updates.auto !== false` (the Mac app page reads it to drive the shell). */
  updatesAuto: boolean;
  idle: { ready: boolean; userIdleMs: number | null; turnsRunning: number; waitingSince: string | null };
}

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
  /** A version installed after this server started (its startup update outlived the wait): a restart runs it. Route-only. */
  installed?: string;
  /** A 0.6.x Homebrew keg that updates itself: `brew upgrade` moves it to the compiled file. Route-only. */
  brewHint?: { note: string; command: string };
  checkedAt: string | null;
  error: string | null;
  checking: boolean;
  packageUrl: string;
  /** The server's live self-update; absent from a server older than it. */
  live?: LiveUpdate;
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

/** A refused install or restart: `code` is the server's error (`cannot_install`, `no_update`, `no_restart`). */
export class UpdateActionError extends Error {
  /** `status`: the server's status sent with the refusal, when it sent one. */
  constructor(message: string, readonly code: string | null, readonly fix: string | null, readonly status: UpdateStatus | null = null) {
    super(message);
    this.name = 'UpdateActionError';
  }
}

async function postAction(path: string, signal?: AbortSignal): Promise<UpdateStatus> {
  const res = await fetch(`${STATUS_URL}/${path}`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (res.ok) return res.json() as Promise<UpdateStatus>;
  let body: { error?: unknown; message?: unknown; fix?: unknown; status?: unknown } = {};
  try { body = await res.json() as typeof body; } catch { /* not JSON */ }
  const code = typeof body.error === 'string' ? body.error : null;
  const fix = typeof body.fix === 'string' ? body.fix : null;
  const message = typeof body.message === 'string' ? body.message : actionErrorMessage(code, res.status);
  const status = body.status && typeof body.status === 'object' ? body.status as UpdateStatus : null;
  throw new UpdateActionError(message, code, fix, status);
}

function actionErrorMessage(code: string | null, status: number): string {
  switch (code) {
    case 'cannot_install': return 'This copy of Walnut cannot install updates by itself.';
    case 'no_update': return 'There is no installed update to restart into.';
    case 'no_restart': return 'This Walnut cannot restart itself. Quit it and start it again to use the update.';
    default: return code ? `The server said ${code} (HTTP ${status}).` : `HTTP ${status}`;
  }
}

/** Install `latest` now and restart as soon as it is in (the person asked: no idle wait). 202 = started. */
export function installUpdateNow(signal?: AbortSignal): Promise<UpdateStatus> {
  return postAction('install', signal);
}

/** Restart into the version already installed. */
export function restartIntoUpdate(signal?: AbortSignal): Promise<UpdateStatus> {
  return postAction('restart', signal);
}
