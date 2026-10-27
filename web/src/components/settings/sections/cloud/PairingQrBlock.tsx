/**
 * The one-time QR rows for a freshly minted device token. Shared by
 * Settings: Phones & Cloud and the Cloud Companion section's pairing card, so
 * both surfaces show the same wording, the same manual-token fallback, and the
 * same "shown once" warning. Rendered as rows of the caller's group (no box):
 * the QR centered in its own row at most 200px wide.
 */

import { useEffect, useRef } from 'react';
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
  /** A new QR for a phone already paired: its app may still be signed in with the old token. */
  repair?: boolean;
}

/** What to do with the code on the phone, in the words the app's Setup screen uses. */
export const QR_SCAN_HINT = 'Open the Walnut app on the phone, tap Scan QR from your console, and point the camera at this code.';
/** A paired phone shows Setup again only after it disconnects. */
export const QR_REPAIR_HINT = 'If the app is still signed in, tap Disconnect in its Settings first.';

export function PairingQrBlock({ created, qrDataURL, onDismiss, dismissLabel = 'Done', repair }: Props) {
  // The code appears where the user is looking: bring it into view when it lands
  // (the block itself is display:contents, so scroll its image).
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    imgRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [qrDataURL]);
  return (
    <div className="devices-qr-block settings-addons-contents" data-qr-for={created.name}>
      <div className="settings-row settings-row-stacked settings-addons-qr-row">
        <img ref={imgRef} src={qrDataURL} alt={`Pairing QR code for ${created.name}`} width={200} height={200} />
        <p className="devices-qr-hint settings-row-help" role="status">
          {QR_SCAN_HINT}
          {repair && <>{' '}{QR_REPAIR_HINT}</>}
          {' '}It is shown once; the server keeps only a hash.
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
