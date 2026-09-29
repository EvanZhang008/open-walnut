/**
 * The buttons of one notice (toast or feed card), primary first, at most three.
 *
 * `navigate` routes, `callback` fires the producer's onAction, `op` runs a plugin
 * op (runOpAction).
 *
 * A TOAST closes on the click and runs the op after: the op answers in tens of
 * milliseconds, but a server busy with other work once held one for 5s and the
 * toast just sat there looking broken. A failure still answers the click, with its
 * own error toast naming the button and the reason (the record stays in the feed,
 * so the button can be pressed again there): a click that silently did nothing is
 * how a reminder's "Snooze" gets pressed three times.
 *
 * A feed CARD stays put while the op runs (the button reads "…") and shows a
 * failure inline; the record leaves the feed when the op dismisses it.
 */
import { useState } from 'react';
import {
  runOpAction, useNotifications, type Notification, type NotificationAction,
} from '@/contexts/notifications';
import { log } from '@/utils/log';

export function NotificationActionButtons({
  n, actions, variant, onNavigate, onDone, onInteract,
}: {
  n: Notification;
  actions: NotificationAction[];
  variant: 'toast' | 'card';
  onNavigate: (to: string) => void;
  onDone: () => void;
  /** First touch of any button (the toaster pins its toast so it cannot time out mid-request). */
  onInteract?: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { notify } = useNotifications();
  if (actions.length === 0) return null;

  const run = async (a: NotificationAction, index: number) => {
    onInteract?.();
    if (a.kind === 'navigate') {
      if (!a.to) return; // malformed: leave the notice up rather than a silent no-op dismiss
      onNavigate(a.to);
      onDone();
      return;
    }
    if (a.kind === 'callback') {
      n.onAction?.();
      onDone();
      return;
    }
    if (busy !== null) return;
    if (variant === 'toast') {
      // Close first, run after. This component unmounts with the toast, so the
      // outcome is reported through the provider, never through local state.
      onDone();
      const result = await runOpAction(a);
      if (result.ok) {
        log.info('notifications', 'notice action ran', { dedupKey: n.dedupKey, pluginId: a.pluginId, op: a.op });
        return;
      }
      log.warn('notifications', 'notice action failed', {
        dedupKey: n.dedupKey, pluginId: a.pluginId, op: a.op, error: result.message,
      });
      notify({
        kind: 'operation-error', severity: 'error', persistent: false,
        title: `"${a.label}" did not run`,
        body: n.persistent ? `${result.message}. The notice is still in the notifications panel.` : result.message,
        dedupKey: `notice-action-error:${n.dedupKey}`,
      });
      return;
    }
    setBusy(index);
    setError(null);
    const result = await runOpAction(a);
    setBusy(null);
    if (result.ok) {
      log.info('notifications', 'notice action ran', { dedupKey: n.dedupKey, pluginId: a.pluginId, op: a.op });
      onDone();
      return;
    }
    log.warn('notifications', 'notice action failed', {
      dedupKey: n.dedupKey, pluginId: a.pluginId, op: a.op, error: result.message,
    });
    setError(result.message);
  };

  const card = variant === 'card';
  return (
    <>
      <div
        className={card ? 'nfc-card-actions' : 'nfc-perm-actions nfc-notice-actions'}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {actions.map((a, i) => {
          const primary = i === 0;
          const className = card
            ? `nfc-card-action${primary ? ' nfc-card-action--primary' : ''}`
            : `nfc-perm-btn${primary ? ' nfc-perm-primary' : ''}`;
          return (
            <button
              key={`${i}:${a.label}`}
              className={className}
              data-testid="nfc-notice-action"
              disabled={busy !== null}
              onClick={(e) => { e.stopPropagation(); void run(a, i); }}
            >
              {busy === i ? '…' : a.label}{a.kind === 'navigate' && card ? ' ↗' : ''}
            </button>
          );
        })}
      </div>
      {error && (
        <div className="nfc-perm-error nfc-perm-error--block" role="alert" data-testid="nfc-notice-action-error">
          Failed: {error}
        </div>
      )}
    </>
  );
}
