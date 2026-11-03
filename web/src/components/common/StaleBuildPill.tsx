import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { setUpdateNoticeOccupied, useUpdateNoticeDock } from './update-notice-dock';
import { isSnoozed, readSnooze, SNOOZE_KEY, writeSnooze, type UpdateSnooze } from './update-notice-snooze';
import { gatherUnsavedWork, hasAny, UnsavedWorkDialog, type UnsavedWork } from './UnsavedWorkDialog';
import { installUpdateNow, restartIntoUpdate, UpdateActionError } from '@/api/update';
import { applyUpdateStatus, useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useAppAutoUpdate } from '@/components/layout/useAppAutoUpdate';
import { HowToUpdateDialog, type UpdateCommand } from './HowToUpdateDialog';
import { displayVersion, howToUpdateCommands, readSeenVersion, serverPillView, updatedNotice, WORKING_SHORT, writeSeenVersion } from './server-update-pill';
import { log } from '@/utils/log';

/** "Walnut updated to X" goes by itself once this window has been looked at this long. */
const UPDATED_NOTICE_MS = 2 * 60_000;

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
  const update = useUpdateStatus(true);
  useAppAutoUpdate(shell, update.status?.live, shellActions.run, openHome);
  // The server's own update, unless the Mac app shell owns updates here.
  const server = shell?.enabled ? null : serverPillView(update.status);
  const [serverError, setServerError] = useState<{ verb: 'update' | 'restart'; message: string } | null>(null);
  const [howTo, setHowTo] = useState<UpdateCommand[] | null>(null);
  // The version this tab last saw: a different one after a restart is announced once.
  const [seen, setSeen] = useState<string | null>(readSeenVersion);
  const current = update.status?.current ?? null;
  useEffect(() => { if (current && !seen) { writeSeenVersion(current); setSeen(current); } }, [current, seen]);
  const updatedTo = updatedNotice(seen, current);
  const markSeen = useCallback(() => { if (current) { writeSeenVersion(current); setSeen(current); } }, [current]);
  const installedReady = !!installed.update?.available && !!installed.update.token;
  const shellVisible = shouldShowAppUpdateItem(shell);
  const shellAction = shell ? resolveAppUpdateButtonAction(shell) : 'none';
  const native = installedReady || installed.pending;
  const kind = native ? 'app' : shellVisible ? 'release' : server ? 'server' : state ? 'web' : updatedTo ? 'updated' : null;
  const pending = starting || (kind === 'app' ? installed.pending : kind === 'release' ? shellActions.pending || shell?.status === 'downloading'
    : kind === 'server' ? server!.busy : false);
  const label = kind === 'app' ? (pending ? 'Restarting…' : 'Restart')
    : kind === 'release' ? shellAction === 'install' ? (pending ? 'Restarting…' : 'Restart')
      : shell?.status === 'downloading' && shell.downloadPercent != null ? `Downloading ${Math.floor(shell.downloadPercent)}%`
        : pending ? 'Downloading…' : 'Download'
    : kind === 'server' ? (starting ? (server!.action === 'restart' ? 'Restarting…' : 'Updating…') : server!.label)
    : kind === 'updated' ? 'Updated' : 'Reload';
  // The collapsed rail is 56px wide: the verb in a word that fits (CSS shows it from data-short).
  const shortLabel = kind === 'server' ? (starting ? WORKING_SHORT : server!.short)
    : label.match(/\d+%/)?.[0] ?? (pending ? '…' : label === 'Download' ? 'Update' : label);
  const identity = kind === 'app' ? `app:${installed.update?.token ?? 'restarting'}`
    // Download and Restart of one release are two asks: a × on the first must not hide the second.
    : kind === 'release' ? `release:${shell?.downloadedVersion ?? shell?.availableVersion}:${shellAction === 'install' ? 'install' : 'download'}`
    : kind === 'server' ? server!.identity : kind === 'web' ? state?.served : kind === 'updated' ? `updated:${updatedTo}` : undefined;
  // The server's step with nothing to click (installing, restarting, an announcement).
  const noAction = (kind === 'server' && !server!.action) || kind === 'updated';
  // The server is installing or restarting (or the click is on its way): the icon spins.
  const working = kind === 'server' && (starting || server!.working);

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

  const serverAct = useCallback(async () => {
    if (!server?.action) return;
    if (server.action === 'how') { setHowTo(howToUpdateCommands(update.status)); return; }
    const verb = server.action === 'restart' ? 'restart' : 'update';
    setStarting(true);
    try {
      applyUpdateStatus(await (verb === 'restart' ? restartIntoUpdate() : installUpdateNow()));
    } catch (err) {
      log.warn('update', 'server update action refused', { verb, error: String(err), code: err instanceof UpdateActionError ? err.code : null });
      if (err instanceof UpdateActionError && err.status) applyUpdateStatus(err.status);
      if (err instanceof UpdateActionError && err.code === 'cannot_install') {
        setHowTo(err.fix ? [{ note: null, command: err.fix }] : howToUpdateCommands(update.status));
      } else {
        setServerError({ verb, message: err instanceof Error ? err.message : String(err) });
      }
    } finally { setStarting(false); }
  }, [server?.action, update.status]);

  const onAction = useCallback(async () => {
    if (pending || checking.current) return;
    if (kind === 'server') { void serverAct(); return; }
    if (kind === 'updated') return;
    // Download and check need no guard: nothing closes.
    if (!native && shellVisible && shellAction !== 'install') { void shellActions.run(); return; }
    const verb = native || shellVisible ? 'restart' : 'reload';
    // A restart ends the page process: a draft written by the check gets a moment to reach disk first.
    const go = async (force: boolean, otherWindows: number) => {
      if (verb === 'reload') { markSeen(); reloadForUpgrade(); return; }
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
  }, [pending, kind, serverAct, markSeen, native, shellVisible, shellAction, shellActions.run, installed.restart, installed.update?.windows, openHome]);
  const onLater = () => {
    if (!identity || pending) return;
    // The announcement is read, not put off: it must not hide a real update for 30 minutes.
    if (kind === 'updated') { markSeen(); return; }
    setSnooze(writeSnooze(identity));
  };
  // "Walnut updated to X" stays for this window's next look, then goes by itself.
  useEffect(() => {
    if (kind !== 'updated') return;
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = window.setTimeout(markSeen, UPDATED_NOTICE_MS);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', arm); };
  }, [kind, markSeen]);
  const visible = !!identity && (pending || !isSnoozed(snooze, identity, Date.now()));
  const docked = !!dock;
  // Before paint, so the popout never shows a frame with the bar pushed off the window.
  useLayoutEffect(() => {
    setUpdateNoticeOccupied(visible && docked);
    return () => setUpdateNoticeOccupied(false);
  }, [visible, docked]);
  const heading = kind === 'release' && shellAction !== 'install' ? 'Walnut update available'
    : kind === 'server' ? server!.heading
    : updatedTo && (kind === 'web' || kind === 'updated') ? `Walnut updated to ${displayVersion(updatedTo)}` : 'Walnut updated';
  const headingTitle = kind === 'server' ? server!.versionTitle
    : updatedTo && (kind === 'web' || kind === 'updated') ? `Walnut ${updatedTo}` : undefined;
  const error = installed.error ?? shellActions.error ?? serverError?.message ?? null;
  const clearError = () => { installed.clearError(); shellActions.clearError(); setServerError(null); };
  const errorTitle = shellActions.error || serverError?.verb === 'update' ? 'Could not update Walnut' : 'Could not restart Walnut';
  const tooltip = kind === 'app' ? 'Restart to use the installed app update'
    : kind === 'release' && shell ? getAppUpdateButtonTooltip(shell)
    : kind === 'server' ? server!.tooltip
    : kind === 'updated' ? heading : `${heading}: reload this window to use it`;
  const dataStatus = kind === 'app' ? pending ? 'restarting' : 'installed' : kind === 'release' ? shell?.status
    : kind === 'server' ? server!.stage : kind === 'updated' ? 'updated' : 'stale';

  return <>
    {visible && createPortal(
      <div className={`stale-build-pill${docked ? ' is-docked' : ''}`} role="status" aria-live="polite"
        data-served={state?.served} data-running={state?.running} data-update-kind={kind ?? undefined} data-status={dataStatus}>
        <span className="stale-build-pill-text" title={headingTitle ?? (noAction ? tooltip : undefined)}>{heading}</span>
        {noAction
          // Nothing to click: the words say it; the collapsed rail shows the short word in the button's place.
          ? <span className={`stale-build-pill-action is-status${working ? ' is-working' : ''}`} data-testid="walnut-update-action" data-status={dataStatus} data-short={shortLabel} title={tooltip}>
            <RefreshIcon /><span className="stale-build-pill-label">{label}</span>
          </span>
          : <>
            <span className="stale-build-pill-sep" aria-hidden="true">·</span>
            <button type="button" className={`stale-build-pill-action${working ? ' is-working' : ''}`} data-testid="walnut-update-action" data-status={dataStatus} onClick={() => { void onAction(); }} aria-disabled={pending || undefined} data-short={shortLabel}
              title={tooltip}>
              <RefreshIcon /><span className="stale-build-pill-label">{label}</span>
            </button>
          </>}
        <button type="button" className="stale-build-pill-later" onClick={onLater} aria-disabled={pending || undefined}
          title={kind === 'updated' ? 'Dismiss' : 'Later: hide this update notice for 30 minutes'} aria-label={kind === 'updated' ? 'Dismiss' : 'Later: hide this update notice for 30 minutes'}>×</button>
      </div>, docked ? dock : document.body,
    )}
    {howTo && <HowToUpdateDialog version={update.status?.live?.version ?? update.status?.latest ?? null}
      commands={howTo} packageUrl={update.status?.packageUrl ?? null} onClose={() => setHowTo(null)} />}
    {held && <UnsavedWorkDialog work={held.work} verb={held.verb} onCancel={() => setHeld(null)}
      onAnyway={() => { const { go } = held; setHeld(null); void go(); }} />}
    {error && <ConfirmDialog title={errorTitle} message={error}
      confirmLabel="Try Again" cancelLabel="Close" onCancel={clearError} onConfirm={() => { clearError(); void onAction(); }} />}
  </>;
}
