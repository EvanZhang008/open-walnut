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

  // "Set up session file access" reads as a sentence; "Set up Session file
  // access" does not. Only labels that are already sentence case get their first
  // letter lowered — a Title Case or acronym label ("Full Disk Access") would be
  // mangled into "full Disk Access", so it is left exactly as written.
  // Copy lives in the step that says "paste", so the path the user pastes and
  // the path they copied are the same object on screen.
  const [copied, setCopied] = useState<string | null>(null);
  const copyPath = (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => { setCopied(value); setTimeout(() => setCopied(null), 2_000); },
      () => log.warn('permissions', 'clipboard copy refused'),
    );
  };

  // A step that opens the pane makes a second Open-Settings button at the bottom
  // a duplicate of itself, so the dialog drops the button rather than asking
  // which of the two identical actions is the real one.
  const aStepOpensSettings = permission.steps.some((s) => typeof s !== 'string' && s.open);

  const setupLabel = /^[A-Z][a-z]+ [a-z]/.test(permission.label)
    ? permission.label.charAt(0).toLowerCase() + permission.label.slice(1)
    : permission.label;

  return createPortal(
    <div className="app-modal-overlay" role="dialog" aria-modal="true" aria-label={`${permission.label} permission`} onMouseDown={onClose}>
      <div className="app-modal permission-fix-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">
          {state === 'granted'
            ? `${permission.label} access granted`
            // "needs permission" over a body that opens with "Optional." is the
            // dialog arguing with itself, and the title is what people believe.
            : permission.optional
              ? `Set up ${setupLabel}`
              : `${permission.label} needs permission`}
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
                launcher: a self-responsible helper's grant is its own, and
                mentioning the launcher there makes a correct instruction read
                like a mismatch the user should not follow. Kept out of the steps
                because it is a caveat, not something to do. */}
            {!permission.launcherIndependent && (
              <p className="permission-grant-target">
                Walnut is currently launched by <strong>{launcherName}</strong>, so macOS checks the grant
                for: <code>{permission.grantTarget}</code>
              </p>
            )}
            {!showPromptButton && (
              <ol className="permission-steps">
                {permission.steps.map((s, i) => {
                  const step = typeof s === 'string' ? { text: s } : s;
                  return (
                    <li key={i}>
                      {'open' in step && step.open ? (
                        <a
                          className="permission-step-link"
                          role="button"
                          tabIndex={0}
                          onClick={openSettings}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            openSettings();
                          }}
                        >
                          {step.text}
                        </a>
                      ) : (
                        step.text
                      )}
                      {'copy' in step && step.copy ? (
                        <>
                          {' '}
                          <button type="button" className="permission-copy" title="Copy this path"
                            onClick={() => copyPath(step.copy as string)}>
                            <code>{step.copy}</code>
                            <span className="permission-copy-hint">
                              {copied === step.copy ? 'copied' : 'copy'}
                            </span>
                          </button>
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
            {/* Promising a green that can never arrive is worse than saying
                nothing: the user flips the switch, watches the row stay grey, and
                concludes Walnut is broken. */}
            <p className="settings-muted">
              {permission.unverifiable
                ? 'macOS can\'t report this back, so the row stays grey either way.'
                : 'This window checks automatically and turns green once granted.'}
            </p>
            {/* One click, not six lines. Everything here is worth reading and
                nothing here is worth reading FIRST: the whole point is that the
                user can grant it without any of it. */}
            {permission.context && (
              <details className="permission-why">
                <summary>Why this exists</summary>
                <p className="permission-why-body">{permission.context}</p>
              </details>
            )}
          </div>
        )}

        <div className="app-modal-actions">
          <button className="app-modal-btn" onClick={onClose}>
            {state === 'granted' ? 'Done' : 'Close'}
          </button>
          {state !== 'granted' && showPromptButton && (
            <button className="app-modal-btn primary" disabled={requesting} onClick={triggerPrompt}>
              {requesting ? 'Waiting for macOS dialog…' : 'Request access'}
            </button>
          )}
          {/* Only for a row whose steps carry no opener of their own. */}
          {state !== 'granted' && !showPromptButton && !aStepOpensSettings && (
            <button className="app-modal-btn primary" onClick={openSettings}>
              Open System Settings
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
