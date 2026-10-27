import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getStaleBuild, reloadForUpgrade, subscribeStaleBuild, type StaleBuildState } from '@/utils/stale-assets';
import { openSessionOnHome } from '@/utils/open-session';
import { draftsSettled, setUnsavedWorkHomeOpener } from '@/utils/unsaved-work';
import { useInstalledAppUpdate } from '@/components/layout/InstalledAppUpdate';
import { useAppUpdateState } from '@/hooks/useAppUpdate';
import { useAppUpdateActions } from '@/components/layout/useAppUpdateActions';
import { getAppUpdateButtonTooltip, resolveAppUpdateButtonAction, shouldShowAppUpdateItem } from '@/components/layout/app-update-logic';
import { ConfirmDialog } from './ConfirmDialog';
import { useUpdateNoticeDock } from './update-notice-dock';
import { isSnoozed, readSnooze, SNOOZE_KEY, writeSnooze, type UpdateSnooze } from './update-notice-snooze';
import { gatherUnsavedWork, hasAny, UnsavedWorkDialog, type UnsavedWork } from './UnsavedWorkDialog';

function RefreshIcon() {
  return (
    <svg className="stale-build-pill-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75" />
      <path d="M13.3 2.6v2.9h-2.9" />
    </svg>
  );
}

export function StaleBuildPill() {
  const [state, setState] = useState<StaleBuildState | null>(getStaleBuild);
  const [snooze, setSnooze] = useState<UpdateSnooze | null>(readSnooze);
  // Bumped when the snooze runs out, so the notice can come back on its own.
  const [, setWoke] = useState(0);
  const dock = useUpdateNoticeDock();
  // The work a restart or reload would lose, while the user decides about it.
  const [held, setHeld] = useState<{ work: UnsavedWork; verb: 'restart' | 'reload'; go: () => Promise<void> } | null>(null);
  // From the click until the restart request is out (the check, the draft settle).
  const [starting, setStarting] = useState(false);
  const checking = useRef(false);
  const navigate = useNavigate();
  const openHome = useCallback((sessionId?: string) => {
    if (sessionId) openSessionOnHome(sessionId, navigate); else navigate('/');
  }, [navigate]);
  // "Go there" asked by another window (the Mac app's other-window rows) reaches this router too.
  useEffect(() => { setUnsavedWorkHomeOpener(openHome); return () => setUnsavedWorkHomeOpener(undefined); }, [openHome]);
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
  // The collapsed rail is 56px wide: the verb in a word that fits (CSS shows it from data-short).
  const shortLabel = label.match(/\d+%/)?.[0] ?? (pending ? '…' : label === 'Download' ? 'Update' : label);
  const identity = native ? `app:${installed.update?.token ?? 'restarting'}`
    // Download and Restart of one release are two asks: a × on the first must not hide the second.
    : shellVisible ? `release:${shell?.downloadedVersion ?? shell?.availableVersion}:${shellAction === 'install' ? 'install' : 'download'}` : state?.served;

  useEffect(() => {
    setState(getStaleBuild());
    return subscribeStaleBuild(() => setState(getStaleBuild()));
  }, []);

  // A × in another window or tab hides this one too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === SNOOZE_KEY) setSnooze(readSnooze()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    const wait = snooze ? snooze.until - Date.now() : 0;
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWoke((n) => n + 1), Math.min(wait + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [snooze]);

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
      const work = await gatherUnsavedWork(verb === 'restart' ? 'app' : 'window', openHome, installed.update?.windows);
      if (!hasAny(work)) { await go(work.allChecked, work.otherWindows); return; }
      setHeld({ work, verb, go: () => go(true, work.otherWindows) });
    } finally {
      checking.current = false;
    }
  }, [pending, native, shellVisible, shellAction, shellActions.run, installed.restart, installed.update?.windows, openHome]);
  const onLater = () => {
    if (!identity || pending) return;
    setSnooze(writeSnooze(identity));
  };
  const visible = !!identity && (pending || !isSnoozed(snooze, identity, Date.now()));
  const docked = !!dock;
  const heading = shellVisible && !native && shellAction !== 'install' ? 'Walnut update available' : 'Walnut updated';
  const error = installed.error ?? shellActions.error;
  const clearError = () => { installed.clearError(); shellActions.clearError(); };

  return <>
    {visible && createPortal(
      <div className={`stale-build-pill${docked ? ' is-docked' : ''}`} role="status" aria-live="polite"
        data-served={state?.served} data-running={state?.running} data-update-kind={native ? 'app' : shellVisible ? 'release' : 'web'}>
        <span className="stale-build-pill-text">{heading}</span>
        <span className="stale-build-pill-sep" aria-hidden="true">·</span>
        <button type="button" className="stale-build-pill-action" data-testid="walnut-update-action" data-status={native ? pending ? 'restarting' : 'installed' : shellVisible ? shell?.status : 'stale'} onClick={() => { void onAction(); }} aria-disabled={pending || undefined} data-short={shortLabel}
          title={native ? 'Restart to use the installed app update' : shellVisible && shell ? getAppUpdateButtonTooltip(shell) : `${heading}: reload this window to use it`}>
          <RefreshIcon /><span className="stale-build-pill-label">{label}</span>
        </button>
        <button type="button" className="stale-build-pill-later" onClick={onLater} aria-disabled={pending || undefined}
          title="Later: hide this update notice for 30 minutes" aria-label="Later: hide this update notice for 30 minutes">×</button>
      </div>, docked ? dock : document.body,
    )}
    {held && <UnsavedWorkDialog work={held.work} verb={held.verb} onCancel={() => setHeld(null)}
      onAnyway={() => { const { go } = held; setHeld(null); void go(); }} />}
    {error && <ConfirmDialog title={shellActions.error ? 'Could not update Walnut' : 'Could not restart Walnut'} message={error}
      confirmLabel="Try Again" cancelLabel="Close" onCancel={clearError} onConfirm={() => { clearError(); void onAction(); }} />}
  </>;
}
