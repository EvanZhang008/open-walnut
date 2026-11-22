/**
 * What the notification center lists for the section it shows, derived from the feed: the rows of
 * the section (newest first, in same-origin groups), the error cards each problem host caused (they
 * sit under that host's row, so the rest of the view leaves them out), the error families and root
 * causes of the Errors view, and what the header's Clear dismisses. Split out of
 * NotificationPanel.tsx, which keeps the state and lays the lists out.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  sectionOf, effectiveTs, groupErrorsByCategory, partitionErrorsByCause, requestIdOf,
  type Notification,
} from '@/contexts/notifications';
import { hostOfCauseKey } from '@/contexts/notifications/notification-model';
import { getPermissionRequest } from '@/stores/permission-request-store';
import { clearableKeys } from '@/contexts/notifications/settled-asks';
import { collapseSameOrigin, type FeedGroup } from './NotificationFeedCards';
import type { ProblemHost } from './NotificationProblems';
import type { RailSection } from './NotificationRail';

/** How long an ask answered in this browser stays in Needs you after it settles. */
const ANSWERED_HOLD_MS = 3500;

/**
 * The feed's asks answered in this browser that just settled: Needs you keeps them
 * ANSWERED_HOLD_MS with their outcome ("Denied with note “…”"), instead of the row
 * vanishing the moment the server stamps it, which read as nothing having happened.
 */
function useAnsweredHereHold(feed: readonly Notification[]): ReadonlySet<string> {
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const seen = useRef<Set<string> | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const first = seen.current === null;
    if (first) seen.current = new Set();
    for (const n of feed) {
      if (n.kind !== 'permission' || !n.resolved || seen.current!.has(n.id)) continue;
      seen.current!.add(n.id);
      const rid = requestIdOf(n);
      if (first || !rid || !getPermissionRequest(rid)?.answeredHere) continue;
      setHeld((prev) => new Set(prev).add(n.id));
      timers.current.push(window.setTimeout(() => setHeld((prev) => {
        const next = new Set(prev);
        next.delete(n.id);
        return next;
      }), ANSWERED_HOLD_MS));
    }
  }, [feed]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  return held;
}

export interface ErrorBlock { category: string; count: number; groups: FeedGroup[] }

export function useNotificationFeedView({ feed, section, errorCategory, problemHosts }: {
  feed: Notification[];
  section: RailSection;
  /** The error family the user drilled into (null: every family). */
  errorCategory: string | null;
  problemHosts: readonly ProblemHost[];
}) {
  // The error cards each problem host caused (causeKey `host:<alias>`), newest
  // first: they render under that host's row at the top of All and Errors, so
  // the rest of the view leaves them out and a host reads as one block.
  const problemAliases = useMemo(() => problemHosts.map(p => p.alias).join('\n'), [problemHosts]);
  const hostCards = useMemo(() => {
    const aliases = new Set(problemAliases ? problemAliases.split('\n') : []);
    const byHost = new Map<string, Notification[]>();
    for (const n of feed) {
      if (sectionOf(n) !== 'errors' || !n.causeKey) continue;
      const alias = hostOfCauseKey(n.causeKey);
      if (!alias || !aliases.has(alias)) continue;
      const list = byHost.get(alias);
      if (list) list.push(n);
      else byHost.set(alias, [n]);
    }
    for (const list of byHost.values()) list.sort((a, b) => effectiveTs(b) - effectiveTs(a));
    return byHost;
  }, [feed, problemAliases]);
  const hostCardIds = useMemo(() => new Set([...hostCards.values()].flat().map(n => n.id)), [hostCards]);

  // Items of the active section, newest first. Sorting on effectiveTs (not
  // timestamp) keeps a folded recurring error at the top of the list — its
  // `timestamp` is first-seen and can be hours old while it is still firing.
  const answeredHeld = useAnsweredHereHold(feed);
  const items = useMemo(() => {
    // Inbox rows come from the letter store, not the feed.
    const pool = section === 'system' || section === 'inbox' ? []
      : section === 'all' ? feed.filter(n => !hostCardIds.has(n.id))
      // An ask answered here stays a beat in Needs you, saying which choice went.
      : feed.filter(n => sectionOf(n) === section || (section === 'action' && answeredHeld.has(n.id)));
    return [...pool].sort((a, b) => effectiveTs(b) - effectiveTs(a));
  }, [feed, section, hostCardIds, answeredHeld]);

  // Same-origin entries collapse into one expandable group (iPhone-style):
  // a cron job's repeated runs stack under the job name, a session's permission
  // asks stack under the session. Groups keep the newest-first item order.
  const groups = useMemo(() => collapseSameOrigin(items), [items]);

  // Errors get a SECOND level of structure: a category header per family, so
  // three failures of one plugin read as one problem. Category order is
  // most-recent-activity (groupErrorsByCategory), and the same-origin collapse
  // still applies INSIDE each category — the two groupings answer different
  // questions ("what family" vs "is this the same origin repeating").
  //
  // Computed from the FEED, not from the active section's items: the rail lists
  // the categories as sub-entries under Errors (so a specific family is one
  // click away from anywhere), which means the grouping has to exist even while
  // the user is reading another section.
  const sortedErrors = useMemo(
    () => feed.filter(nn => sectionOf(nn) === 'errors').sort((a, b) => effectiveTs(b) - effectiveTs(a)),
    [feed],
  );
  const errorCats = useMemo(() => groupErrorsByCategory(sortedErrors), [sortedErrors]);

  // The selected category, validated against what actually exists: when the last
  // card of the chosen family recovers or is dismissed, the view falls back to
  // all errors instead of pinning an empty pane to a stale filter.
  const activeErrorCategory =
    errorCategory && errorCats.some(g => g.category === errorCategory) ? errorCategory : null;

  // …and a THIRD level, above the families: the ROOT CAUSE. One outage fans out
  // into unrelated conditions (a task's session start, a route 5xx, a delivery
  // failure), so it lands as four red cards in four families and reads as four
  // problems. Cards sharing an open `causeKey` fold into one block instead —
  // only in the all-errors view, because drilling into a family means the user
  // asked for that family's whole list.
  // A problem host's cards are under its row already (hostCards), so they are
  // not a cause block a second time.
  const errorCauses = useMemo(() => (
    section === 'errors' && !activeErrorCategory
      ? partitionErrorsByCause(sortedErrors.filter(n => !hostCardIds.has(n.id)))
      : null
  ), [sortedErrors, section, activeErrorCategory, hostCardIds]);

  const errorBlocks = useMemo<ErrorBlock[] | null>(() => {
    if (section !== 'errors') return null;
    // Whatever a cause block already shows is left OUT of the family blocks, so
    // a card appears exactly once. Drilled into a family there are no cause
    // blocks, so the family keeps its full list (errorCats, as before).
    const cats = errorCauses ? groupErrorsByCategory(errorCauses.rest) : errorCats;
    return cats
      .filter(g => !activeErrorCategory || g.category === activeErrorCategory)
      .map(g => ({
        category: g.category,
        count: g.items.length,
        groups: collapseSameOrigin(g.items),
      }));
  }, [errorCats, errorCauses, section, activeErrorCategory]);

  // What the header's Clear dismisses: the settled entries of exactly what this view lists (the
  // whole feed on All), so "Clear errors" never takes the asks with it and no Clear takes an ask
  // still waiting; nothing in Inbox or System.
  const clearKeys = useMemo<string[]>(() => {
    if (section === 'inbox' || section === 'system') return [];
    if (section === 'all') return clearableKeys(feed);
    if (section === 'errors') {
      return clearableKeys(activeErrorCategory ? errorCats.find(g => g.category === activeErrorCategory)?.items ?? [] : sortedErrors);
    }
    return clearableKeys(items);
  }, [section, activeErrorCategory, errorCats, sortedErrors, items, feed]);

  return { hostCards, groups, errorCats, activeErrorCategory, errorCauses, errorBlocks, clearKeys };
}
