/**
 * The System zone's "Open Walnut" card: which version runs here and whether npm
 * has a newer one. Informational (never a banner: an update stops nothing), so
 * the card is neutral until a release is published, then wears the accent dot
 * the rail shows, with the one command that updates THIS install and a copy
 * button. A source checkout says so instead of a status, because its owner
 * updates it with git.
 */
import { useCallback, useState } from 'react';
import type { UpdateStatus } from '@/api/update';
import { StableButton } from './HostProblemRows';
import { updateCardView } from './update-card-view';



const CHECK_LABELS = ['Check now', 'Checking...'];

/** The command chip plus Copy / Copied (the same shape the setup banner uses). */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard blocked; the text stays selectable */ });
  }, [command]);
  const label = copied ? 'Copied' : 'Copy';
  return (
    <span className="setup-copy-wrap nfc-update-command">
      <code className="setup-command" onClick={handleCopy} title="Click to copy" data-testid="nfc-update-command">{command}</code>
      <button type="button" tabIndex={0} className="setup-copy-btn ab-copy-btn" onClick={handleCopy}
        aria-label={copied ? label : 'Copy command'} title={copied ? label : 'Copy command'} data-testid="nfc-update-copy">
        <span className="hpb-btn-stack" data-r1="Copied" data-r2="Copy"><span>{label}</span></span>
      </button>
    </span>
  );
}

export function NotificationUpdateCard({ status, checking, onCheck }: {
  status: UpdateStatus;
  checking: boolean;
  onCheck: () => void;
}) {
  const v = updateCardView(status);
  const busy = checking || status.checking;
  return (
    <div className="notification-card ok" data-testid="nfc-update" data-state={v.tone}>
      <div className="notification-card-row">
        <span className={`notification-card-icon ${v.tone === 'update' ? 'update' : v.tone === 'ok' ? 'ok' : ''}`}>{v.icon}</span>
        <span className="notification-card-label">Open Walnut</span>
        {v.canCheck && (
          <span className="nfc-update-action">
            <StableButton label={busy ? CHECK_LABELS[1]! : CHECK_LABELS[0]!} labels={CHECK_LABELS} onClick={onCheck}
              disabled={busy} secondary testId="nfc-update-check" ariaLabel="Check for a newer Open Walnut" />
          </span>
        )}
      </div>
      <div className="notification-card-details">
        <div className="notification-detail-row">
          <span>Version</span>
          <span className="notification-detail-value" data-testid="nfc-update-current">{status.current}</span>
        </div>
        <div className="notification-detail-row">
          <span>{v.statusLabel}</span>
          <span className={`notification-detail-value${v.statusClass === 'ok' ? ' ok' : v.statusClass === 'accent' ? ' nfc-update-accent' : ''}`} data-testid="nfc-update-status">{v.status}</span>
        </div>
        {v.command && (
          <div className="notification-detail-row nfc-update-command-row">
            <CopyCommand command={v.command} />
          </div>
        )}
        {v.note && (
          <div className="notification-detail-row muted">
            <span className="nfc-update-note" data-testid="nfc-update-note">{v.note}</span>
          </div>
        )}
      </div>
    </div>
  );
}
