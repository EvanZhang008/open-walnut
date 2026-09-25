/**
 * Terminal mode notices: the "Not persistent" badge and inline notice for a
 * plain shell (dtach unavailable on the target), and the blocking card for an
 * ssh failure. Kept free of xterm so they render in unit tests.
 *
 * WHY a plain shell gets a badge AND a notice: it dies with its connection,
 * which the user must know before starting a long build in it. The badge stays
 * visible in the header row; the notice names the fix and offers Retry, which
 * re-probes and upgrades to a persistent shell once dtach can be built.
 */

import { useCallback, useState } from 'react';
import type { TerminalOpenPlain, TerminalSshFailed } from '@/api/terminal';

/** Copies exactly `command` (never the surrounding prose). */
export function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [command]);
  return (
    <button className="session-terminal-btn" onClick={onCopy} title={`Copy: ${command}`}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function TerminalPlainBadge({ plain }: { plain: TerminalOpenPlain }) {
  return (
    <span className="session-terminal-status session-terminal-plain-badge" title={plain.installHint} data-testid="terminal-not-persistent">
      Not persistent
    </span>
  );
}

interface PlainNoticeProps {
  plain: TerminalOpenPlain;
  retrying: boolean;
  onRetry: () => void;
}

export function TerminalPlainNotice({ plain, retrying, onRetry }: PlainNoticeProps) {
  const where = plain.host ?? 'this machine';
  const cmd = <code>{plain.installCommand}</code>;
  return (
    <div className="session-terminal-plain-notice" role="status" data-testid="terminal-plain-notice">
      <div className="session-terminal-plain-row">
        <span className="session-terminal-plain-text">
          {plain.reason === 'build_failed' ? (
            <>dtach failed to build on {where}. This shell will not survive a disconnect. Install the development headers (e.g. {cmd}) and click Retry to enable persistence.</>
          ) : (
            <>This shell will not survive a disconnect. Install a C compiler on {where} (e.g. {cmd}) and click Retry to enable persistence.</>
          )}
        </span>
        <CopyCommandButton command={plain.installCommand} />
        <button className="session-terminal-btn" onClick={onRetry} disabled={retrying} title="Check for dtach again; if it can be built, this shell is replaced by a persistent one">
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
      {plain.reason === 'build_failed' && plain.detail && (
        <details className="session-terminal-plain-details">
          <summary>Details</summary>
          <pre>{plain.detail}</pre>
        </details>
      )}
    </div>
  );
}

export function TerminalSshFailedCard({ failed, onRetry }: { failed: TerminalSshFailed; onRetry: () => void }) {
  return (
    <div className="session-terminal-error-card" data-testid="terminal-ssh-failed">
      <div className="session-terminal-error-icon">&#x26A0;&#xFE0F;</div>
      <div className="session-terminal-error-title">Can't start terminal: ssh to {failed.host} failed</div>
      <p className="session-terminal-error-body">{failed.hint}</p>
      {failed.detail && <pre className="session-terminal-ssh-detail">{failed.detail}</pre>}
      <button className="session-terminal-btn session-terminal-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
