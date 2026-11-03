/**
 * The org's switches (src/core/org/org-settings.ts), shared by the two places that show them:
 * Settings → Org (OrgSection) and the Org page's settings panel (OrgSettingsMenu). 2026-11-03,
 * the user: "the setting should also be in the org view". Both read and write the same values
 * through useOrgSettings, so a flip in one shows in the other at once, in every window.
 */
import { useState } from 'react';
import { useOrgSettings } from './useOrgSettings';

/** What turning the org off stops, in the words the switch shows. */
export const ORG_OFF_STOPS = [
  'Main and the VPs start no session, and Walnut wakes none of them',
  'Status updates, team notes and Brief refreshes stop going up to them',
  'Their away letters, scheduled reports and the routines aimed at them do not run',
  'Agents cannot reach them with org_send',
] as const;

export const ORG_OFF_STILL = 'You can still type to Main or a VP in its chat. Tasks, their sessions, the Board and the inbox keep working.';

export function orgSwitchFooter(on: boolean): string {
  return on
    ? 'Main and every VP start by themselves in the background and keep their Brief.'
    : 'Turning it on again starts Main and the VPs that never started, and they hear their teams again.';
}

export const BLOCK_OWN_LABEL = 'Refuse their 4th command';
export const BLOCK_OWN_HELP = 'Stop Main or a VP at its 4th command of its own in a turn, instead of only reminding it.';

export function blockOwnFooter(blocks: boolean): string {
  return blocks
    ? 'Main and the VPs are reminded at their 3rd command of their own in a turn, and Walnut refuses the 4th. Sessions that start from now on follow this.'
    : 'Main and the VPs never do the work themselves: at their 3rd command of their own in a turn, Walnut reminds them to hand the rest to their teams. Walnut\'s own ops do not count. A change reaches the sessions that start from now on.';
}

export interface OrgToggle {
  on: boolean; busy: boolean; error: string | undefined; set: (next: boolean) => void;
  /** Forget the last save's error (a panel opened again starts clean). */
  clearError: () => void;
}

/** One of the org's boolean settings: `enabled` (on unless off) or `blockOwnCommands` (off unless on). */
export function useOrgToggle(field: 'enabled' | 'blockOwnCommands'): OrgToggle {
  const { settings, save } = useOrgSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const set = (next: boolean) => {
    // One write at a time: a second answer racing the first could flip the switch back for a moment.
    if (busy) return;
    setBusy(true);
    setError(undefined);
    save({ [field]: next })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const on = field === 'enabled' ? settings.enabled !== false : settings.blockOwnCommands === true;
  return { on, busy, error, set, clearError: () => setError(undefined) };
}

/** The org's on/off switch. */
export const useOrgSwitch = (): OrgToggle => useOrgToggle('enabled');
