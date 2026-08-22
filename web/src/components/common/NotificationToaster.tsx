/**
 * NotificationToaster — the single top-right toast renderer.
 *
 * Replaces CronToast + PermissionToast + OperationErrorToast (and renders the
 * ephemeral sort / audio-error toasts too). Reads the unified toast stack from
 * NotificationProvider; styling keys off severity. The optional action button
 * navigates (react-router) or fires a callback, then dismisses.
 *
 * Clicking a PERSISTENT toast's body opens the notification center (that toast is
 * also in the feed, so "see it again later" is meaningful). Reuses the window
 * custom-event bridge the layout already uses for cross-tree toggles
 * (e.g. `sidebar:toggle-todo`) — Sidebar listens for `notification:open-center`.
 * Ephemeral toasts (sort / audio-error) aren't in the feed, so they stay inert.
 *
 * PENDING PERMISSIONS render a richer, ANSWERABLE card: what is being asked
 * (command / question / plan / file), where it came from (session + host), and
 * the real buttons. A permission toast that only said "Session needs permission
 * approval" forced a session round-trip for a one-word decision.
 *
 * An AskUserQuestion is answered IN FULL here — every question, every option,
 * multi-select, and the per-question free-text "Other" box — through the same
 * PermissionAnswerForm the panel card uses. The toast used to fall back to an
 * "Answer…" button that merely opened the center for anything beyond one
 * single-select question with at most four options, which made the popup a dead
 * end for exactly the asks that most needed answering.
 */

import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useNotifications, permissionDetail, requestIdOf,
  toolNameOf, isUnanswerableAsk, validAcpOptions, isRejectOption, sessionLabelOf,
  linkTargetOf,
  type Notification, type NotificationSeverity,
} from '@/contexts/notifications';
import { respondToPermission } from '@/api/sessions';
import { PermissionAnswerForm } from './PermissionAnswerForm';
import { navigateToTarget } from '@/utils/open-session';
import { log } from '@/utils/log';

// Escape-coded so the source bytes are identical across editors/terminals
// (raw multi-codepoint emoji like ⚠️ can render or copy-paste inconsistently).
const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  info: '\u{1F514}',          // 🔔 bell
  success: '✅',          // ✅ check
  warning: '⚠️',    // ⚠️ warning sign + emoji variation selector
  error: '❌',            // ❌ cross
};

/** How long an answered permission toast stays up before self-dismissing. */
const RESOLVED_DISMISS_MS = 1500;

export function NotificationToaster() {
  const { toasts, dismissToast, pinToast } = useNotifications();
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div className="notification-toaster" aria-live="polite">
      {toasts.map((toast) => {
        // A pending permission is answerable in place — its own card.
        if (toast.kind === 'permission' && !toast.resolved) {
          return (
            <PermissionToast
              key={toast.id}
              n={toast}
              onDismiss={() => dismissToast(toast.id)}
              // The toast is now a form; the 15s auto-dismiss must not pull it out
              // from under someone mid-typing. It asks the OWNER of the timer to
              // cancel it (see NotificationProvider.pinToast) rather than racing it.
              onPin={() => pinToast(toast.id)}
              navigate={navigate}
            />
          );
        }
        // Persistent toasts live in the feed too, so the body is a shortcut into
        // the notification center. Ephemeral ones (sort/audio) aren't — inert body.
        const opensCenter = toast.persistent;
        return (
        <div
          key={toast.id}
          className={`notification-toast notification-toast--${toast.severity}${opensCenter ? ' notification-toast--clickable' : ''}`}
          role={toast.severity === 'error' || toast.severity === 'warning' ? 'alert' : 'status'}
          onClick={opensCenter ? () => {
            window.dispatchEvent(new CustomEvent('notification:open-center'));
            dismissToast(toast.id);
          } : undefined}
          title={opensCenter ? 'Open notification center' : undefined}
        >
          <div className="notification-toast-header">
            <span className="notification-toast-icon">{SEVERITY_ICON[toast.severity]}</span>
            <span className="notification-toast-title">{toast.title}</span>
            <button
              className="notification-toast-close"
              onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); }}
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
          {toast.body && <div className="notification-toast-body">{toast.body}</div>}
          {toast.action && (
            <button
              className="notification-toast-action"
              onClick={(e) => {
                e.stopPropagation();  // action has its own target — don't also open the center
                const a = toast.action;
                if (a?.kind === 'navigate' && a.to) {
                  // Session deep links open on the home page's session columns
                  // (primary surface) instead of the /sessions page.
                  navigateToTarget(a.to, navigate);
                } else if (a?.kind === 'callback') {
                  toast.onAction?.();
                } else {
                  // Malformed action (e.g. navigate without `to`) — do nothing and
                  // leave the toast up rather than silently dismissing on a no-op.
                  return;
                }
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
        );
      })}
    </div>
  );
}

/**
 * Answerable permission toast. Same respond() contract as the panel card and the
 * session view: 404/409 means the request already settled elsewhere (answered in
 * another surface, turn died) — settle and dismiss instead of re-arming buttons
 * the user would click forever.
 */
function PermissionToast({ n, onDismiss, onPin, navigate }: {
  n: Notification;
  onDismiss: () => void;
  onPin: () => void;
  navigate: (to: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<'allowed' | 'denied' | 'stale' | null>(null);
  const [failed, setFailed] = useState(false);
  // The record's own outcome wins over local state (same precedence as the panel
  // card), so an 'expired' — session died, CLI withdrew the ask — renders as
  // settled rather than as live buttons. Today the toaster only routes UNresolved
  // permissions here and the provider dismisses the toast on resolution, so this
  // is the belt to that braces: if either gate changes, the chip is already right
  // instead of offering Approve/Deny for a dead request.
  const settled = n.resolved ?? sent;
  const detail = permissionDetail(n);
  const requestId = requestIdOf(n);
  const acpOptions = validAcpOptions(n);

  const respond = async (
    allow: boolean,
    opts?: { optionId?: string; answers?: Record<string, string>; message?: string },
  ) => {
    if (!n.sessionId || !requestId || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await respondToPermission(n.sessionId, requestId, allow, opts?.message, opts?.optionId, opts?.answers);
      setSent(allow ? 'allowed' : 'denied');
      setTimeout(onDismiss, RESOLVED_DISMISS_MS);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) {
        setSent('stale');
        setTimeout(onDismiss, RESOLVED_DISMISS_MS);
      } else {
        setFailed(true);
      }
      log.warn('notifications', 'toast permission respond failed', {
        sessionId: n.sessionId, requestId, status: String(status ?? ''), error: String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  /** Hand a degraded ask over to the panel (a record we can't answer from here). */
  const openCenter = () => {
    window.dispatchEvent(new CustomEvent('notification:open-center'));
    onDismiss();
  };

  // Navigate to the session AND close the toast. The toast is ephemeral, so
  // dropping it on navigation is right — but the FEED copy stays exactly as it
  // was, still pending, because opening a session is not a decision. Only a real
  // resolution settles a permission (session:permission-resolved stamps the feed).
  const target = linkTargetOf(n);
  const openSession = () => {
    if (!target) return;
    navigateToTarget(target, navigate);
    onDismiss();
  };

  // Pin on the FIRST interaction only (pointerdown, focus, keystroke inside the
  // toast). A ref, not state: re-rendering the toast to remember "already pinned"
  // would remount the form's inputs and lose what the user typed.
  const pinned = useRef(false);
  const pinOnce = useCallback(() => {
    if (pinned.current) return;
    pinned.current = true;
    onPin();
  }, [onPin]);

  const context = [sessionLabelOf(n), n.host].filter(Boolean).join(' · ');
  // A record with no session/requestId can't be answered from here (legacy or a
  // dropped field) — offer the deep link instead of dead buttons. An
  // AskUserQuestion we can't render is the same story for a different reason: a
  // bare allow would report an empty answers map as the user's answer.
  const answerable = !!n.sessionId && !!requestId && !isUnanswerableAsk(n, detail);
  /** The whole ask is answered here now, however many questions it carries. */
  const questionForm = answerable && detail.type === 'question' ? detail.questions : null;

  return (
    <div
      className="notification-toast notification-toast--warning nfc-perm-toast"
      role="alert"
      // Capture-phase listeners on the wrapper: one place to notice interaction
      // anywhere inside (pills, the free-text input, the option list), instead of
      // wiring a handler onto every control the form owns.
      onPointerDown={pinOnce}
      onFocusCapture={pinOnce}
      onKeyDownCapture={pinOnce}
    >
      <div className="notification-toast-header">
        <span className="notification-toast-icon">{SEVERITY_ICON.warning}</span>
        <span className="notification-toast-title">{toolNameOf(n) ?? n.title}</span>
        {/* Click-through to the session, on every permission toast with one. */}
        {target && (
          <button
            className="nfc-open-session"
            title="Open the session this came from"
            onClick={(e) => { e.stopPropagation(); openSession(); }}
          >
            Open session ↗
          </button>
        )}
        <button
          className="notification-toast-close"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>

      {context && <div className="nfc-perm-context">{context}</div>}

      {/* What is actually being asked. */}
      {detail.type === 'bash' && (
        <code className="nfc-perm-cmd">{detail.command}</code>
      )}
      {/* Only when the form ISN'T rendering the questions itself — the form prints
          every question text, so a preview line above it would say it twice. */}
      {detail.type === 'question' && !questionForm && (
        <div className="nfc-perm-ask">{detail.questions[0]?.question ?? n.body}</div>
      )}
      {detail.type === 'plan' && <div className="nfc-perm-ask">Plan ready for review</div>}
      {detail.type === 'file' && <div className="nfc-perm-path">{detail.filePath}</div>}
      {detail.type === 'generic' && (
        /* The over-ceiling case: `preview` is all that survived of the input, so
           show it — this branch used to render nothing about the ask. Clamped by
           .nfc-perm-cmd; the panel card is where it expands. */
        detail.preview
          ? <code className="nfc-perm-cmd">{detail.preview}</code>
          : n.body ? <div className="notification-toast-body">{n.body}</div> : null
      )}

      {settled ? (
        <div className="nfc-perm-settled">
          {settled === 'allowed' ? 'Approved'
            : settled === 'denied' ? 'Denied'
            // Nobody answered and nobody can — neutral, never a decision.
            : settled === 'expired' ? 'Session ended'
            : 'Already answered'}
        </div>
      ) : questionForm ? (
        /* The whole ask, answerable in the popup: every question, every option,
           multi-select, per-question free text. Height-capped + internally
           scrolled (`scrollable`) so a many-question ask keeps its Submit button
           on screen inside a 380px top-right toast. */
        <PermissionAnswerForm
          questions={questionForm}
          disabled={busy}
          resolved={false}
          scrollable
          onSubmit={(answers) => void respond(true, { answers })}
          onDismissQuestions={() => void respond(false, { message: 'User dismissed the questions' })}
        />
      ) : (
        <div className="nfc-perm-actions">
          {!answerable ? (
            /* Nothing to answer WITH (no session/requestId), or an AskUserQuestion
               whose questions never survived the wire — a blanket Approve there
               would report an empty answers map as the user's answer. The center is
               the escape hatch: it shows the record's full detail, and for an
               unanswerable ask it offers the session deep link. */
            <button className="notification-toast-action" onClick={openCenter}>Open</button>
          ) : acpOptions.length > 0 ? (
            <>
              {acpOptions.map((o) => {
                const isReject = isRejectOption(o);
                return (
                  <button
                    key={o.optionId}
                    className={`nfc-perm-btn${isReject ? '' : ' nfc-perm-primary'}`}
                    disabled={busy}
                    onClick={() => void respond(!isReject, { optionId: o.optionId })}
                  >
                    {o.name ?? o.optionId}
                  </button>
                );
              })}
              {/* The adapter's own reject option may be absent — keep a plain Deny. */}
              {!acpOptions.some(isRejectOption) && (
                <button className="nfc-perm-btn" disabled={busy} onClick={() => void respond(false)}>
                  Deny
                </button>
              )}
            </>
          ) : (
            <>
              <button
                className="nfc-perm-btn nfc-perm-primary"
                disabled={busy}
                onClick={() => void respond(true)}
              >
                Approve
              </button>
              <button className="nfc-perm-btn" disabled={busy} onClick={() => void respond(false)}>
                Deny
              </button>
            </>
          )}
        </div>
      )}
      {/* Hoisted out of the actions row: a failed SUBMIT from the answer form
          above needs the same message, and the form has no actions row of its own. */}
      {!settled && failed && (
        <div className="nfc-perm-error nfc-perm-error--block">Failed — open the session to respond</div>
      )}
    </div>
  );
}
