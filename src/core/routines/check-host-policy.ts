/**
 * Where a trigger check may run, by who is asking (src/lib/caller-origin.ts).
 *
 * A check is a shell command the host's daemon runs as the user. Run on this Mac
 * it is a caller on this Mac like any other: a check that curled this server's
 * /api/health/sleep read Apple Health for a session on another host (2026-09
 * gate). So a check follows the rule session controls follow
 * (src/core/sessions/control-host-policy.ts):
 *
 *   caller                                      may run a check on
 *   this Mac (`__local__`)                      any host
 *   a paired device or an API key               any host: both can already start
 *     (`remote-http`)                           a coding session on this Mac,
 *                                               which can do all a check can
 *   a session on host X (`host:X`)              host X only
 *   anything else                               no host
 *
 * Asked by every path that hands a daemon a command: the one-off test, a create,
 * and a change to a saved check's command, cwd or host. It is asked BEFORE the
 * daemon is looked up (looking up this Mac's daemon can start it), so a refused
 * check never reaches a daemon. Toggling, running or deleting a saved trigger
 * hands over nothing new and is not asked.
 */

import {
  LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN, ambientCallerOrigin, hostOrigin, isLocalOrigin, lowerOrigin,
} from '../../lib/caller-origin.js';
import { SessionControlError } from '../sessions/session-controls.js';

const LOCAL_HOST = '__local__';
const HOST_PREFIX = 'host:';

/**
 * Who a core call acts for: the origin its route read, never above the one in
 * effect. Omitted means the server's own code (a shipped routine, a task wait).
 */
export function checkCallerOrigin(origin?: string): string {
  return lowerOrigin(origin ?? LOCAL_ORIGIN, ambientCallerOrigin());
}

/** Why `origin` may not run a check on `checkHost`, or null when it may. */
export function checkHostRefusal(checkHost: string, origin: string): string | null {
  if (isLocalOrigin(origin) || origin === REMOTE_HTTP_ORIGIN) return null;
  const host = checkHost.trim() || LOCAL_HOST;
  if (!origin.startsWith(HOST_PREFIX)) {
    return 'A check runs only for a caller on this Mac or a session on the check\'s own host, '
      + 'and this caller could not be identified.';
  }
  if (hostOrigin(host) === origin) return null;
  const own = origin.slice(HOST_PREFIX.length);
  const rule = host === LOCAL_HOST
    ? 'A check that runs on this Mac is accepted only from a caller on this Mac.'
    : `A check that runs on host ${host} is accepted only from a caller on this Mac or a session on host ${host}.`;
  return `${rule} A session on host ${own} may run checks on its own host: pass host "${own}".`;
}

/** Throw the refusal as a 403 before anything asks a daemon. */
export function assertCheckHostAllowed(checkHost: string, origin: string | undefined): void {
  const refusal = checkHostRefusal(checkHost, checkCallerOrigin(origin));
  if (refusal) throw new SessionControlError(refusal, 403);
}

interface CheckCommand { run?: unknown; cwd?: unknown; host?: unknown }

function part(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * True when `next` hands a daemon something `prev` did not: another command,
 * directory or host. A timeout or fire cap change runs nothing new.
 */
export function checkCommandChanged(next: CheckCommand, prev: CheckCommand | undefined): boolean {
  if (!prev) return true;
  return part(next.run) !== part(prev.run)
    || part(next.cwd) !== part(prev.cwd)
    || (part(next.host) || LOCAL_HOST) !== (part(prev.host) || LOCAL_HOST);
}
