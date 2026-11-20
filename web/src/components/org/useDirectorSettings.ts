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

export const DIRECTORS_LAYOUT_OPTIONS: ReadonlyArray<SegmentedOption<DirectorsLayout>> = [
  { value: 'fold', label: 'Under each VP', testId: 'directors-layout-fold' },
  { value: 'sections', label: 'Own section', testId: 'directors-layout-sections' },
];

/** One line per choice: what it means. */
export function directorsLayoutHelp(layout: DirectorsLayout): string {
  return layout === 'sections'
    ? 'A DIRECTORS section after the VPs, one row per Director, the size of a VP row.'
    : 'A folded "N directors" line under each VP; open it to see them.';
}

export const DIRECTORS_PROJECTS_HELP = 'The "N directors" fold (and the Org chart\'s) groups them under their project\'s name. Off: the Directors alone, in their order.';

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
