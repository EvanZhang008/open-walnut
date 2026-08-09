/**
 * The one-time QR block for a freshly minted device token. Shared by
 * Settings → Devices and the Cloud Companion section's pairing card, so both
 * surfaces show the same wording, the same manual-token fallback, and the same
 * "shown once" warning.
 */

import type { CreatedDevice } from './usePairDevice';

interface Props {
  created: CreatedDevice;
  qrDataURL: string;
  onDismiss: () => void;
  dismissLabel?: string;
}

export function PairingQrBlock({ created, qrDataURL, onDismiss, dismissLabel = 'Done' }: Props) {
  return (
    <div className="devices-qr-block">
      <img src={qrDataURL} alt={`Pairing QR code for ${created.name}`} width={260} height={260} />
      <p className="devices-qr-hint">
        Scan with the Walnut iOS app (Setup → Scan QR). Shown once — the
        server keeps only a hash.
        {created.server && (
          <>
            <br />
            Points at <code>{created.server.replace(/^https?:\/\//, '')}</code>
          </>
        )}
      </p>
      <details>
        <summary>Manual token</summary>
        <code className="devices-token">{created.token}</code>
      </details>
      <button type="button" className="btn-primary" onClick={onDismiss}>
        {dismissLabel}
      </button>
    </div>
  );
}
