/**
 * "Sign out this phone" on the caller's own row in Phones & Cloud (spec 4.7,
 * C75): a sheet asks first, then DELETE /api/devices/<own name>, which the
 * server allows a device for itself (deviceChangeDecision `by: 'self'`).
 *
 * On success the sign-in page is told it was this phone's own choice
 * (sessionStorage `walnut.signedOut` = 'self', so it says "Signed out" rather
 * than "This phone was signed out") and the page reloads. A refusal stays in
 * the sheet, which stays open.
 */
import { useState } from 'react';
import { apiDelete } from '@/api/client';
import { clearDeviceToken } from '@/api/device-token';
import { PhoneConfirmSheet } from '@/components/common/PhoneConfirmSheet';
import { SIGN_IN_SIGNED_OUT_FLAG } from '@/components/common/sign-in-copy';
import { requestFailureText } from '@/utils/request-failure';
import { log } from '@/utils/log';

const TIMEOUT_MS = 15_000;

export function OwnDeviceSignOut({ name, touch }: { name: string; touch: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const device = touch ? 'phone' : 'browser';

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Said before the request: the server closes this page's socket as it removes the
    // device, and the page must read that as its own sign-out, never "from your computer".
    try { sessionStorage.setItem(SIGN_IN_SIGNED_OUT_FLAG, 'self'); } catch { /* private mode */ }
    try {
      // An https page says so, as at sign-in: a tunnel may send no X-Forwarded-Proto, and the
      // server clears the refresh cookie of the scheme it reads.
      const secure = window.location.protocol === 'https:' ? '?secure=1' : '';
      await apiDelete(`/api/devices/${encodeURIComponent(name)}${secure}`, { timeoutMs: TIMEOUT_MS });
    } catch (err) {
      try { sessionStorage.removeItem(SIGN_IN_SIGNED_OUT_FLAG); } catch { /* private mode */ }
      log.warn('settings', 'self sign-out refused', { name, error: String(err) });
      setBusy(false);
      setError(requestFailureText(err, TIMEOUT_MS));
      return;
    }
    // Nothing of the sign-in is kept (the server cleared its refresh cookie): a later visit
    // shows the plain sign-in screen, never "signed out on your computer".
    clearDeviceToken();
    log.info('settings', 'signed this browser out', { name });
    window.location.reload();
  };

  return (
    <>
      <button
        type="button"
        className="devices-sign-out"
        data-testid="devices-sign-out"
        onClick={() => { setError(null); setOpen(true); }}
      >
        Sign out this {device}
      </button>
      <PhoneConfirmSheet
        open={open}
        name="sign-out"
        title={`Sign out this ${device}?`}
        body="You will need a new link from your computer to sign in again."
        confirmLabel="Sign out"
        cancelLabel="Cancel"
        destructive
        busy={busy}
        error={error}
        onConfirm={() => { void signOut(); }}
        onCancel={() => { if (!busy) setOpen(false); }}
        testId="devices-sign-out-sheet"
      />
    </>
  );
}
