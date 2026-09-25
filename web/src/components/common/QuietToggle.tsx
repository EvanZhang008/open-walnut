/**
 * The human's quiet-mode toggle in the notification panel header.
 *
 * It only ever touches the `user` hold: a plugin's focus timer holds quiet on its
 * own and ends it on its own, so "End quiet" appears only when the human's hold is
 * what is keeping Walnut quiet. While another source holds quiet, a small "Quiet"
 * chip says so (its title names the holds) and "Quiet 1h" still adds the human's own.
 */
import { useState } from 'react';
import { useNotifications, setUserQuiet, effectiveQuiet, quietLabel } from '@/contexts/notifications';
import { log } from '@/utils/log';
import '@/styles/notification-quiet.css';

const QUICK_MINUTES = 60;

export function QuietToggle() {
  const { quiet } = useNotifications();
  const [busy, setBusy] = useState(false);
  const live = effectiveQuiet(quiet);
  const userHold = live.holds.find(h => h.source === 'user');

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The new state arrives as quiet:changed; the response is not needed here.
      await setUserQuiet(!userHold, userHold ? undefined : QUICK_MINUTES);
    } catch (err) {
      log.warn('notifications', 'quiet toggle failed', { error: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="nfc-quiet-toggle">
      {live.active && !userHold && (
        <span className="nfc-quiet-chip" title={quietLabel(live)} data-testid="nfc-quiet-chip">☾ Quiet</span>
      )}
      <button
        className="notification-clear-all"
        data-testid="nfc-quiet-toggle"
        disabled={busy}
        title={userHold
          ? quietLabel(live)
          : 'Hold toasts, sounds and push for an hour. The feed still collects everything, and permission asks still show.'}
        onClick={() => { void toggle(); }}
      >
        {userHold ? 'End quiet' : 'Quiet 1h'}
      </button>
    </span>
  );
}
