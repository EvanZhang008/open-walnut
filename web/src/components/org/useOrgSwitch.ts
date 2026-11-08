/**
 * The org's switch (src/core/org/org-settings.ts), shared by the two places that show it:
 * Settings → Org (OrgSection) and the Org page's settings panel (OrgSettingsMenu). 2026-11-03,
 * the user: "the setting should also be in the org view". Both read and write the same values
 * through useOrgSettings, so a flip in one shows in the other at once, in every window.
 */
import { useState } from 'react';
import { useOrgSettings } from './useOrgSettings';

/** What turning the org off stops, in the words the switch shows. */
export const ORG_OFF_STOPS = [
  'CEO and the VPs start no session, and Walnut wakes none of them',
  'Status updates, team notes and Brief refreshes stop going up to them',
  'Their away letters, scheduled reports and the routines aimed at them do not run',
  'Agents cannot reach them with org_send',
] as const;

export const ORG_OFF_STILL = 'You can still type to CEO or a VP in its chat. Tasks, their sessions, the Board and the inbox keep working.';

export function orgSwitchFooter(on: boolean): string {
  return on
    ? 'CEO and every VP start by themselves in the background and keep their Brief.'
    : 'Turning it on again starts CEO and the VPs that never started, and they hear their teams again.';
}

export interface OrgToggle {
  on: boolean; busy: boolean; error: string | undefined; set: (next: boolean) => void;
  /** Forget the last save's error (a panel opened again starts clean). */
  clearError: () => void;
}

/** The org's on/off switch: on unless the user turned it off. */
export function useOrgSwitch(): OrgToggle {
  const { settings, save } = useOrgSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const set = (next: boolean) => {
    // One write at a time: a second answer racing the first could flip the switch back for a moment.
    if (busy) return;
    setBusy(true);
    setError(undefined);
    save({ enabled: next })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const on = settings.enabled !== false;
  return { on, busy, error, set, clearError: () => setError(undefined) };
}
