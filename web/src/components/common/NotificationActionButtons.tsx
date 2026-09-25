/**
 * The buttons of one notice (toast or feed card), primary first, at most three.
 *
 * `navigate` routes, `callback` fires the producer's onAction, `op` runs a plugin
 * op (runOpAction). Success → `onDone` (the surface closes its toast and marks the
 * record read). Failure keeps everything up with a short inline error, the same
 * contract as the permission form: a click that silently did nothing is how a
 * reminder's "Snooze" gets pressed three times.
 */
import { useState } from 'react';
import {
  runOpAction, type Notification, type NotificationAction,
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
