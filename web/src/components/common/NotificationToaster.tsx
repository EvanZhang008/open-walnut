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
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useNotifications, permissionDetail, requestIdOf,
  toolNameOf, isUnanswerableAsk, validAcpOptions, isRejectOption, sessionLabelOf,
  type Notification, type NotificationSeverity,
} from '@/contexts/notifications';
import { respondToPermission } from '@/api/sessions';
import { buildAskUserAnswers } from '@/components/sessions/ask-user-question';
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

/** AskUserQuestion answers inline only when the whole ask fits a toast. */
const MAX_TOAST_QUESTION_OPTIONS = 4;

export function NotificationToaster() {
  const { toasts, dismissToast } = useNotifications();
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
function PermissionToast({ n, onDismiss }: { n: Notification; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState<'allowed' | 'denied' | 'stale' | null>(null);
  const [failed, setFailed] = useState(false);
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
      setSettled(allow ? 'allowed' : 'denied');
      setTimeout(onDismiss, RESOLVED_DISMISS_MS);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) {
        setSettled('stale');
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

  /** Hand the ask over to the panel (the only surface with the full answer form). */
  const openCenter = () => {
    window.dispatchEvent(new CustomEvent('notification:open-center'));
    onDismiss();
  };

  const context = [sessionLabelOf(n), n.host].filter(Boolean).join(' · ');
  // A record with no session/requestId can't be answered from here (legacy or a
  // dropped field) — offer the deep link instead of dead buttons. An
  // AskUserQuestion we can't render is the same story for a different reason: a
  // bare allow would report an empty answers map as the user's answer.
  const answerable = !!n.sessionId && !!requestId && !isUnanswerableAsk(n, detail);

  // Single-select, one question, few options → the pills ARE the answer. Anything
  // richer (multi-select, several questions, a long option list) goes to the panel:
  // a blanket Approve would send an EMPTY answers map, which tells the model the
  // user answered nothing — the exact production bug this shape avoids.
  const inlineQuestion = detail.type === 'question'
    && detail.questions.length === 1
    && !detail.questions[0].multiSelect
    && detail.questions[0].options.length > 0
    && detail.questions[0].options.length <= MAX_TOAST_QUESTION_OPTIONS
    ? detail.questions[0]
    : null;

  return (
    <div
      className="notification-toast notification-toast--warning nfc-perm-toast"
      role="alert"
    >
      <div className="notification-toast-header">
        <span className="notification-toast-icon">{SEVERITY_ICON.warning}</span>
        <span className="notification-toast-title">{toolNameOf(n) ?? n.title}</span>
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
      {detail.type === 'question' && (
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
          {settled === 'allowed' ? 'Approved' : settled === 'denied' ? 'Denied' : 'Already answered'}
        </div>
      ) : (
        <div className="nfc-perm-actions">
          {!answerable ? (
            <button className="notification-toast-action" onClick={openCenter}>Open</button>
          ) : inlineQuestion ? (
            <>
              {inlineQuestion.options.map((opt) => (
                <button
                  key={opt.label}
                  className="nfc-perm-btn"
                  disabled={busy}
                  title={opt.description}
                  onClick={() => void respond(true, {
                    answers: buildAskUserAnswers(
                      [inlineQuestion],
                      { [inlineQuestion.question]: [opt.label] },
                      {},
                    ),
                  })}
                >
                  {opt.label}
                </button>
              ))}
              <button className="nfc-perm-btn nfc-perm-more" disabled={busy} onClick={openCenter}>
                More&hellip;
              </button>
            </>
          ) : detail.type === 'question' ? (
            // Never blanket-approve an AskUserQuestion: answering IS the response.
            <button className="nfc-perm-btn nfc-perm-primary" onClick={openCenter}>
              Answer&hellip;
            </button>
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
          {failed && <span className="nfc-perm-error">Failed — open the session to respond</span>}
        </div>
      )}
    </div>
  );
}
