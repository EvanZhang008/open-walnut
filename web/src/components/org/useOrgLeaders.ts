/**
 * The leaders under each VP for the Org list (OrgLeaders.tsx), from the chart's own cards so the
 * list and the chart list the same projects in the same order. Off while the `org_leaders`
 * experiment is off: no line, and search finds what it found before.
 */
import { useCallback, useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { useExperimental } from '@/hooks/useExperimental';
import type { VpCard } from './org-chart-model';
import { filterChannels, type ChannelRow } from './org-channels-model';
import { leaderGroups, leadersMatch, sourcesOf, type LeaderGroup } from './org-leaders';

const NONE: readonly LeaderGroup[] = [];

export function useOrgLeaders(cards: readonly VpCard[], tasks: readonly Task[]) {
  const on = useExperimental('org_leaders');
  const byKey = useMemo(() => {
    if (!on) return null;
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    // The Inbox is no one's team: no leaders line there.
    return new Map(cards.filter((c) => c.role === 'VP').map((c) => [c.key, leaderGroups(sourcesOf(c.projects), byId)] as const));
  }, [on, cards, tasks]);
  const leadersOf = useCallback((row: ChannelRow) => byKey?.get(row.key) ?? NONE, [byKey]);
  /** filterChannels, and a VP one of whose leaders the search finds. */
  const filter = useCallback((rows: readonly ChannelRow[], q: string): ChannelRow[] => {
    const hit = new Set(filterChannels(rows, q).map((r) => r.key));
    return rows.filter((r) => hit.has(r.key) || (!!byKey && leadersMatch(byKey.get(r.key) ?? NONE, q)));
  }, [byKey]);
  return { leadersOf: byKey ? leadersOf : undefined, filter };
}
