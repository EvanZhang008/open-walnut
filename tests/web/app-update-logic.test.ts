/**
 * The Mac app's update item: what it shows and does in each state. These are
 * T3 Code's own cases (apps/web/src/components/desktopUpdate.logic.test.ts),
 * ported one for one so the tested flow carries over; the words are Walnut's.
 * Then the page side of the bridge: the state store hears the shell's events,
 * reads the first state once, and never lets that read undo a newer event.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canCheckForUpdate, getAppUpdateActionError, getAppUpdateButtonTooltip, getAppUpdateRailLabel,
  getArm64IntelBuildWarningDescription, isAppUpdateButtonDisabled, resolveAppUpdateButtonAction,
  shouldShowAppUpdateItem, shouldShowArm64IntelBuildWarning, shouldToastAppUpdateActionResult,
} from '@/components/layout/app-update-logic';
import {
  APP_UPDATE_EVENT, hasAppUpdater, peekAppUpdateState, resetAppUpdateStateForTests, startAppUpdateState, type AppUpdateState,
} from '@/hooks/useAppUpdate';

const baseState: AppUpdateState = {
  enabled: true,
  status: 'idle',
  currentVersion: '1.0.0',
  hostArch: 'x64',
  appArch: 'x64',
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  disabledReason: null,
};

describe('app update button state (T3 desktopUpdate.logic)', () => {
  it('shows a download action when an update is available', () => {
    expect(resolveAppUpdateButtonAction({ ...baseState, status: 'available', availableVersion: '1.1.0' })).toBe('download');
  });

  it('keeps retry action available after a download error', () => {
    const state: AppUpdateState = { ...baseState, status: 'error', availableVersion: '1.1.0', message: 'network timeout', errorContext: 'download', canRetry: true };
    expect(resolveAppUpdateButtonAction(state)).toBe('download');
    expect(getAppUpdateButtonTooltip(state)).toContain('Click to retry');
  });

  it('keeps install action available after an install error', () => {
    const state: AppUpdateState = { ...baseState, status: 'error', downloadedVersion: '1.1.0', availableVersion: '1.1.0', message: 'shutdown timeout', errorContext: 'install', canRetry: true };
    expect(resolveAppUpdateButtonAction(state)).toBe('install');
    expect(getAppUpdateButtonTooltip(state)).toContain('Click to retry');
  });

  it('keeps install action available after a background updater error', () => {
    const state: AppUpdateState = { ...baseState, status: 'error', downloadedVersion: '1.1.0', availableVersion: '1.1.0', message: 'background updater error', errorContext: null, canRetry: true };
    expect(resolveAppUpdateButtonAction(state)).toBe('install');
    expect(getAppUpdateButtonTooltip(state)).toContain('Click to restart and install');
  });

  it('prefers a newly available release over a stale downloaded version', () => {
    expect(resolveAppUpdateButtonAction({ ...baseState, status: 'available', availableVersion: '1.2.0', downloadedVersion: '1.1.0' })).toBe('download');
  });

  it('hides the install action while checking for a newer release', () => {
    expect(resolveAppUpdateButtonAction({ ...baseState, status: 'checking', availableVersion: '1.1.0', downloadedVersion: '1.1.0', downloadPercent: 100 })).toBe('none');
  });

  it('has no action for non-actionable check errors', () => {
    expect(resolveAppUpdateButtonAction({ ...baseState, status: 'error', message: 'network unavailable', errorContext: 'check', canRetry: true })).toBe('none');
  });

  it('disables the button while downloading', () => {
    const state: AppUpdateState = { ...baseState, status: 'downloading', availableVersion: '1.1.0', downloadPercent: 42.5 };
    expect(isAppUpdateButtonDisabled(state)).toBe(true);
    expect(getAppUpdateButtonTooltip(state)).toContain('42%');
  });
});

describe('getAppUpdateActionError', () => {
  it('returns user-visible message for accepted failed attempts', () => {
    expect(getAppUpdateActionError({ accepted: true, completed: false, state: { ...baseState, status: 'available', availableVersion: '1.1.0', message: 'checksum mismatch', errorContext: 'download', canRetry: true } })).toBe('checksum mismatch');
  });

  it('ignores messages for non-accepted attempts', () => {
    expect(getAppUpdateActionError({ accepted: false, completed: false, state: { ...baseState, status: 'error', message: 'background failure', errorContext: 'check' } })).toBeNull();
  });

  it('ignores messages for successful attempts', () => {
    expect(getAppUpdateActionError({ accepted: true, completed: true, state: { ...baseState, status: 'downloaded', downloadedVersion: '1.1.0', availableVersion: '1.1.0', canRetry: true } })).toBeNull();
  });

  it('toasts only for actionable updater errors', () => {
    expect(shouldToastAppUpdateActionResult({ accepted: true, completed: false, state: { ...baseState, message: 'checksum mismatch' } })).toBe(true);
    expect(shouldToastAppUpdateActionResult({ accepted: true, completed: false, state: { ...baseState, message: null } })).toBe(false);
    expect(shouldToastAppUpdateActionResult({ accepted: true, completed: false, state: { ...baseState, message: '   ' } })).toBe(false);
    expect(shouldToastAppUpdateActionResult({ accepted: true, completed: true, state: { ...baseState, message: 'checksum mismatch' } })).toBe(false);
  });
});

describe('app update UI helpers', () => {
  it('shows an Apple silicon warning for Intel builds under Rosetta', () => {
    const state: AppUpdateState = { ...baseState, hostArch: 'arm64', appArch: 'x64', runningUnderArm64Translation: true };
    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain('Apple silicon');
    expect(getArm64IntelBuildWarningDescription(state)).toContain('Intel build');
    expect(shouldShowArm64IntelBuildWarning(baseState)).toBe(false);
  });

  it('changes the warning copy when a native build update is ready to download', () => {
    const state: AppUpdateState = { ...baseState, hostArch: 'arm64', appArch: 'x64', runningUnderArm64Translation: true, status: 'available', availableVersion: '1.1.0' };
    expect(getArm64IntelBuildWarningDescription(state)).toContain('Download the available update');
  });
});

describe('canCheckForUpdate', () => {
  it('returns false for null state', () => { expect(canCheckForUpdate(null)).toBe(false); });
  it('returns false when updates are disabled', () => { expect(canCheckForUpdate({ ...baseState, enabled: false, status: 'disabled' })).toBe(false); });
  it('returns false while checking', () => { expect(canCheckForUpdate({ ...baseState, status: 'checking' })).toBe(false); });
  it('returns false while downloading', () => { expect(canCheckForUpdate({ ...baseState, status: 'downloading', downloadPercent: 50 })).toBe(false); });
  it('returns true once an update has been downloaded so newer releases can be found', () => {
    expect(canCheckForUpdate({ ...baseState, status: 'downloaded', availableVersion: '1.1.0', downloadedVersion: '1.1.0' })).toBe(true);
  });
  it('returns true when idle, up to date, available, or after an error', () => {
    expect(canCheckForUpdate({ ...baseState, status: 'idle' })).toBe(true);
    expect(canCheckForUpdate({ ...baseState, status: 'up-to-date' })).toBe(true);
    expect(canCheckForUpdate({ ...baseState, status: 'available', availableVersion: '1.1.0' })).toBe(true);
    expect(canCheckForUpdate({ ...baseState, status: 'error', errorContext: 'check', message: 'network' })).toBe(true);
  });
});

describe('getAppUpdateButtonTooltip', () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getAppUpdateButtonTooltip({ ...baseState, status: 'idle' })).toBe('Up to date');
    expect(getAppUpdateButtonTooltip({ ...baseState, status: 'up-to-date' })).toBe('Up to date');
  });
});

describe('the rail item (Walnut: shown only with something to do)', () => {
  it('stays out of the rail until there is an update, and in it through the download and install', () => {
    expect(shouldShowAppUpdateItem(null)).toBe(false);
    expect(shouldShowAppUpdateItem({ ...baseState, enabled: false, status: 'disabled' })).toBe(false);
    expect(shouldShowAppUpdateItem({ ...baseState, status: 'idle' })).toBe(false);
    expect(shouldShowAppUpdateItem({ ...baseState, status: 'up-to-date' })).toBe(false);
    expect(shouldShowAppUpdateItem({ ...baseState, status: 'checking' })).toBe(false);
    expect(shouldShowAppUpdateItem({ ...baseState, status: 'error', errorContext: 'check', message: 'offline' })).toBe(false);
    expect(shouldShowAppUpdateItem({ ...baseState, status: 'available', availableVersion: '1.1.0' })).toBe(true);
    expect(shouldShowAppUpdateItem({ ...baseState, status: 'downloading', availableVersion: '1.1.0', downloadPercent: 3 })).toBe(true);
    expect(shouldShowAppUpdateItem({ ...baseState, status: 'downloaded', downloadedVersion: '1.1.0', availableVersion: '1.1.0' })).toBe(true);
  });

  it('names the step it is on', () => {
    expect(getAppUpdateRailLabel({ ...baseState, status: 'available', availableVersion: '1.1.0' })).toBe('Update available');
    expect(getAppUpdateRailLabel({ ...baseState, status: 'downloading', downloadPercent: 42.9 })).toBe('Downloading 42%');
    expect(getAppUpdateRailLabel({ ...baseState, status: 'available', availableVersion: '1.1.0', errorContext: 'download', message: 'x' })).toBe('Retry update');
    expect(getAppUpdateRailLabel({ ...baseState, status: 'downloaded', downloadedVersion: '1.1.0' })).toBe('Restart to update');
  });
});

describe('the page side of the bridge', () => {
  afterEach(() => {
    resetAppUpdateStateForTests();
    vi.unstubAllGlobals();
  });

  function installShell(getState: () => Promise<unknown>) {
    const target = new EventTarget();
    const postMessage = vi.fn((body: { op: string }) => (body.op === 'getState' ? getState() : Promise.resolve({})));
    vi.stubGlobal('window', Object.assign(target, { webkit: { messageHandlers: { walnutUpdate: { postMessage } } } }));
    return { target, postMessage };
  }

  it('finds no updater in a browser tab', () => {
    vi.stubGlobal('window', new EventTarget());
    expect(hasAppUpdater()).toBe(false);
  });

  it('a state event that arrives before the first read wins over that read', async () => {
    let release: (v: unknown) => void = () => {};
    const { target, postMessage } = installShell(() => new Promise((r) => { release = r; }));
    expect(hasAppUpdater()).toBe(true);
    startAppUpdateState();
    expect(postMessage).toHaveBeenCalledWith({ op: 'getState' });
    const newer: AppUpdateState = { ...baseState, status: 'downloading', downloadPercent: 10, availableVersion: '1.1.0' };
    target.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: newer }));
    expect(peekAppUpdateState()?.status).toBe('downloading');
    release({ state: { ...baseState, status: 'idle' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(peekAppUpdateState()?.status).toBe('downloading');
    // Starting twice listens once.
    startAppUpdateState();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('takes the first read when no event came, and every event after it', async () => {
    const { target } = installShell(() => Promise.resolve({ state: { ...baseState, status: 'available', availableVersion: '1.1.0' } }));
    startAppUpdateState();
    await new Promise((r) => setTimeout(r, 0));
    expect(peekAppUpdateState()?.status).toBe('available');
    target.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: { ...baseState, status: 'downloaded', downloadedVersion: '1.1.0' } }));
    expect(peekAppUpdateState()?.status).toBe('downloaded');
    // A malformed event is ignored.
    target.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: null }));
    expect(peekAppUpdateState()?.status).toBe('downloaded');
  });

  it('retries the first read three times, then stays quiet', async () => {
    const { postMessage } = installShell(() => Promise.reject(new Error('not ready')));
    startAppUpdateState();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(postMessage.mock.calls.filter(([b]) => (b as { op: string }).op === 'getState')).toHaveLength(3);
  });
});

describe('the Settings row loads where Settings does', () => {
  // Settings' own tests run without a DOM. The notification provider pulls in the
  // markdown renderer, which cannot load there, so the row reaches toasts through
  // the rail (useLendAppUpdateToasts) instead of importing the provider.
  it('imports without the notification provider', async () => {
    await expect(import('@/components/settings/AppUpdateRow')).resolves.toHaveProperty('AppUpdateRow');
  });
});
