/**
 * Device pairing: mint a token and render its QR. ONE copy of this logic, shared
 * by Settings → Devices (list + per-row re-pair) and the Cloud Companion
 * section's post-setup "pair your phone" card.
 *
 * The token exists in exactly one response and is never stored client-side, so
 * `created` stays until the caller dismisses it — that state IS the only copy.
 */

import { useCallback, useState } from 'react';
import QRCode from 'qrcode';
import { apiPost } from '@/api/client';
import { log } from '@/utils/log';

/** Where a scanned QR points the phone. `cloud` keeps working off Wi-Fi. */
export type PairTargetKind = 'lan' | 'cloud';

export interface PairingTarget {
  kind: PairTargetKind;
  origin: string;
  label: string;
}

export interface CreatedDevice {
  name: string;
  token: string;
  pairingURI: string;
  target?: PairTargetKind;
  server?: string;
}

export interface UsePairDevice {
  created: CreatedDevice | null;
  qrDataURL: string | null;
  error: string | null;
  busy: boolean;
  /**
   * Mint (or with `replace`, rotate) a credential and build its QR.
   * Resolves to the created device, or null when the server rejected it.
   */
  mint: (args: { name: string; target?: PairTargetKind; replace?: boolean }) => Promise<CreatedDevice | null>;
  dismiss: () => void;
  setError: (message: string | null) => void;
}

/**
 * Cloud pairing mints ON the cloud box — an internet round-trip that can include
 * a revoke+re-mint retry. The 15s client default would abort while the server
 * succeeds, orphaning a device nobody has the token for.
 */
const CLOUD_MINT_TIMEOUT_MS = 45_000;

export function usePairDevice(): UsePairDevice {
  const [created, setCreated] = useState<CreatedDevice | null>(null);
  const [qrDataURL, setQrDataURL] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mint = useCallback(async (
    { name, target, replace }: { name: string; target?: PairTargetKind; replace?: boolean },
  ): Promise<CreatedDevice | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: trimmed };
      if (target) body.target = target;
      if (replace) body.replace = true;
      const res = await apiPost<CreatedDevice>(
        '/api/devices',
        body,
        target === 'cloud' ? { timeoutMs: CLOUD_MINT_TIMEOUT_MS } : undefined,
      );
      setCreated(res);
      // errorCorrectionLevel 'M' + margin 2: phones scan glossy screens at an angle.
      setQrDataURL(await QRCode.toDataURL(res.pairingURI, { errorCorrectionLevel: 'M', width: 260, margin: 2 }));
      log.info('settings', 'device paired', { deviceName: res.name, target: target ?? 'default' });
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    setCreated(null);
    setQrDataURL(null);
  }, []);

  return { created, qrDataURL, error, busy, mint, dismiss, setError };
}
