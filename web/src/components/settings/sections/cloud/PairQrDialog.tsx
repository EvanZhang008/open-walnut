/**
 * The pairing QR in front of the user (Settings › Phones & Cloud): a dialog that
 * first asks, when the code replaces a paired phone's one, then shows the code
 * with how to scan it. A new device skips the ask. The token exists only in this
 * dialog (it is shown once), so closing it is the same as Done.
 *
 * While a code is being made the dialog cannot be closed: the old token is being
 * replaced, and a dialog closed mid-way would leave a phone signed out with no code.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { CopyButton } from '../../inputs/CopyButton';
import type { CreatedDevice } from './usePairDevice';
import '@/styles/devices-ways.css';

export type PairQrPhase = 'ask' | 'working' | 'shown' | 'failed';

interface Props {
  name: string;
  phase: PairQrPhase;
  /** A new code for a phone already paired (asks first, and says to Disconnect). */
  repair: boolean;
  /** "Uses the cloud companion, so it works from anywhere." */
  reach?: string;
  created: CreatedDevice | null;
  qrDataURL: string | null;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** In the words of the app's own Setup screen. */
export const SCAN_STEPS_NEW = ['Open the Walnut app on the phone.', 'Tap Scan QR from your console and point the camera at this code.'];
export const SCAN_STEPS_REPAIR = [
  'Open the Walnut app on the phone.',
  'If it is still signed in, tap Settings, then Disconnect.',
  'Tap Scan QR from your console and point the camera at this code.',
];

export function PairQrDialog({ name, phase, repair, reach, created, qrDataURL, error, onConfirm, onClose }: Props) {
  const working = phase === 'working';
  const close = () => { if (!working) onClose(); };
  useModalOverlay(close);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // The default action takes focus at every step, so Enter does the obvious thing;
  // with none (a new code being made), the dialog itself holds focus.
  useEffect(() => {
    const t = setTimeout(() => (primaryRef.current ?? boxRef.current)?.focus(), 10);
    return () => clearTimeout(t);
  }, [phase]);
  // A click beside the code never closes it: it is the only copy of the token.
  const onBackdrop = () => { if (phase !== 'shown') close(); };

  const title = phase === 'shown' ? `Scan with ${name}` : repair ? `New QR code for ${name}` : `QR code for ${name}`;
  const steps = repair ? SCAN_STEPS_REPAIR : SCAN_STEPS_NEW;

  return createPortal(
    <div className="app-modal-overlay" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onBackdrop}>
      <div ref={boxRef} tabIndex={-1} className="app-modal devices-qr-dialog" data-phase={phase} data-qr-for={name} onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">{title}</div>
        {reach && phase !== 'shown' && <div className="devices-qr-dialog-sub">{reach}</div>}

        {(phase === 'ask' || (repair && working)) && (
          <p className="devices-qr-dialog-note" data-testid="devices-show-qr-warning">
            {`This replaces the code ${name} signed in with. The app stops connecting until it scans the new one.`}
          </p>
        )}
        {!repair && working && <p className="devices-qr-dialog-sub">Making the code...</p>}
        {phase === 'failed' && (
          <p className="settings-row-error devices-qr-dialog-error" role="alert">{`Couldn't make the code: ${error ?? 'unknown error'}`}</p>
        )}

        {phase === 'shown' && created && qrDataURL && (
          <>
            <img className="devices-qr-dialog-img" src={qrDataURL} alt={`Pairing QR code for ${name}`} width={220} height={220} />
            <ol className="devices-qr-dialog-steps devices-qr-hint">
              {steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
            <p className="devices-qr-dialog-sub">
              It is shown once; the server keeps only a hash.
              {created.server && <>{' '}Points at <code>{created.server.replace(/^https?:\/\//, '')}</code>.</>}
            </p>
            <details className="devices-qr-dialog-manual">
              <summary>Can't scan it?</summary>
              <p className="devices-qr-dialog-sub">On the app's Setup screen, enter the address above and paste this token.</p>
              <span className="devices-qr-dialog-token">
                <code className="devices-token settings-addons-mono">{created.token}</code>
                <CopyButton text={created.token} />
              </span>
            </details>
          </>
        )}

        <div className="app-modal-actions">
          {phase === 'shown' ? (
            <button ref={primaryRef} tabIndex={0} className="app-modal-btn primary" onClick={onClose} data-testid="devices-qr-done">Done</button>
          ) : (
            <>
              <button tabIndex={0} className="app-modal-btn" onClick={onClose} disabled={working} data-testid="devices-show-qr-cancel">Cancel</button>
              {(repair || phase === 'failed') && (
                <button
                  ref={primaryRef}
                  tabIndex={0}
                  className="app-modal-btn primary"
                  onClick={onConfirm}
                  disabled={working}
                  data-testid="devices-show-qr-confirm"
                >
                  {working ? 'Making QR...' : phase === 'failed' ? 'Try again' : 'Show new QR'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
