/**
 * Live host-connect banner: what Walnut is doing with each remote host right now
 * ("Opening an SSH connection to devbox-a…", 12s), in the setup banner's card
 * style. State and timing rules live in utils/host-connect-banner.ts; the store
 * is useHostConnectBanner. `compact` is the draft column mount.
 */
import { useCallback, useState } from 'react';
import { connectHost } from '@/api/hosts';
import { seedHostStatus } from '@/hooks/useHostStatus';
import { dismissHostConnectBanner, useHostConnectBanner } from '@/hooks/useHostConnectBanner';
import { activeStepLabel, connectNote, connectSteps, formatElapsed, hostStatusText } from '@/utils/host-connect';
import { bannerTitle, type BannerRow } from '@/utils/host-connect-banner';
import { hostDisplayLabel } from '@/utils/host-display-label';
import { log } from '@/utils/log';
import '@/styles/host-connect-banner.css';

interface RetryState {
  busy: boolean;
  message?: string;
  hideRetry?: boolean;
  settings?: boolean;
  /** The failure the outcome is about: a newer failure frame clears it. */
  about?: BannerRow['status'];
}

const labelOf = (row: BannerRow): string => hostDisplayLabel(row.host, row.status.label);

/** The phase sentence already names the host on most phases; prefix it only when it does not. */
function withHost(label: string, text: string): string {
  return text.includes(label) ? text : `${label}: ${text}`;
}

export function HostConnectBanner({ compact, onNavigateSettings }: {
  compact?: boolean;
  onNavigateSettings?: (hash?: string) => void;
}) {
  const view = useHostConnectBanner();
  const [retry, setRetry] = useState<Record<string, RetryState>>({});

  const onRetry = useCallback((host: string, label: string, about: BannerRow['status']) => {
    setRetry((r) => ({ ...r, [host]: { busy: true } }));
    connectHost(host)
      .then((status) => {
        seedHostStatus(status);
        setRetry((r) => ({ ...r, [host]: { busy: false } }));
      })
      .catch((err: { status?: number; message?: string; body?: { code?: string } }) => {
        log.warn('host-banner', 'retry failed', { host, status: err?.status, error: String(err?.message ?? err) });
        const next: RetryState = { busy: false, about };
        if (err?.status === 409 && err.body?.code === 'host_disabled') {
          next.message = `${label} is disabled. Enable it in Settings › Remote Hosts.`;
          next.hideRetry = true;
          next.settings = true;
        } else if (err?.status === 404) {
          next.message = `${label} is no longer in your hosts config.`;
          next.hideRetry = true;
        } else if (err?.status) {
          next.message = err.message || 'Could not retry right now.';
        } else {
          next.message = "Couldn't reach Walnut to retry. Try again.";
        }
        setRetry((r) => ({ ...r, [host]: next }));
      });
  }, []);

  if (view.mode === 'hidden') return null;
  const title = bannerTitle(view, (h) => hostDisplayLabel(h, view.rows.find((r) => r.host === h)?.status.label));

  return (
    <div
      className={`setup-banner host-connect-banner${compact ? ' host-connect-banner-compact' : ''}`}
      data-testid="host-connect-banner"
      data-state={view.mode}
      role="status"
      aria-live="polite"
    >
      <div className="setup-banner-header">
        <span className="setup-banner-title host-connect-title">
          {view.mode === 'success' && <span className="host-connect-ok" aria-hidden="true">✓ </span>}
          {title}
        </span>
        <button
          type="button"
          className="setup-banner-dismiss"
          onClick={dismissHostConnectBanner}
          aria-label="Dismiss host connection status"
          title="Hide until a host starts connecting again"
        >
          &times;
        </button>
      </div>
      {view.mode !== 'success' && (
        <ul className="host-connect-rows">
          {view.rows.map((row) => {
            const label = labelOf(row);
            const saved = row.state === 'failed' ? retry[row.host] : undefined;
            // A retry outcome speaks for the failure it answered, not a later one.
            const r = saved && (saved.busy || saved.about === row.status) ? saved : undefined;
            return (
              <li key={row.host} className="host-connect-row" data-host={row.host} data-state={row.state}>
                <div className="host-connect-row-main">
                  {row.state === 'connected' ? (
                    <span className="host-connect-line"><span className="host-connect-ok" aria-hidden="true">✓</span> {label} connected</span>
                  ) : row.state === 'failed' ? (
                    <span className="host-connect-line">{withHost(label, row.status.error || 'Could not connect')}</span>
                  ) : row.state === 'queued' ? (
                    <span className="host-connect-line">{label}: waiting for another host to finish</span>
                  ) : (
                    <span className="host-connect-line">{withHost(label, hostStatusText(row.status))}</span>
                  )}
                  <RowDetail row={row} retry={r} />
                </div>
                {(row.state === 'connecting' || row.state === 'reconnecting') && (
                  <span className="host-connect-spinner" aria-hidden="true" />
                )}
                {row.state === 'failed' && !r?.hideRetry && (
                  <button
                    type="button"
                    className="setup-step-btn host-connect-retry"
                    disabled={!!r?.busy}
                    aria-label={`Retry connecting to ${label}`}
                    onClick={() => onRetry(row.host, label, row.status)}
                  >
                    {r?.busy ? 'Retrying…' : 'Retry'}
                  </button>
                )}
                {r?.settings && onNavigateSettings && (
                  <button type="button" className="setup-step-btn" onClick={() => onNavigateSettings('#remote-hosts')}>
                    Open Settings
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RowDetail({ row, retry }: { row: BannerRow; retry?: RetryState }) {
  if (row.state === 'connected') return null;
  if (row.state === 'failed') {
    const countdown = row.retryInMs === undefined ? null
      : row.retryInMs > 0 ? `Walnut retries by itself in ${formatElapsed(row.retryInMs)}` : 'Retrying…';
    return (
      <>
        {row.status.hint && <span className="host-connect-sub">{row.status.hint}</span>}
        {retry?.message && <span className="host-connect-sub host-connect-retry-msg">{retry.message}</span>}
        {countdown && <span className="host-connect-sub" aria-hidden="true">{countdown}</span>}
      </>
    );
  }
  const step = row.state === 'queued' ? 'Queued' : row.state === 'reconnecting' ? 'Reconnecting' : activeStepLabel(row.status);
  const note = row.state === 'connecting' ? connectNote(row.status, connectSteps(row.status)) : undefined;
  return (
    <>
      <span className="host-connect-sub" aria-hidden="true">{step} · {formatElapsed(row.elapsedMs)}</span>
      {note && <span className="host-connect-sub">{note}</span>}
    </>
  );
}
