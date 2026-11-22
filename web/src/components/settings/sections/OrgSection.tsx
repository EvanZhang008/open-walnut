/**
 * Settings → Org: the one switch that turns the whole org off (src/core/org/org-enabled.ts),
 * on by default. 2026-11-03, the user: "people can have setting to disable that that will disable
 * all the communications or the org, but default enable".
 *
 * There is no switch to refuse Main's or a VP's own commands: Walnut only reminds them (2026-11-04,
 * the user, of such a switch: "remove this shodln;'t do this at all"; providers/org-work-guard-hook.ts).
 *
 * Saved through the org's own settings route (PUT /api/v1/org/settings), as the org's name is, so
 * every window reads it from one place (useOrgSettings) and the Org page follows at once. The Org
 * page shows the same switch in its own settings panel (OrgSettingsMenu, useOrgSwitch.ts).
 *
 * While the Directors experiment is on, a Directors group picks how the Org page lists them (its
 * layout, and whether the fold names their projects: useDirectorSettings.ts), the gear shows it too.
 */
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { DIRECTORS_LAYOUT_LABEL, DIRECTORS_LAYOUT_OPTIONS, DIRECTORS_PROJECTS_HELP, DIRECTORS_PROJECTS_LABEL, directorsLayoutHelp, useDirectorSettings } from '../../org/useDirectorSettings';
import { ORG_OFF_STILL, ORG_OFF_STOPS, orgSwitchFooter, useOrgSwitch } from '../../org/useOrgSwitch';

export { ORG_OFF_STOPS };

export function OrgSection() {
  const org = useOrgSwitch();
  const dir = useDirectorSettings();
  return (
    <SectionCard id="org" title="Org" showSave={false}>
      <SettingsGroup footer={orgSwitchFooter(org.on)}>
        <SettingsRow label="Org" help="CEO and the VPs above your projects, and their updates." htmlFor="org-enabled" error={org.error}
          data-testid="org-enabled-row"
          control={<ToggleSwitch id="org-enabled" checked={org.on} busy={org.busy} onChange={org.set} />} />
      </SettingsGroup>
      <SettingsGroup heading={org.on ? 'Turning it off stops' : 'Off now'} data-testid="org-off-stops">
        <ul className="settings-row-help org-off-stops">
          {ORG_OFF_STOPS.map((line) => <li key={line}>{line}.</li>)}
        </ul>
        <p className="settings-row-help">{ORG_OFF_STILL}</p>
      </SettingsGroup>
      {dir.on && (
        <SettingsGroup heading="Directors" data-testid="org-directors-settings">
          <SettingsRow label={DIRECTORS_LAYOUT_LABEL} help={directorsLayoutHelp(dir.layout)} error={dir.error} data-testid="org-directors-layout-row"
            control={<SegmentedControl aria-label="Directors layout" value={dir.layout} options={DIRECTORS_LAYOUT_OPTIONS} disabled={dir.busy} onChange={dir.setLayout} />} />
          <SettingsRow label={DIRECTORS_PROJECTS_LABEL} help={DIRECTORS_PROJECTS_HELP} htmlFor="org-directors-projects" data-testid="org-directors-projects-row"
            control={<ToggleSwitch id="org-directors-projects" checked={dir.showProjects} busy={dir.busy} onChange={dir.setShowProjects} />} />
        </SettingsGroup>
      )}
    </SectionCard>
  );
}
