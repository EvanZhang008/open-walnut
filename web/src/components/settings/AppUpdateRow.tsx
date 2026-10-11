/**
 * Settings → General: the Mac app's version and its one update button (T3
 * Code's "app-version" row): Check for Updates, Download, Restart to Update,
 * or what it is doing. Only inside a Walnut.app that updates itself.
 */
import { useAppUpdateState } from '@/hooks/useAppUpdate';
import {
  canCheckForUpdate, getAppUpdateButtonTooltip, isAppUpdateButtonDisabled, resolveAppUpdateButtonAction,
} from '@/components/layout/app-update-logic';
import { useAppUpdateActions } from '@/components/layout/useAppUpdateActions';
import { StableButton } from '@/components/common/HostProblemRows';
import { SettingsRow } from './SettingsSection';

const LABELS = ['Check for Updates', 'Download', 'Restart to Update', 'Checking…', 'Downloading…', 'Up to Date'];

export function AppUpdateRow() {
  const state = useAppUpdateState();
  const { pending, run } = useAppUpdateActions(state);
  if (!state) return null;
  const action = resolveAppUpdateButtonAction(state);
  const label = action === 'download' ? 'Download'
    : action === 'install' ? 'Restart to Update'
      : state.status === 'checking' ? 'Checking…'
        : state.status === 'downloading' ? 'Downloading…'
          : state.status === 'up-to-date' ? 'Up to Date'
            : 'Check for Updates';
  const disabled = pending || (action === 'none' ? !canCheckForUpdate(state) : isAppUpdateButtonDisabled(state));
  const help = !state.enabled
    ? (state.disabledReason ?? 'Updates are off for this copy of the app.')
    : action !== 'none' || state.status === 'downloading'
      ? `${getAppUpdateButtonTooltip(state)}.`.replace(/\.\.$/, '.')
      : 'Current version of the app.';
  return (
    <SettingsRow
      label={`Walnut app ${state.currentVersion}`}
      help={help}
      data-testid="settings-app-update-row"
      control={
        <StableButton label={label} labels={LABELS} onClick={() => { void run(); }} disabled={disabled}
          secondary testId="settings-app-update-btn" ariaLabel={label} />
      }
    />
  );
}
