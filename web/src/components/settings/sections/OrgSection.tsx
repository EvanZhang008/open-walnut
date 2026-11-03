/**
 * Settings → Org: the one switch that turns the whole org off (src/core/org/org-enabled.ts),
 * on by default. 2026-11-03, the user: "people can have setting to disable that that will disable
 * all the communications or the org, but default enable".
 *
 * Below it, "Refuse their 4th command" (config `org.block_own_commands`, off by default): by default
 * Walnut only reminds Main or a VP at its 3rd command of its own in a turn (2026-11-03, the user:
 * "walnut probally shoudo't stoop it, it shudo use prompt"); on, it refuses the 4th as well.
 *
 * Saved through the org's own settings route (PUT /api/v1/org/settings), as the org's name is, so
 * every window reads it from one place (useOrgSettings) and the Org page follows at once. The Org
 * page shows the same switches in its own settings panel (OrgSettingsMenu, useOrgSwitch.ts).
 */
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import {
  BLOCK_OWN_HELP, BLOCK_OWN_LABEL, ORG_OFF_STILL, ORG_OFF_STOPS, blockOwnFooter, orgSwitchFooter, useOrgSwitch, useOrgToggle,
} from '../../org/useOrgSwitch';

export { ORG_OFF_STOPS };

export function OrgSection() {
  const org = useOrgSwitch();
  const block = useOrgToggle('blockOwnCommands');
  return (
    <SectionCard id="org" title="Org" showSave={false}>
      <SettingsGroup footer={orgSwitchFooter(org.on)}>
        <SettingsRow label="Org" help="Main and the VPs above your projects, and their updates." htmlFor="org-enabled" error={org.error}
          data-testid="org-enabled-row"
          control={<ToggleSwitch id="org-enabled" checked={org.on} busy={org.busy} onChange={org.set} />} />
      </SettingsGroup>
      <SettingsGroup heading="Their own commands" footer={blockOwnFooter(block.on)}>
        <SettingsRow label={BLOCK_OWN_LABEL} help={BLOCK_OWN_HELP} htmlFor="org-block-own-commands"
          error={block.error} data-testid="org-block-own-commands-row"
          control={<ToggleSwitch id="org-block-own-commands" checked={block.on} busy={block.busy} onChange={block.set} />} />
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
