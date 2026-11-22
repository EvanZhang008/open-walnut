/**
 * Where this machine keeps Google sign-ins, and whether one Google grant is held by more than one
 * of them.
 *
 * Google keeps ONE grant per Google account and OAuth client, and revoking any token of it ends
 * the whole grant. Drive backups and a mail account's Google calendar can sign in with the same
 * client (the calendar falls back to Drive's) as the same person, so each holds a token of the
 * same grant: Remove on one must never revoke what the other still uses. Each forgets only its own
 * file then, and the grant is revoked only by the last holder.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readTokenFile, type OAuthTokens } from './desktop-oauth.js';

/** Drive backups' Google token. */
export function driveTokenPath(dataDir: string): string {
  return path.join(dataDir, 'local', 'backup', 'gdrive-token.json');
}

/** The folder of the calendar's sign-ins (one file per mail account, Google's and Microsoft's). */
export function calendarSignInDir(dataDir: string): string {
  return path.join(dataDir, 'local', 'calendar');
}

/** Every Google token file on this machine: Drive's, and the calendar's Google sign-ins. */
async function googleTokenFiles(dataDir: string): Promise<string[]> {
  const dir = calendarSignInDir(dataDir);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return [driveTokenPath(dataDir), ...names.filter((n) => /^sign-in-.+\.json$/.test(n)).map((n) => path.join(dir, n))];
}

const same = (a: string | undefined, b: string | undefined) => !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether a token file other than `file` holds the same Google grant as `t`: the same client, and
 * the same account (or one of them does not say whose it is, which counts as the same).
 */
export async function grantHeldElsewhere(dataDir: string, file: string, t: Pick<OAuthTokens, 'client_id' | 'email'>): Promise<boolean> {
  for (const other of await googleTokenFiles(dataDir)) {
    if (path.resolve(other) === path.resolve(file)) continue;
    const held = await readTokenFile<OAuthTokens & { provider?: string; address?: string }>(other).catch(() => null);
    if (!held || (held.provider && held.provider !== 'Google')) continue;
    if (held.client_id === t.client_id && same(held.email ?? held.address, t.email)) return true;
  }
  return false;
}
