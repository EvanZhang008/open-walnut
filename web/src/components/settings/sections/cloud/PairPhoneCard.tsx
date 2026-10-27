/**
 * "Pair your phone" card, shown inline after a companion finishes setting up.
 *
 * Deliberately targets `cloud`: the whole point of having just built a companion
 * is a phone that works off Wi-Fi, and a LAN QR scanned over cellular can never
 * connect. It refuses to mint until /api/devices actually reports a cloud target;
 * otherwise the button would hand back a LAN credential that looks right and
 * silently fails on the road.
 */

import { useCallback, useEffect, useState } from 'react';
import { fetchDevicesList } from './devices-list';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { PairingQrBlock } from './PairingQrBlock';
import { usePairDevice, type PairingTarget } from './usePairDevice';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';

interface Props {
  /** Companion hostname, for the copy; pairing itself reads the server's target. */
  domain?: string;
}

export function PairPhoneCard({ domain }: Props) {
  const [targets, setTargets] = useState<PairingTarget[] | null>(null);
  // A name typed and not paired yet survives leaving the pane; a successful pairing ends it.
  const nameDraft = useDraft(draftKey('pair-device-name', 'cloud'), { baseline: 'iPhone' });
  const { text: name, setText: setName } = nameDraft;
  const { created, qrDataURL, error, busy, mint: mintQr, dismiss } = usePairDevice();
  const mint = async (args: Parameters<typeof mintQr>[0]) => {
    const sentKey = nameDraft.key;
    if (await mintQr(args)) nameDraft.clear(sentKey);
  };

  const loadTargets = useCallback(async () => {
    try {
      const res = await fetchDevicesList<{ targets?: PairingTarget[] }>();
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

  const note = cloudTarget
    ? <>Pairing against <code>{cloudTarget.origin.replace(/^https?:\/\//, '')}</code>; this QR works from anywhere, including cellular.</>
    : targets === null
      ? 'Checking which addresses are reachable...'
      : `No cloud address is registered yet; give sync a moment, then reload, because pairing needs the companion${domain ? ` at ${domain}` : ''} to be reachable.`;

  return (
    <SettingsGroup heading="Connect your phone" className="cloud-pair-card">
      {!created && (
        <SettingsRow
          label="Device name"
          htmlFor="cloud-pair-name"
          help={<span className="cloud-pair-note">{note}</span>}
          error={error ?? undefined}
          control={
            <span className="settings-addons-inline devices-add-row">
              <input
                id="cloud-pair-name"
                type="text"
                data-draft-key={nameDraft.key ?? undefined}
                className="settings-input settings-input--short"
                value={name}
                placeholder="Device name, for example iPhone"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (cloudTarget) void mint({ name, target: 'cloud' });
                  }
                }}
              />
              <SettingsButton
                variant="primary"
                disabled={!name.trim() || !cloudTarget}
                busy={busy}
                busyLabel="Pairing..."
                onClick={() => void mint({ name, target: 'cloud' })}
              >
                Show pairing QR
              </SettingsButton>
            </span>
          }
        />
      )}
      {created && error && <p className="settings-row-error devices-error" role="alert">{error}</p>}
      {created && qrDataURL && (
        <PairingQrBlock created={created} qrDataURL={qrDataURL} onDismiss={dismiss} />
      )}
    </SettingsGroup>
  );
}
