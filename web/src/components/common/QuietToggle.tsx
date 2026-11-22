/**
 * The human's quiet-mode toggle in the notification panel header.
 *
 * It only ever touches the `user` hold: a plugin's focus timer holds quiet on its
 * own and ends it on its own, so "Unmute" appears only when the human's hold is
 * what is keeping Walnut quiet. While another source holds quiet, a small "Quiet"
 * chip says so (its title names the holds) and "Mute for 1 hour" still adds the human's own.
 * It is one of the header's tool buttons (NotificationRail.tsx), and reads in full: "Quiet 1h"
 * said neither what goes quiet nor for how long (2026-11-21 audit).
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
        type="button"
        className="btn"
        data-testid="nfc-quiet-toggle"
        disabled={busy}
        title={userHold
          ? `${quietLabel(live)}. Unmute to get toasts, sounds and phone pushes again.`
          : 'Mute toasts, sounds and phone pushes for an hour. This list still collects everything, and permission asks still show.'}
        onClick={() => { void toggle(); }}
      >
        {userHold ? 'Unmute' : 'Mute for 1 hour'}
      </button>
    </span>
  );
}
