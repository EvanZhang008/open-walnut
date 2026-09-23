/**
 * The one-time QR rows for a freshly minted device token. Shared by
 * Settings: Phones & Cloud and the Cloud Companion section's pairing card, so
 * both surfaces show the same wording, the same manual-token fallback, and the
 * same "shown once" warning. Rendered as rows of the caller's group (no box):
 * the QR centered in its own row at most 200px wide.
 */

import { SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { CopyButton } from '../../inputs/CopyButton';
import type { CreatedDevice } from './usePairDevice';
import '@/styles/settings-sections-addons.css';

interface Props {
  created: CreatedDevice;
  qrDataURL: string;
  onDismiss: () => void;
  dismissLabel?: string;
}

export function PairingQrBlock({ created, qrDataURL, onDismiss, dismissLabel = 'Done' }: Props) {
  return (
    <div className="devices-qr-block settings-addons-contents">
      <div className="settings-row settings-row-stacked settings-addons-qr-row">
        <img src={qrDataURL} alt={`Pairing QR code for ${created.name}`} width={200} height={200} />
        <p className="devices-qr-hint settings-row-help">
          Scan with the Walnut iOS app under Setup, Scan QR; it is shown once and the server keeps only a hash.
          {created.server && (
            <>
              {' '}Points at <code>{created.server.replace(/^https?:\/\//, '')}</code>.
            </>
          )}
        </p>
      </div>
      <SettingsRow
        label="Manual token"
        help={<code className="devices-token settings-addons-mono">{created.token}</code>}
        control={<CopyButton text={created.token} />}
      />
      <SettingsRow
        label={`Pairing ${created.name}`}
        control={
          <SettingsButton variant="primary" onClick={onDismiss}>
            {dismissLabel}
          </SettingsButton>
        }
      />
    </div>
  );
}
