/**
 * Same Wi-Fi tab, "Open Walnut in a browser on this Wi-Fi": a one-time code for a browser on the same network, with no
 * tunnel. The server already listens on the Wi-Fi and trades a code for a browser's token
 * (POST /api/v1/browser-pair); until 2026-11-20 the only place that showed a code was the tunnel's
 * tab, and only once a tunnel was connected, so a Walnut without one could not sign a browser in.
 *
 *   Get a code      mints one (POST /api/devices/browser-code: single use, ten minutes)
 *   then            the Wi-Fi address and the code to type on the other device, and the QR of
 *                   the address with the code in it (`#pair=`, main.tsx trades it on open) for a
 *                   phone's camera; Copy takes that link
 *   New code        takes the shown code back first (POST /api/devices/browser-code/revoke), so a
 *                   code someone may have seen stops working
 *   signed in       a browser used THIS code (the event names it by id): the row says so, the
 *                   button is back; another code's sign-in leaves it alone
 *
 * Shown on this Mac only (the server refuses a code to anyone not at it) and only when the device
 * list names a Wi-Fi address (`targets` kind lan).
 */
import { useEffect, useState } from 'react';
import { apiPost } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { saveErrorMessage } from '../../settings-pane-context';
import { BROWSER_SIGNED_IN_EVENT, usedCode } from './devices-list';
import { phoneLinkQr } from './phone-link-qr';
import { SignInWays } from './SignInWays';
import { formatSignInCode } from '@/components/common/sign-in-code';
import '@/styles/browser-access.css';
import '@/styles/devices-ways.css';

/** The link that opens Walnut at `origin` and signs that browser in with `code`. */
export function wifiSignInLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/#pair=${code}`;
}

interface WifiCode { code: string; expiresAt: number; id?: string; origin: string; link: string; qr?: string }

const SIGNED_IN_NOTE_MS = 20_000;

/** Take back a code this row showed (best effort: it runs out by itself in ten minutes anyway). */
function revoke(id: string | undefined): void {
  if (!id) return;
  apiPost('/api/devices/browser-code/revoke', { id }).catch((err: unknown) => {
    log.warn('devices', 'an earlier Wi-Fi sign-in code could not be taken back', { error: err instanceof Error ? err.message : String(err) });
  });
}

export function WifiSignInRow({ origin }: { origin: string }) {
  const [code, setCode] = useState<WifiCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  const mint = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSignedIn(false);
    // The code on screen stops working first: New code means "not that one".
    revoke(code?.id);
    setCode(null);
    try {
      const res = await apiPost<{ code: string; expiresAt: number; id?: string }>('/api/devices/browser-code');
      const link = wifiSignInLink(origin, res.code);
      setCode({ code: res.code, expiresAt: res.expiresAt, id: res.id, origin, link });
      const qr = await phoneLinkQr(link);
      if (!qr) log.warn('devices', 'the Wi-Fi sign-in QR code could not be drawn');
      setCode((now) => (now && now.link === link ? { ...now, qr } : now));
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // A code is good for ten minutes: it leaves the screen when it runs out.
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(1_000, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);
  // Used up: a browser signed in with it.
  useEvent(BROWSER_SIGNED_IN_EVENT, (data) => {
    if (!usedCode(data, code)) return;
    setCode(null);
    setSignedIn(true);
  });
  useEffect(() => {
    if (!signedIn) return;
    const timer = setTimeout(() => setSignedIn(false), SIGNED_IN_NOTE_MS);
    return () => clearTimeout(timer);
  }, [signedIn]);

  const address = origin.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const PLAIN = 'Plain http: anyone on the same Wi-Fi can see that browser\'s traffic, so use it only on a network you trust, and sign it out below when done.';
  const PLAIN_SHORT = 'Plain http, so only on a network you trust.';
  const until = code ? new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <>
      <SettingsRow
        label="One-time sign-in code"
        data-testid="devices-wifi-sign-in"
        help={!code
          ? (signedIn
            ? <span data-testid="devices-wifi-signed-in">A browser just signed in with the code; it is listed below.</span>
            : `On a computer or phone on the same Wi-Fi, open ${address}: it asks for a code, which you get here. ${PLAIN}`)
          : (
            <SignInWays
              open={<span className="settings-addons-mono" data-testid="devices-wifi-address">{code.origin}</span>}
              type={<span className="browser-access-code-inline settings-addons-mono" data-testid="devices-wifi-code-value">{formatSignInCode(code.code).display}</span>}
              copy={{ text: code.link, testId: 'devices-wifi-copy' }}
              qr={code.qr ? { src: code.qr, alt: 'QR code that opens Walnut on this Wi-Fi, signed in', link: code.link, testId: 'devices-wifi-qr' } : undefined}
              note={`It works once, until ${until}. ${PLAIN_SHORT}`}
            />
          )}
        error={error ?? undefined}
        // Making another sits where the first was made, on the row's right: one place for the action.
        control={(
          <SettingsButton variant={code ? 'text' : 'default'} disabled={busy} onClick={() => void mint()} data-testid="devices-wifi-get-code">
            {code ? 'New code' : 'Get sign-in code'}
          </SettingsButton>
        )}
      />
    </>
  );
}
