/**
 * The Mac app's automatic update, decided by the page (the shell only downloads
 * and installs when asked). Pure, so a test drives it with a fake shell state:
 *
 * - `updates.auto` on (the server's `live.updatesAuto`) and the shell says a
 *   release is available: start the download, once per version per window.
 * - downloaded, the server's idle gate ready (nobody active for 10 minutes, no
 *   turn running), and no window holds unsaved work: restart into it, once, and
 *   only from one window: a localStorage claim with a timestamp keeps the other
 *   windows out while it runs. Unsaved work is checked by the caller AFTER this
 *   says `restart`, right before the claim; with any, nothing happens.
 */
import type { AppUpdateState } from '@/hooks/useAppUpdate';
import type { LiveUpdate } from '@/api/update';
import { getAppUpdateDownloadedVersion, resolveAppUpdateButtonAction } from './app-update-logic';

export const AUTO_CLAIM_KEY = 'open-walnut-app-auto-update-claim';
/** A claim older than this is a window that died mid-restart: another may take it. */
export const AUTO_CLAIM_MS = 3 * 60_000;
/**
 * The last automatic restart, kept across the restart itself: when the app comes back still
 * reporting the same download (the install did not take), it does not restart again by itself
 * for this long. The person's Restart click is never held by it.
 */
export const AUTO_RESTARTED_KEY = 'open-walnut-app-auto-restarted';
export const RESTART_ONCE_MS = 6 * 60 * 60_000;

export interface AutoClaim { step: 'download' | 'restart'; version: string; owner: string; at: number }

export interface AutoInput {
  shell: AppUpdateState | null;
  live: LiveUpdate | null | undefined;
  /** Versions this window already acted on, per step (`download:1.2.3`, `restart:1.2.3`). */
  done: ReadonlySet<string>;
  claim: AutoClaim | null;
  /** The last automatic restart in any window (AUTO_RESTARTED_KEY). */
  lastRestart?: { version: string; at: number } | null;
  owner: string;
  now: number;
}

export type AutoStep = { step: 'download' | 'restart'; version: string } | null;

export function nextAutoStep(input: AutoInput): AutoStep {
  const { shell, live } = input;
  if (!shell?.enabled || !live?.updatesAuto) return null;
  const action = resolveAppUpdateButtonAction(shell);
  if (action === 'download' && shell.status === 'available' && shell.availableVersion) {
    return gate(input, { step: 'download', version: shell.availableVersion });
  }
  // Only a clean `downloaded`: after a failed install the person retries by hand.
  if (action === 'install' && shell.status === 'downloaded' && live.idle?.ready) {
    const version = getAppUpdateDownloadedVersion(shell);
    const last = input.lastRestart;
    if (last && last.version === version && Math.abs(input.now - last.at) < RESTART_ONCE_MS) return null;
    if (version) return gate(input, { step: 'restart', version });
  }
  return null;
}

function gate(input: AutoInput, step: { step: 'download' | 'restart'; version: string }): AutoStep {
  if (input.done.has(`${step.step}:${step.version}`)) return null;
  if (claimHeldByOther(input.claim, input.owner, input.now, step)) return null;
  return step;
}

export function claimHeldByOther(claim: AutoClaim | null, owner: string, now: number, step: { step: string; version: string }): boolean {
  if (!claim || claim.owner === owner) return false;
  if (claim.step !== step.step || claim.version !== step.version) return false;
  return now - claim.at < AUTO_CLAIM_MS && claim.at - now < AUTO_CLAIM_MS;
}

export function parseClaim(raw: string | null): AutoClaim | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AutoClaim>;
    if ((v.step !== 'download' && v.step !== 'restart') || typeof v.version !== 'string'
      || typeof v.owner !== 'string' || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
    return { step: v.step, version: v.version, owner: v.owner, at: v.at };
  } catch { return null; }
}

type ClaimStore = Pick<Storage, 'getItem' | 'setItem'>;

export function readClaim(store: ClaimStore | null): AutoClaim | null {
  try { return parseClaim(store?.getItem(AUTO_CLAIM_KEY) ?? null); } catch { return null; }
}

/**
 * Take the claim for `step`, unless another live window holds it. Write, then read
 * back: of two windows writing at once, the one whose write stayed wins.
 */
export function takeClaim(store: ClaimStore | null, step: { step: 'download' | 'restart'; version: string }, owner: string, now: number): boolean {
  if (!store) return true;
  if (claimHeldByOther(readClaim(store), owner, now, step)) return false;
  try { store.setItem(AUTO_CLAIM_KEY, JSON.stringify({ ...step, owner, at: now })); } catch { return true; }
  return readClaim(store)?.owner === owner;
}

export function readLastRestart(store: Pick<Storage, 'getItem'> | null): { version: string; at: number } | null {
  try {
    const v = JSON.parse(store?.getItem(AUTO_RESTARTED_KEY) ?? 'null') as { version?: unknown; at?: unknown } | null;
    return v && typeof v.version === 'string' && typeof v.at === 'number' && Number.isFinite(v.at) ? { version: v.version, at: v.at } : null;
  } catch { return null; }
}

export function writeLastRestart(store: Pick<Storage, 'setItem'> | null, version: string, now: number): void {
  try { store?.setItem(AUTO_RESTARTED_KEY, JSON.stringify({ version, at: now })); } catch { /* quota, private mode */ }
}
