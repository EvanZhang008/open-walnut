import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getStaleBuild, hasUnsavedWork, reloadForUpgrade, subscribeStaleBuild, type StaleBuildState } from '@/utils/stale-assets';
import { useInstalledAppUpdate } from '@/components/layout/InstalledAppUpdate';
import { useAppUpdateState } from '@/hooks/useAppUpdate';
import { useAppUpdateActions } from '@/components/layout/useAppUpdateActions';
import { getAppUpdateButtonTooltip, resolveAppUpdateButtonAction, shouldShowAppUpdateItem } from '@/components/layout/app-update-logic';
import { ConfirmDialog } from './ConfirmDialog';

const DISMISS_KEY = 'open-walnut-stale-build-pill-dismissed';
const CONFIRM_MS = 8_000;

function readDismissed(): string | null {
  try { return window.sessionStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function StaleBuildPill() {
  const [state, setState] = useState<StaleBuildState | null>(getStaleBuild);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [confirming, setConfirming] = useState(false);
  const [restartConfirming, setRestartConfirming] = useState(false);
  const [guardError, setGuardError] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const installed = useInstalledAppUpdate();
  const shell = useAppUpdateState();
  const shellActions = useAppUpdateActions(shell);
  const installedReady = !!installed.update?.available && !!installed.update.token;
  const shellVisible = shouldShowAppUpdateItem(shell);
  const shellAction = shell ? resolveAppUpdateButtonAction(shell) : 'none';
  const native = installedReady || installed.pending;
  const pending = native ? installed.pending : shellActions.pending || shell?.status === 'downloading';
  const label = native ? (pending ? 'Restarting…' : 'Restart')
    : shellVisible ? shellAction === 'install' ? (pending ? 'Restarting…' : 'Restart')
      : shell?.status === 'downloading' && shell.downloadPercent != null ? `Downloading ${Math.floor(shell.downloadPercent)}%`
        : pending ? 'Downloading…' : 'Download'
    : confirming ? 'Reload anyway' : 'Reload';
  const identity = native ? `app:${installed.update?.token ?? 'restarting'}`
    : shellVisible ? `release:${shell?.downloadedVersion ?? shell?.availableVersion}` : state?.served;

  useEffect(() => {
    setState(getStaleBuild());
    return subscribeStaleBuild(() => setState(getStaleBuild()));
  }, []);

  useEffect(() => {
    setConfirming(false);
    setRestartConfirming(false);
    if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
    return () => { if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current); };
  }, [identity]);

  const onAction = useCallback(() => {
    if (pending) return;
    if (native) { setRestartConfirming(true); return; }
    if (shellVisible) {
      if (shellAction === 'install' && hasUnsavedWork()) {
        setGuardError('Save your edits and send or clear unsent messages before restarting.');
        return;
      }
      void shellActions.run();
      return;
    }
    if (!confirming && hasUnsavedWork()) {
      setConfirming(true);
      confirmTimer.current = window.setTimeout(() => {
        confirmTimer.current = null;
        setConfirming(false);
      }, CONFIRM_MS);
      return;
    }
    reloadForUpgrade();
  }, [pending, native, shellVisible, shellAction, shellActions.run, confirming]);

  const restart = () => {
    setRestartConfirming(false);
    if (hasUnsavedWork()) {
      setGuardError('Save your edits and send or clear unsent messages before restarting.');
      return;
    }
    void installed.restart();
  };
  const onLater = () => {
    if (!identity || pending) return;
    try { window.sessionStorage.setItem(DISMISS_KEY, identity); } catch { /* quota */ }
    setDismissed(identity);
  };
  const visible = !!identity && (pending || dismissed !== identity);
  const error = guardError ?? installed.error ?? shellActions.error;
  const clearError = () => { setGuardError(null); installed.clearError(); shellActions.clearError(); };

  return <>
    {visible && createPortal(
      <div className={`stale-build-pill${confirming ? ' is-confirming' : ''}`} role="status" aria-live="polite"
        data-served={state?.served} data-running={state?.running} data-update-kind={native ? 'app' : shellVisible ? 'release' : 'web'}>
        <span className="stale-build-pill-text">{confirming ? 'You have unsaved text: reload anyway?' : native || shellAction === 'install' ? 'Walnut updated' : shellVisible ? 'Walnut update available' : 'Walnut updated'}</span>
        <span className="stale-build-pill-sep" aria-hidden="true">·</span>
        <button type="button" className="stale-build-pill-action" data-testid="walnut-update-action" data-status={native ? pending ? 'restarting' : 'installed' : shellVisible ? shell?.status : 'stale'} onClick={onAction} aria-disabled={pending || undefined}
          title={native ? 'Restart to use the installed app update' : shellVisible && shell ? getAppUpdateButtonTooltip(shell) : undefined}>{label}</button>
        <button type="button" className="stale-build-pill-later" onClick={onLater} aria-disabled={pending || undefined}
          title="Later: hide this update notice" aria-label="Later: hide this update notice">×</button>
      </div>, document.body,
    )}
    {restartConfirming && <ConfirmDialog title="Restart to use the installed update?"
      message="Walnut will close and reopen with the new app. Running sessions keep going. Save edits and send or clear unsent messages first."
      confirmLabel="Restart Now" cancelLabel="Not Now" onCancel={() => setRestartConfirming(false)} onConfirm={restart} />}
    {error && <ConfirmDialog title={shellActions.error ? 'Could not update Walnut' : 'Could not restart Walnut'} message={error} confirmLabel="OK"
      onCancel={clearError} onConfirm={clearError} />}
  </>;
}
