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
 */
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { ORG_OFF_STILL, ORG_OFF_STOPS, orgSwitchFooter, useOrgSwitch } from '../../org/useOrgSwitch';

export { ORG_OFF_STOPS };

export function OrgSection() {
  const org = useOrgSwitch();
  return (
    <SectionCard id="org" title="Org" showSave={false}>
      <SettingsGroup footer={orgSwitchFooter(org.on)}>
        <SettingsRow label="Org" help="Main and the VPs above your projects, and their updates." htmlFor="org-enabled" error={org.error}
          data-testid="org-enabled-row"
          control={<ToggleSwitch id="org-enabled" checked={org.on} busy={org.busy} onChange={org.set} />} />
      </SettingsGroup>
      <SettingsGroup heading={org.on ? 'Turning it off stops' : 'Off now'} data-testid="org-off-stops">
        <ul className="settings-row-help org-off-stops">
          {ORG_OFF_STOPS.map((line) => <li key={line}>{line}.</li>)}
        </ul>
        <p className="settings-row-help">{ORG_OFF_STILL}</p>
      </SettingsGroup>
    </SectionCard>
  );
}
