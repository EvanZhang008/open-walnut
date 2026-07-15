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
 */

import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/contexts/notifications';
import type { NotificationSeverity } from '@/contexts/notifications';
import { navigateToTarget } from '@/utils/open-session';

// Escape-coded so the source bytes are identical across editors/terminals
// (raw multi-codepoint emoji like ⚠️ can render or copy-paste inconsistently).
const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  info: '\u{1F514}',          // 🔔 bell
  success: '✅',          // ✅ check
  warning: '⚠️',    // ⚠️ warning sign + emoji variation selector
  error: '❌',            // ❌ cross
};

export function NotificationToaster() {
  const { toasts, dismissToast } = useNotifications();
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div className="notification-toaster" aria-live="polite">
      {toasts.map((toast) => {
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
