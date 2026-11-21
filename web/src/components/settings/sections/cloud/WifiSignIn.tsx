/**
 * "Sign in a browser on this Wi-Fi": a one-time code for a browser on the same network, with no
 * tunnel. The server already listens on the Wi-Fi and trades a code for a browser's token
 * (POST /api/v1/browser-pair); until 2026-11-20 the only place that showed a code was the tunnel's
 * tab, and only once a tunnel was connected, so a Walnut without one could not sign a browser in.
 *
 *   Get a code      mints one (POST /api/devices/browser-code: single use, ten minutes)
 *   then            the Wi-Fi address and the code to type on the other device, and the QR of
 *                   the address with the code in it (`#pair=`, main.tsx trades it on open) for a
 *                   phone's camera; Copy takes that link
 *   signed in       the code is used up: a line says so and the button is back
 *
 * Shown on this Mac only (the server refuses a code to anyone not at it) and only when the device
 * list names a Wi-Fi address (`targets` kind lan).
 */
import { useEffect, useState } from 'react';
import { apiPost } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { SettingsNotice, SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { CopyButton } from '../../inputs/CopyButton';
import { saveErrorMessage } from '../../settings-pane-context';
import { BROWSER_SIGNED_IN_EVENT } from './devices-list';
import { PHONE_LINK_QR_SHOWN, phoneLinkQr } from './phone-link-qr';
import { formatSignInCode } from '@/components/common/sign-in-code';
import '@/styles/browser-access.css';
import '@/styles/devices-ways.css';

/** The link that opens Walnut at `origin` and signs that browser in with `code`. */
export function wifiSignInLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/#pair=${code}`;
}

interface WifiCode { code: string; expiresAt: number; link: string; qr?: string }

const SIGNED_IN_NOTE_MS = 20_000;

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
    try {
      const res = await apiPost<{ code: string; expiresAt: number }>('/api/devices/browser-code');
      const link = wifiSignInLink(origin, res.code);
      setCode({ code: res.code, expiresAt: res.expiresAt, link });
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
  useEvent(BROWSER_SIGNED_IN_EVENT, () => {
    if (!code) return;
    setCode(null);
    setSignedIn(true);
  });
  useEffect(() => {
    if (!signedIn) return;
    const timer = setTimeout(() => setSignedIn(false), SIGNED_IN_NOTE_MS);
    return () => clearTimeout(timer);
  }, [signedIn]);

  const address = origin.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const until = code ? new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <>
      <SettingsRow
        label="Sign in a browser on this Wi-Fi"
        data-testid="devices-wifi-sign-in"
        help={!code
          ? `For a computer or phone on the same Wi-Fi as this Mac, without a tunnel: it opens ${address} and types a one-time code.`
          : (
            <span className="browser-access-phone">
              {code.qr && (
                <img
                  className="browser-access-qr"
                  src={code.qr}
                  alt="QR code that opens Walnut on this Wi-Fi, signed in"
                  width={PHONE_LINK_QR_SHOWN}
                  height={PHONE_LINK_QR_SHOWN}
                  data-for={code.link}
                  data-testid="devices-wifi-qr"
                />
              )}
              <span className="browser-access-phone-text">
                <span className="devices-wifi-steps">
                  {'On the other device, open '}
                  <span className="settings-addons-mono" data-testid="devices-wifi-address">{origin}</span>
                  {' and type '}
                  <span className="browser-access-code-inline settings-addons-mono" data-testid="devices-wifi-code-value">{formatSignInCode(code.code).display}</span>
                  {'.'}
                </span>
                <span className="browser-access-link-note">{`A phone can scan the QR code instead. The code works once, for one browser, until ${until}. The Wi-Fi address is plain http: use it only on a network you trust.`}</span>
              </span>
            </span>
          )}
        error={error ?? undefined}
        control={(
          <span className="settings-addons-inline">
            {code && <CopyButton text={code.link} label="Copy link" data-testid="devices-wifi-copy" />}
            <SettingsButton disabled={busy} onClick={() => void mint()} data-testid="devices-wifi-get-code">
              {code ? 'New code' : 'Get a code'}
            </SettingsButton>
          </span>
        )}
      />
      {signedIn && (
        <div data-testid="devices-wifi-signed-in">
          <SettingsNotice kind="success" role="status">A browser just signed in with the code; it is listed here.</SettingsNotice>
        </div>
      )}
    </>
  );
}
