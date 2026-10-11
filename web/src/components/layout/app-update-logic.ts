/**
 * What the Mac app's update item shows and does in each state: a port of T3
 * Code's desktopUpdate.logic.ts (apps/web/src/components), kept function for
 * function so the tested behavior carries over. The words are Walnut's.
 */
import type { AppUpdateActionResult, AppUpdateState } from '@/hooks/useAppUpdate';

export type AppUpdateButtonAction = 'download' | 'install' | 'none';

/**
 * The shell fills `downloadedVersion` when the download is verified; a reply can
 * race that write, so fall back to the version the download was started for.
 */
export function getAppUpdateDownloadedVersion(state: AppUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function resolveAppUpdateButtonAction(state: AppUpdateState): AppUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === 'downloaded' ||
      (state.status === 'error' && (state.errorContext === null || state.errorContext === 'install')))
  ) {
    return 'install';
  }
  if (state.status === 'available') return 'download';
  if (state.status === 'error' && state.errorContext === 'download' && state.availableVersion) return 'download';
  return 'none';
}

export function shouldShowArm64IntelBuildWarning(state: AppUpdateState | null): boolean {
  return state?.hostArch === 'arm64' && state.appArch === 'x64';
}

export function isAppUpdateButtonDisabled(state: AppUpdateState | null): boolean {
  return state?.status === 'downloading';
}

export function getArm64IntelBuildWarningDescription(state: AppUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) return 'This install is using the correct architecture.';
  const action = resolveAppUpdateButtonAction(state);
  const lead = 'This Mac has Apple silicon, but Walnut is still running the Intel build under Rosetta.';
  if (action === 'download') return `${lead} Download the available update to switch to the Apple silicon build.`;
  if (action === 'install') return `${lead} Restart to install the downloaded Apple silicon build.`;
  return `${lead} The next update replaces it with the Apple silicon build.`;
}

export function getAppUpdateButtonTooltip(state: AppUpdateState): string {
  if (state.status === 'available') return `Update ${state.availableVersion ?? 'available'} ready to download`;
  if (state.status === 'downloading') {
    const progress = typeof state.downloadPercent === 'number' ? ` (${Math.floor(state.downloadPercent)}%)` : '';
    return `Downloading update${progress}`;
  }
  if (state.status === 'downloaded') {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? 'ready'} downloaded. Click to restart and install.`;
  }
  if (state.status === 'error') {
    if (state.errorContext === 'download' && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === 'install' && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
    return state.message ?? 'Update failed';
  }
  return 'Up to date';
}

/** The rail item's one-word line (the expanded rail shows it beside the icon). */
export function getAppUpdateRailLabel(state: AppUpdateState): string {
  const action = resolveAppUpdateButtonAction(state);
  if (action === 'install') return 'Restart to update';
  if (state.status === 'downloading') {
    return typeof state.downloadPercent === 'number' ? `Downloading ${Math.floor(state.downloadPercent)}%` : 'Downloading';
  }
  if (action === 'download') return state.errorContext === 'download' ? 'Retry update' : 'Update available';
  return 'Up to date';
}

export function getAppUpdateActionError(result: AppUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== 'string') return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastAppUpdateActionResult(result: AppUpdateActionResult): boolean {
  return getAppUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: AppUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return state.status !== 'checking' && state.status !== 'downloading' && state.status !== 'disabled';
}

/** T3 shows the update control once there is something to do or a download running. */
export function shouldShowAppUpdateItem(state: AppUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return resolveAppUpdateButtonAction(state) !== 'none' || state.status === 'downloading';
}
