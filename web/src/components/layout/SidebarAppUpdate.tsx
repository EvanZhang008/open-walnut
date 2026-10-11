/**
 * The Mac app's update item in the rail, above Voice: T3 Code's sidebar update
 * pill (SidebarUpdatePill.tsx) in Walnut's rail. It shows only when there is
 * something to do (an update to download, a download running, one ready to
 * install), so the rail stays as it is the rest of the time; "Check for
 * Updates…" lives in the app menu and in Settings → General.
 *
 * One click per step, the same as T3: download (a ring fills as it comes in),
 * then "Restart to update", which asks the app's own confirmation sheet first.
 * The click answers at once (the item shows it is working) and the state
 * arrives from the app shell, which owns the update (desktop/AppUpdater.swift).
 */
import { useAppUpdateState, type AppUpdateState } from '@/hooks/useAppUpdate';
import {
  getAppUpdateButtonTooltip, getAppUpdateRailLabel, getArm64IntelBuildWarningDescription,
  isAppUpdateButtonDisabled, resolveAppUpdateButtonAction, shouldShowAppUpdateItem, shouldShowArm64IntelBuildWarning,
} from './app-update-logic';
import { useNotifications } from '@/contexts/notifications';
import { useAppUpdateActions, useLendAppUpdateToasts } from './useAppUpdateActions';
import '@/styles/sidebar-app-update.css';

const R = 9.4;
const CIRCUMFERENCE = 2 * Math.PI * R;

function UpdateIcon({ state }: { state: AppUpdateState }) {
  const action = resolveAppUpdateButtonAction(state);
  if (state.status === 'downloading') {
    const pct = Math.min(100, Math.max(0, state.downloadPercent ?? 0));
    return (
      <svg className="app-update-icon" viewBox="0 0 22 22" aria-hidden="true" data-icon="downloading">
        <circle className="app-update-ring-track" cx="11" cy="11" r={R} />
        <circle
          className="app-update-ring-arc" cx="11" cy="11" r={R}
          strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - Math.max(0.001, pct / 100))}
          transform="rotate(-90 11 11)"
        />
        <path className="app-update-glyph" d="M11 7v6.2M8.4 10.8 11 13.4l2.6-2.6" />
      </svg>
    );
  }
  if (action === 'install') {
    return (
      <svg className="app-update-icon" viewBox="0 0 22 22" aria-hidden="true" data-icon="downloaded">
        <path className="app-update-glyph" d="M17 11a6 6 0 1 1-1.76-4.24M17 4.8v3.6h-3.6" />
        <circle className="app-update-badge" cx="16.6" cy="16.6" r="3.6" />
        <path className="app-update-badge-check" d="m14.9 16.7 1.2 1.2 2.2-2.3" />
      </svg>
    );
  }
  return (
    <svg className="app-update-icon" viewBox="0 0 22 22" aria-hidden="true" data-icon="available">
      <path className="app-update-glyph" d="M11 4.5v9M7.4 10.2 11 13.8l3.6-3.6M5 17.5h12" />
      <circle className="app-update-dot" cx="17.4" cy="4.6" r="2.2" />
    </svg>
  );
}

export function SidebarAppUpdate() {
  const state = useAppUpdateState();
  useLendAppUpdateToasts(useNotifications().notify);
  const { pending, run } = useAppUpdateActions(state);

  if (!state || !shouldShowAppUpdateItem(state)) return null;
  const tooltip = shouldShowArm64IntelBuildWarning(state)
    ? `${getAppUpdateButtonTooltip(state)} ${getArm64IntelBuildWarningDescription(state)}`
    : getAppUpdateButtonTooltip(state);
  const disabled = pending || isAppUpdateButtonDisabled(state);
  return (
    <button
      type="button"
      className={`sidebar-link sidebar-app-update${pending ? ' is-pending' : ''}`}
      data-status={state.status}
      data-testid="sidebar-app-update"
      onClick={() => { void run(); }}
      title={tooltip}
      aria-label={tooltip}
      aria-disabled={disabled || undefined}
    >
      <UpdateIcon state={state} />
      <span className="sidebar-label">{getAppUpdateRailLabel(state)}</span>
    </button>
  );
}
