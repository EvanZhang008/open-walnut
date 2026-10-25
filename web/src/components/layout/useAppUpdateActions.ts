import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationInput } from '@/contexts/notifications/types';
import { appUpdateBridge, type AppUpdateState } from '@/hooks/useAppUpdate';
import { log } from '@/utils/log';
import { hasUnsavedWork } from '@/utils/stale-assets';
import {
  getAppUpdateActionError, getAppUpdateDownloadedVersion, isAppUpdateButtonDisabled,
  resolveAppUpdateButtonAction, shouldToastAppUpdateActionResult,
} from './app-update-logic';

type Notify = (n: NotificationInput) => void;
let lent: Notify | null = null;

export function useLendAppUpdateToasts(notify: Notify): void {
  useEffect(() => {
    lent = notify;
    return () => { if (lent === notify) lent = null; };
  }, [notify]);
}

function notify(n: NotificationInput): void {
  if (lent) lent(n);
  else log.warn('app-update', 'no toast surface for an update message', { title: n.title });
}

export function useAppUpdateActions(state: AppUpdateState | null) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const toastError = useCallback((title: string, body: string) => {
    if (!lent) setError(body || title);
    else notify({ kind: 'operation-error', severity: 'error', persistent: false, title, body, dedupKey: `app-update:${title}` });
  }, []);

  /** `checked`: the update notice already looked at every window and asked (StaleBuildPill), so the
   *  install goes ahead without the app's own sheet; `force` when the user chose to restart anyway. */
  const run = useCallback(async (opts?: { checked?: boolean; force?: boolean }) => {
    if (!state || inFlight.current || isAppUpdateButtonDisabled(state)) return;
    const action = resolveAppUpdateButtonAction(state);
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      if (action === 'download') {
        const result = await appUpdateBridge.download();
        if (result.completed) {
          const version = getAppUpdateDownloadedVersion(result.state);
          notify({
            kind: 'hint', severity: 'success', persistent: false,
            title: 'Update downloaded',
            body: 'Use Restart in the update notice to install it.',
            dedupKey: `app-update-downloaded:${version ?? ''}`,
            ...(version ? {
              action: { label: 'Read more', kind: 'callback' as const },
              onAction: () => { void appUpdateBridge.openRelease(version); },
            } : {}),
          });
        } else if (shouldToastAppUpdateActionResult(result)) {
          toastError('Could not download update', getAppUpdateActionError(result) ?? '');
        }
      } else if (action === 'install' && opts?.checked) {
        const result = await appUpdateBridge.install(opts.force === true);
        if (shouldToastAppUpdateActionResult(result)) {
          toastError('Could not install update', getAppUpdateActionError(result) ?? '');
        }
      } else if (action === 'install') {
        if (hasUnsavedWork()) {
          toastError('Could not install update', 'Save your edits and send or clear unsent messages before restarting.');
          return;
        }
        const confirmed = await appUpdateBridge.confirmInstall();
        if (!confirmed) return;
        if (hasUnsavedWork()) {
          toastError('Could not install update', 'Save your edits and send or clear unsent messages before restarting.');
          return;
        }
        const result = await appUpdateBridge.install();
        if (shouldToastAppUpdateActionResult(result)) {
          toastError('Could not install update', getAppUpdateActionError(result) ?? '');
        }
      } else {
        const result = await appUpdateBridge.check();
        if (!result.checked) {
          toastError('Could not check for updates',
            result.state.disabledReason ?? result.state.message ?? 'Automatic updates are not available in this build.');
        } else if (result.state.status === 'error' && result.state.message) {
          toastError('Could not check for updates', result.state.message);
        }
      }
    } catch (err) {
      log.warn('app-update', 'update action failed', { action, error: String(err) });
      const title = action === 'install' ? 'Could not install update'
        : action === 'download' ? 'Could not start update download' : 'Could not check for updates';
      toastError(title, err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [state, toastError]);

  return { pending, run, error, clearError: () => setError(null) };
}
