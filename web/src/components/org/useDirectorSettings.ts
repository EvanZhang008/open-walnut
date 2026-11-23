/**
 * How the Org page lists the Directors (src/core/org/org-settings.ts `directorsLayout`,
 * `directorsShowProjects`), shared by the two places that show it: Settings → Org (OrgSection) and the
 * Org page's gear (OrgSettingsMenu). 2026-11-20, the user: "in the setting make sure both the P1, and
 * current can be choose ... also another option to hide the project name". Both only matter while the
 * Directors experiment (`org_leaders`) is on, so neither shows while it is off. Saved on the server, so
 * the phone reads the same choice.
 */
import { useState } from 'react';
import { useExperimental } from '@/hooks/useExperimental';
import type { SegmentedOption } from '@/components/settings/inputs/SegmentedControl';
import { useOrgSettings } from './useOrgSettings';

export type DirectorsLayout = 'fold' | 'sections';

/** The two rows' names, the same in Settings > Org and the Org page's settings panel. */
export const DIRECTORS_LAYOUT_LABEL = 'Where Directors show';
export const DIRECTORS_PROJECTS_LABEL = 'Group Directors by project';

export const DIRECTORS_LAYOUT_OPTIONS: ReadonlyArray<SegmentedOption<DirectorsLayout>> = [
  { value: 'fold', label: 'Org chart', testId: 'directors-layout-fold', title: 'On the Org chart, a folded "N directors" line under each VP; the list stays one row per VP' },
  { value: 'sections', label: 'Also in the list', testId: 'directors-layout-sections', title: 'A Directors section after the VPs too, one row per Director' },
];

/** One line per choice: what it means. The list draws nothing under a VP's row (2026-11-22, the user:
 *  "We need to be super simple"), so the stored 'fold' now means the chart only. */
export function directorsLayoutHelp(layout: DirectorsLayout): string {
  return layout === 'sections'
    ? 'On the Org chart, and a Directors section after the VPs in the list, one row per Director.'
    : 'On the Org chart: a folded "N directors" line under each VP; open it to see them.';
}

export const DIRECTORS_PROJECTS_HELP = 'In the Org chart\'s "N directors" line, each project\'s Directors sit under its name. Off: one list, in their order.';

export function useDirectorSettings() {
  const on = useExperimental('org_leaders');
  const { settings, save } = useOrgSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const layout: DirectorsLayout = settings.directorsLayout === 'sections' ? 'sections' : 'fold';
  const showProjects = settings.directorsShowProjects !== false;
  const write = (patch: { directorsLayout?: DirectorsLayout; directorsShowProjects?: boolean }) => {
    setBusy(true);
    setError(undefined);
    save(patch)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return {
    on, layout, showProjects, busy, error,
    setLayout: (v: DirectorsLayout) => write({ directorsLayout: v }),
    setShowProjects: (v: boolean) => write({ directorsShowProjects: v }),
  };
}
