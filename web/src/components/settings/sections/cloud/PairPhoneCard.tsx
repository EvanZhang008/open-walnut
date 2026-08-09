/**
 * "Pair your phone" card, shown inline after a companion finishes setting up.
 *
 * Deliberately targets `cloud`: the whole point of having just built a companion
 * is a phone that works off Wi-Fi, and a LAN QR scanned over cellular can never
 * connect. It refuses to mint until /api/devices actually reports a cloud target
 * — otherwise the button would hand back a LAN credential that looks right and
 * silently fails on the road.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import { PairingQrBlock } from './PairingQrBlock';
import { usePairDevice, type PairingTarget } from './usePairDevice';

interface Props {
  /** Companion hostname, for the copy — pairing itself reads the server's target. */
  domain?: string;
}

export function PairPhoneCard({ domain }: Props) {
  const [targets, setTargets] = useState<PairingTarget[] | null>(null);
  const [name, setName] = useState('iPhone');
  const { created, qrDataURL, error, busy, mint, dismiss } = usePairDevice();

  const loadTargets = useCallback(async () => {
    try {
      const res = await apiGet<{ targets?: PairingTarget[] }>('/api/devices');
      setTargets(res.targets ?? []);
    } catch (err) {
      log.warn('settings', 'cloud pair card: targets fetch failed', { error: String(err) });
      setTargets([]);
    }
  }, []);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  const cloudTarget = targets?.find((t) => t.kind === 'cloud');

  return (
    <div className="cloud-pair-card">
      <h4 className="cloud-pair-title">Connect your phone</h4>
      <p className="cloud-pair-note">
        {cloudTarget
          ? <>Pairing against <code>{cloudTarget.origin.replace(/^https?:\/\//, '')}</code> — this QR works from anywhere, including cellular.</>
          : targets === null
            ? 'Checking which addresses are reachable…'
            : <>No cloud address is registered yet. Give sync a moment to settle, then reload — pairing needs the companion{domain ? ` at ${domain}` : ''} to be reachable.</>}
      </p>

      {!created && (
        <div className="devices-add-row">
          <input
            type="text"
            value={name}
            placeholder="Device name (e.g. iPhone)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (cloudTarget) void mint({ name, target: 'cloud' });
              }
            }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !name.trim() || !cloudTarget}
            onClick={() => void mint({ name, target: 'cloud' })}
          >
            {busy ? 'Pairing…' : 'Show pairing QR'}
          </button>
        </div>
      )}

      {error && <p className="devices-error">{error}</p>}
      {created && qrDataURL && (
        <PairingQrBlock created={created} qrDataURL={qrDataURL} onDismiss={dismiss} />
      )}
    </div>
  );
}
