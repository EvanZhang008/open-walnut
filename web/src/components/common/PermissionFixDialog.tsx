/**
 * Permission Doctor fix dialog — the "click here, we verify" flow.
 *
 * Shown next to a feature that just failed on a macOS permission (calendar
 * empty, session file popups). One dialog handles both fix shapes:
 *   - prompt-capable ('not-determined' calendar): a Request-access button that
 *     triggers the one system dialog macOS allows;
 *   - settings-only (denied calendar, Full Disk Access): an Open-Settings
 *     button (the server opens the exact pane on the Mac) plus the steps.
 *
 * While open it polls the probe every 2s with force=1 and flips to a green
 * confirmation the moment the grant lands — the user never has to guess
 * whether their toggle "took". Polling stops when the tab is hidden (Page
 * Visibility rule: hidden tabs must not compete for the server) and on close.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import {
  getPermissions,
  openPermissionSettings,
  requestPermission,
  type PermissionStatus,
} from '@/api/permissions';
import { log } from '@/utils/log';

interface PermissionFixDialogProps {
  permission: PermissionStatus;
  /** Launcher display name ("Walnut.app", "iTerm2") — naming the responsible
   *  app is what stops users from granting to the wrong identity. */
  launcherName: string;
  onClose: () => void;
  /** Called once when the poll (or prompt) confirms the grant — the caller
   *  refreshes its feature (e.g. reload calendar events). */
  onGranted?: () => void;
}

const VERIFY_POLL_MS = 2_000;

export function PermissionFixDialog({ permission, launcherName, onClose, onGranted }: PermissionFixDialogProps) {
  useModalOverlay(onClose);
  const [state, setState] = useState(permission.state);
  const [requesting, setRequesting] = useState(false);
  const grantedFired = useRef(false);

  const fireGranted = useCallback(() => {
    // Poll tick and prompt response can both observe the grant — dedupe so
    // the caller's refresh runs once.
    if (grantedFired.current) return;
    grantedFired.current = true;
    log.info('permissions', `granted: ${permission.id}`);
    onGranted?.();
  }, [permission.id, onGranted]);

  // Verify loop: re-probe while the dialog is open and the tab is visible.
  useEffect(() => {
    if (state === 'granted') return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const report = await getPermissions(true);
        const fresh = report.permissions.find((p) => p.id === permission.id);
        if (!cancelled && fresh?.state === 'granted') {
          setState('granted');
          fireGranted();
        }
      } catch {
        /* transient probe failure — next tick retries */
      }
    };
    const timer = setInterval(tick, VERIFY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state, permission.id, fireGranted]);

  const triggerPrompt = async () => {
    setRequesting(true);
    try {
      // Resolves only after the user answers the macOS dialog (server blocks
      // on the helper) — so the result here is authoritative, no poll needed.
      const { state: result } = await requestPermission(permission.id);
      if (result === 'granted') {
        setState('granted');
        fireGranted();
      } else if (result === 'denied') {
        // The one prompt is now spent; macOS will never show it again. Switch
        // this dialog into settings-only mode rather than a dead button.
        setState('denied');
      }
    } catch (err) {
      log.warn('permissions', `request failed: ${permission.id}`, { error: String(err) });
    } finally {
      setRequesting(false);
    }
  };

  const openSettings = () => {
    // Fire-and-forget: System Settings opens on the Mac; the verify poll
    // confirms the outcome regardless of where this UI runs.
    openPermissionSettings(permission.id).catch((err) =>
      log.warn('permissions', `open settings failed: ${permission.id}`, { error: String(err) })
    );
  };

  const showPromptButton = state === 'not-determined' && permission.fixKind === 'prompt';

  return createPortal(
    <div className="app-modal-overlay" role="dialog" aria-modal="true" aria-label={`${permission.label} permission`} onMouseDown={onClose}>
      <div className="app-modal permission-fix-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">
          {state === 'granted' ? `${permission.label} access granted` : `${permission.label} needs permission`}
        </div>

        {state === 'granted' ? (
          <div className="app-modal-message">
            <div className="permission-granted-check">✓</div>
            <p>All set — Walnut can use {permission.label} now.</p>
          </div>
        ) : (
          <div className="app-modal-message">
            <p>{permission.why}</p>
            {/* Naming the launcher is only true for grants that FOLLOW the
                launcher. A self-responsible helper's grant is its own, and
                mentioning the launcher there makes a correct instruction read
                like a mismatch the user should not follow. */}
            <p className="permission-grant-target">
              {permission.launcherIndependent ? (
                <>
                  macOS checks this grant for Walnut's own helper: <code>{permission.grantTarget}</code>
                </>
              ) : (
                <>
                  Walnut is currently launched by <strong>{launcherName}</strong>, so macOS checks the grant
                  for: <code>{permission.grantTarget}</code>
                </>
              )}
            </p>
            {!showPromptButton && (
              <ol className="permission-steps">
                {permission.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
            <p className="settings-muted">This window checks automatically and turns green once granted.</p>
          </div>
        )}

        <div className="app-modal-actions">
          <button className="app-modal-btn" onClick={onClose}>
            {state === 'granted' ? 'Done' : 'Close'}
          </button>
          {state !== 'granted' &&
            (showPromptButton ? (
              <button className="app-modal-btn primary" disabled={requesting} onClick={triggerPrompt}>
                {requesting ? 'Waiting for macOS dialog…' : 'Request access'}
              </button>
            ) : (
              <button className="app-modal-btn primary" onClick={openSettings}>
                Open System Settings
              </button>
            ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
