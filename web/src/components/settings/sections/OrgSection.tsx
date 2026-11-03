/**
 * Settings → Org: the one switch that turns the whole org off (src/core/org/org-enabled.ts),
 * on by default. 2026-11-03, the user: "people can have setting to disable that that will disable
 * all the communications or the org, but default enable".
 *
 * Saved through the org's own settings route (PUT /api/v1/org/settings), as the org's name is, so
 * every window reads it from one place (useOrgSettings) and the Org page follows at once.
 */
import { useState } from 'react';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOrgSettings } from '../../org/useOrgSettings';

/** What turning the org off stops, in the words the switch shows. */
export const ORG_OFF_STOPS = [
  'Main and the VPs start no session, and Walnut wakes none of them',
  'Status updates, team notes and Brief refreshes stop going up to them',
  'Their away letters, scheduled reports and the routines aimed at them do not run',
  'Agents cannot reach them with org_send',
] as const;

export function OrgSection() {
  const { settings, save } = useOrgSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const on = settings.enabled !== false;
  const set = (next: boolean) => {
    setBusy(true);
    setError(undefined);
    save({ enabled: next })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return (
    <SectionCard id="org" title="Org" showSave={false}>
      <SettingsGroup
        footer={on
          ? 'Main and every VP start by themselves in the background and keep their Brief.'
          : 'Turning it on again starts Main and the VPs that never started, and they hear their teams again.'}
      >
        <SettingsRow label="Org" help="Main and the VPs above your projects, and their updates." htmlFor="org-enabled" error={error}
          data-testid="org-enabled-row"
          control={<ToggleSwitch id="org-enabled" checked={on} busy={busy} onChange={set} />} />
      </SettingsGroup>
      <SettingsGroup heading={on ? 'Turning it off stops' : 'Off now'} data-testid="org-off-stops">
        <ul className="settings-row-help org-off-stops">
          {ORG_OFF_STOPS.map((line) => <li key={line}>{line}.</li>)}
        </ul>
        <p className="settings-row-help">You can still type to Main or a VP in its chat. Tasks, their sessions, the Board and the inbox keep working.</p>
      </SettingsGroup>
    </SectionCard>
  );
}
