import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getStaleBuild, reloadForUpgrade, subscribeStaleBuild, type StaleBuildState } from '@/utils/stale-assets';
import { openSessionOnHome } from '@/utils/open-session';
import { draftsSettled } from '@/utils/unsaved-work';
import { useInstalledAppUpdate } from '@/components/layout/InstalledAppUpdate';
import { useAppUpdateState } from '@/hooks/useAppUpdate';
import { useAppUpdateActions } from '@/components/layout/useAppUpdateActions';
import { getAppUpdateButtonTooltip, resolveAppUpdateButtonAction, shouldShowAppUpdateItem } from '@/components/layout/app-update-logic';
import { ConfirmDialog } from './ConfirmDialog';
import { gatherUnsavedWork, hasAny, UnsavedWorkDialog, type UnsavedWork } from './UnsavedWorkDialog';

const DISMISS_KEY = 'open-walnut-stale-build-pill-dismissed';

function readDismissed(): string | null {
  try { return window.sessionStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function StaleBuildPill() {
  const [state, setState] = useState<StaleBuildState | null>(getStaleBuild);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  // The work a restart or reload would lose, while the user decides about it.
  const [held, setHeld] = useState<{ work: UnsavedWork; verb: 'restart' | 'reload'; go: () => Promise<void> } | null>(null);
  // From the click until the restart request is out (the check, the draft settle).
  const [starting, setStarting] = useState(false);
  const checking = useRef(false);
  const navigate = useNavigate();
  const installed = useInstalledAppUpdate();
  const shell = useAppUpdateState();
  const shellActions = useAppUpdateActions(shell);
  const installedReady = !!installed.update?.available && !!installed.update.token;
  const shellVisible = shouldShowAppUpdateItem(shell);
  const shellAction = shell ? resolveAppUpdateButtonAction(shell) : 'none';
  const native = installedReady || installed.pending;
  const pending = starting || (native ? installed.pending : shellActions.pending || shell?.status === 'downloading');
  const label = native ? (pending ? 'Restarting…' : 'Restart')
    : shellVisible ? shellAction === 'install' ? (pending ? 'Restarting…' : 'Restart')
      : shell?.status === 'downloading' && shell.downloadPercent != null ? `Downloading ${Math.floor(shell.downloadPercent)}%`
        : pending ? 'Downloading…' : 'Download'
    : 'Reload';
  const identity = native ? `app:${installed.update?.token ?? 'restarting'}`
    : shellVisible ? `release:${shell?.downloadedVersion ?? shell?.availableVersion}` : state?.served;

  useEffect(() => {
    setState(getStaleBuild());
    return subscribeStaleBuild(() => setState(getStaleBuild()));
  }, []);

  // A newer update replaces the one being decided about.
  useEffect(() => { setHeld(null); }, [identity]);

  const onAction = useCallback(async () => {
    if (pending || checking.current) return;
    // Download and check need no guard: nothing closes.
    if (!native && shellVisible && shellAction !== 'install') { void shellActions.run(); return; }
    const verb = native || shellVisible ? 'restart' : 'reload';
    // A restart ends the page process: a draft written by the check gets a moment to reach disk first.
    const go = async (force: boolean, otherWindows: number) => {
      if (verb === 'reload') { reloadForUpgrade(); return; }
      setStarting(true);
      try {
        // Other windows saved their drafts during the check, on their own clocks.
        await draftsSettled(1_500, otherWindows > 0);
        if (native) await installed.restart(force);
        else await shellActions.run({ checked: true, force });
      } finally { setStarting(false); }
    };
    checking.current = true;
    try {
      // Restart and reload go at once, unless something would be lost: a draft
      // already in storage is not (it comes back), so it never holds them.
      const work = await gatherUnsavedWork(verb === 'restart' ? 'app' : 'window',
        (sessionId) => openSessionOnHome(sessionId, navigate), installed.update?.windows);
      if (!hasAny(work)) { await go(work.allChecked, work.otherWindows); return; }
      setHeld({ work, verb, go: () => go(true, work.otherWindows) });
    } finally {
      checking.current = false;
    }
  }, [pending, native, shellVisible, shellAction, shellActions.run, installed.restart, installed.update?.windows, navigate]);
  const onLater = () => {
    if (!identity || pending) return;
    try { window.sessionStorage.setItem(DISMISS_KEY, identity); } catch { /* quota */ }
    setDismissed(identity);
  };
  const visible = !!identity && (pending || dismissed !== identity);
  const error = installed.error ?? shellActions.error;
  const clearError = () => { installed.clearError(); shellActions.clearError(); };

  return <>
    {visible && createPortal(
      <div className="stale-build-pill" role="status" aria-live="polite"
        data-served={state?.served} data-running={state?.running} data-update-kind={native ? 'app' : shellVisible ? 'release' : 'web'}>
        <span className="stale-build-pill-text">{native || shellAction === 'install' ? 'Walnut updated' : shellVisible ? 'Walnut update available' : 'Walnut updated'}</span>
        <span className="stale-build-pill-sep" aria-hidden="true">·</span>
        <button type="button" className="stale-build-pill-action" data-testid="walnut-update-action" data-status={native ? pending ? 'restarting' : 'installed' : shellVisible ? shell?.status : 'stale'} onClick={() => { void onAction(); }} aria-disabled={pending || undefined}
          title={native ? 'Restart to use the installed app update' : shellVisible && shell ? getAppUpdateButtonTooltip(shell) : undefined}>{label}</button>
        <button type="button" className="stale-build-pill-later" onClick={onLater} aria-disabled={pending || undefined}
          title="Later: hide this update notice" aria-label="Later: hide this update notice">×</button>
      </div>, document.body,
    )}
    {held && <UnsavedWorkDialog work={held.work} verb={held.verb} onCancel={() => setHeld(null)}
      onAnyway={() => { const { go } = held; setHeld(null); void go(); }} />}
    {error && <ConfirmDialog title={shellActions.error ? 'Could not update Walnut' : 'Could not restart Walnut'} message={error}
      confirmLabel="Try Again" cancelLabel="Close" onCancel={clearError} onConfirm={() => { clearError(); void onAction(); }} />}
  </>;
}
