/**
 * The local sign-in re-check, owned by the always-mounted Sidebar instead of
 * whichever card is on screen: signing in happens in a terminal, out of
 * Walnut's sight, so while the sign-in notice would show ask the server every
 * 15s. The answer arrives as a system:health push, which clears the bell dot
 * and the card section on every route, with or without a card mounted.
 *
 * One request at a time: the interval, a card mount and a panel open share
 * the same in-flight promise.
 */
import { useEffect } from 'react';
import { checkLocalClaude } from '@/api/local-claude';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useLocalDismissed } from '@/utils/host-banner-dismiss';
import { localNoticeShows, SIGN_IN_RECHECK_MS } from '@/utils/local-claude-banner';
import { log } from '@/utils/log';

let inFlight: Promise<void> | null = null;

/** Ask the server to look at this machine's Claude Code again now (single flight). */
export function recheckLocalClaudeNow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = checkLocalClaude(true)
    .then(() => undefined)
    .catch((err) => { log.warn('local-claude', 'sign-in re-check failed', { error: String(err) }); })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Re-check every SIGN_IN_RECHECK_MS while the sign-in notice would render (dismissed: no). */
export function useLocalClaudeRecheck(health: SystemHealth | undefined, loading = false): void {
  const dismissed = useLocalDismissed();
  const signIn = localNoticeShows(health, dismissed, loading) === 'sign-in';
  useEffect(() => {
    if (!signIn) return;
    const timer = setInterval(() => { void recheckLocalClaudeNow(); }, SIGN_IN_RECHECK_MS);
    return () => clearInterval(timer);
  }, [signIn]);
}

/** Test hook. */
export function __resetLocalClaudeRecheckForTests(): void {
  inFlight = null;
}
