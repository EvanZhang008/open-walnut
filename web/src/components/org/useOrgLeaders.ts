/**
 * The Directors under each VP for the Org list's DIRECTORS section (OrgDirectorSection.tsx), from the
 * chart's own cards so the list and the chart list the same projects in the same order, and the VP's
 * projects a New Director may go to. Off while the `org_leaders` experiment is off: no section, and
 * search finds what it found before (on, a search also finds the VP of a Director it finds).
 */
import { useMemo } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { Task } from '@open-walnut/core';
import { useExperimental } from '@/hooks/useExperimental';
import type { VpCard } from './org-chart-model';
import { filterChannels, type ChannelRow } from './org-channels-model';
import { directorProjectsByVp, leaderGroups, leadersMatch, sourcesOf, type LeaderGroup } from './org-leaders';
import type { DirectorProject } from './director-actions';

const NONE: readonly LeaderGroup[] = [];
const NO_PROJECTS: readonly DirectorProject[] = [];

/** What the list draws the Directors from: a VP row's groups, and its projects. */
export interface OrgDirectorsView {
  groupsOf: (row: ChannelRow) => readonly LeaderGroup[];
  projectsOf: (row: ChannelRow) => readonly DirectorProject[];
}

export function useOrgLeaders(cards: readonly VpCard[], tasks: readonly Task[]) {
  const on = useExperimental('org_leaders');
  const byKey = useMemo(() => {
    if (!on) return null;
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    return new Map(cards.map((c) => [c.key, leaderGroups(sourcesOf(c.projects), byId)] as const));
  }, [on, cards, tasks]);
  const projects = useMemo(() => directorProjectsByVp(cards), [cards]);
  const groupsOf = useLeanCallback((row: ChannelRow) => byKey?.get(row.key) ?? NONE, [byKey]);
  const projectsOf = useLeanCallback((row: ChannelRow) => projects.get(row.key) ?? NO_PROJECTS, [projects]);
  const directors = useMemo<OrgDirectorsView>(() => ({ groupsOf, projectsOf }), [groupsOf, projectsOf]);
  /** filterChannels, and a VP one of whose leaders the search finds. */
  const filter = useLeanCallback((rows: readonly ChannelRow[], q: string): ChannelRow[] => {
    const hit = new Set(filterChannels(rows, q).map((r) => r.key));
    return rows.filter((r) => hit.has(r.key) || (!!byKey && leadersMatch(byKey.get(r.key) ?? NONE, q)));
  }, [byKey]);
  return { directors: byKey ? directors : undefined, filter };
}
