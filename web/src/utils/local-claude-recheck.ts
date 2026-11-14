/**
 * The local Claude Code re-check, owned by the always-mounted Sidebar instead
 * of whichever card is on screen: signing in, and installing by hand with the
 * command the card shows, happen in a terminal, out of Walnut's sight, so while
 * the sign-in or install notice would show ask the server every 15s
 * (2026-11-08: a Claude Code that appeared after the card read "not installed"
 * was never noticed). The answer arrives as a system:health push, which clears the bell dot
 * and the card section on every route, with or without a card mounted.
 *
 * One request at a time: the interval, a card mount and a panel open share
 * the same in-flight promise.
 *
 * Only while the Mac answers: the check looks at the Mac's own Claude Code, so a
 * console behind a host replica whose Mac is away would only collect a refusal
 * every 15s (2026-11-14 nightly: replica-away-read.spec.ts saw
 * `503 POST /api/system/local-claude/check mac-away`). The Mac's next health push
 * after it comes back says where it stands, and the interval resumes then.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { checkLocalClaude } from '@/api/local-claude';
import { getLeaderPresence, subscribeLeaderPresence } from '@/api/leader-presence';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useLocalDismissed } from '@/utils/host-banner-dismiss';
import { claudeBannerView, localAnswerUnsettled, localNoticeShows, SIGN_IN_RECHECK_MS } from '@/utils/local-claude-banner';
import { log } from '@/utils/log';

let inFlight: Promise<void> | null = null;

/** Ask the server to look at this machine's Claude Code again now (single flight; nothing while the Mac is away). */
export function recheckLocalClaudeNow(): Promise<void> {
  if (inFlight) return inFlight;
  if (!getLeaderPresence().answers) return Promise.resolve();
  inFlight = checkLocalClaude(true)
    .then(() => undefined)
    .catch((err) => { log.warn('local-claude', 'sign-in re-check failed', { error: String(err) }); })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Whether to keep re-checking: the sign-in or install notice would render (a
 * dismissed one does not), or the last answer settled nothing (localAnswerUnsettled),
 * no fix of Walnut's own is running (that fix re-checks when it ends), and the
 * Mac answers this console (`macAnswers`, api/leader-presence.ts).
 */
export function localRecheckWanted(health: SystemHealth | undefined, dismissed: readonly string[], loading = false, macAnswers = true): boolean {
  if (!health || loading || !macAnswers) return false;
  const kind = localNoticeShows(health, dismissed, loading);
  if (kind !== 'sign-in' && kind !== 'install' && !localAnswerUnsettled(health)) return false;
  return !claudeBannerView(health)?.running;
}

/** Re-check every SIGN_IN_RECHECK_MS while localRecheckWanted. */
export function useLocalClaudeRecheck(health: SystemHealth | undefined, loading = false): void {
  const dismissed = useLocalDismissed();
  const macAnswers = useSyncExternalStore(subscribeLeaderPresence, () => getLeaderPresence().answers, () => true);
  const wanted = localRecheckWanted(health, dismissed, loading, macAnswers);
  useEffect(() => {
    if (!wanted) return;
    const timer = setInterval(() => { void recheckLocalClaudeNow(); }, SIGN_IN_RECHECK_MS);
    return () => clearInterval(timer);
  }, [wanted]);
}

/** Test hook. */
export function __resetLocalClaudeRecheckForTests(): void {
  inFlight = null;
}
