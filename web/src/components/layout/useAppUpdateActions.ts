/**
 * The clicks of the Mac app's update (T3 Code's SidebarUpdateControl handler),
 * shared by the rail item and the Settings row so both say the same things:
 * download, then a toast once it is in; install after the app's confirmation;
 * a check that could not run says why. Errors are toasts, never banners.
 *
 * The toasts come from the rail item, which is mounted wherever the app is and
 * lends its `notify` here (useLendAppUpdateToasts). The Settings row then shows
 * the same toasts without importing the notification provider, which pulls the
 * markdown renderer into Settings and breaks its DOM-free tests.
 */
import { useCallback, useEffect, useState } from 'react';
import type { NotificationInput } from '@/contexts/notifications/types';
import { appUpdateBridge, type AppUpdateState } from '@/hooks/useAppUpdate';
import { log } from '@/utils/log';
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

  const toastError = useCallback((title: string, body: string) => {
    notify({ kind: 'operation-error', severity: 'error', persistent: false, title, body, dedupKey: `app-update:${title}` });
  }, []);

  const run = useCallback(async () => {
    if (!state || pending || isAppUpdateButtonDisabled(state)) return;
    const action = resolveAppUpdateButtonAction(state);
    setPending(true);
    try {
      if (action === 'download') {
        const result = await appUpdateBridge.download();
        if (result.completed) {
          const version = getAppUpdateDownloadedVersion(result.state);
          notify({
            kind: 'hint', severity: 'success', persistent: false,
            title: 'Update downloaded',
            body: 'Restart from the update button in the sidebar to install it.',
            dedupKey: `app-update-downloaded:${version ?? ''}`,
            ...(version ? {
              action: { label: 'Read more', kind: 'callback' as const },
              onAction: () => { void appUpdateBridge.openRelease(version); },
            } : {}),
          });
        } else if (shouldToastAppUpdateActionResult(result)) {
          toastError('Could not download update', getAppUpdateActionError(result) ?? '');
        }
      } else if (action === 'install') {
        const confirmed = await appUpdateBridge.confirmInstall();
        if (!confirmed) return;
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
      setPending(false);
    }
  }, [state, pending, toastError]);

  return { pending, run };
}
