/**
 * A plugin's account link, on the plugin's own row in Settings → Plugins.
 *
 * Two sources in one line: the plugin's own view of its credential (signed in
 * as whom, renews on its own until when, or needs a new sign-in) and what
 * Walnut's sync loop last saw (ok N minutes ago / failing since). Together they
 * answer the question the notification card raises: is this a dead credential
 * I must fix, or a provider outage sync will ride out by itself.
 *
 * Sign in is the device-code flow: POST starts it, the panel shows the code and
 * the link, and polls the status until the plugin reports 'connected' (or the
 * code expires). Nothing here ever needs the terminal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';

export type ConnectionState = 'connected' | 'signing-in' | 'sign-in-required' | 'unreachable' | 'not-configured';

export interface ConnectionReport {
  pluginId: string;
  pluginName: string;
  state: ConnectionState;
  account?: string;
  detail?: string;
  credentialExpiresAt?: string;
  signIn?: { userCode: string; verificationUri: string; message?: string; expiresAt: string; startedAt: string };
  lastFailureAt?: string;
  canSignIn: boolean;
  sync: {
    lastOkAt?: string;
    lastFailureAt?: string;
    lastError?: string;
    lastFailureKind?: string;
    consecutiveFailures: number;
  } | null;
}

/** One word per state, the same word the row badge uses. */
export const CONNECTION_BADGE: Record<ConnectionState, { label: string; className: string }> = {
  connected: { label: 'signed in', className: 'badge badge-done' },
  'signing-in': { label: 'signing in…', className: 'badge badge-important' },
  'sign-in-required': { label: 'sign in needed', className: 'badge badge-immediate' },
  unreachable: { label: 'provider unreachable', className: 'badge badge-important' },
  'not-configured': { label: 'not set up', className: 'badge badge-none' },
};

const SIGNING_IN_POLL_MS = 4000;

function relative(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diff = t - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? [Math.round(abs / 1000), 's'] as const
    : abs < 3_600_000 ? [Math.round(abs / 60_000), 'min'] as const
    : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h'] as const
    : [Math.round(abs / 86_400_000), 'd'] as const;
  const text = `${unit[0]} ${unit[1]}`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

function clock(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  pluginId: string;
  /** The first report, when the parent already fetched the list. */
  initial?: ConnectionReport;
  /** Called with every fresh report so the row badge follows the panel. */
  onReport?: (report: ConnectionReport) => void;
}

export function PluginConnectionPanel({ pluginId, initial, onReport }: Props) {
  const [report, setReport] = useState<ConnectionReport | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/integrations/${encodeURIComponent(pluginId)}/connection`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = await res.json() as ConnectionReport;
      if (!mounted.current) return;
      setReport(next);
      setError(null);
      onReport?.(next);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pluginId, onReport]);

  // The parent's list refresh (plugin toggled, another tab changed something) is
  // a fresh report too; without this the panel would keep its first snapshot.
  useEffect(() => {
    if (initial) setReport(initial);
    else void load();
  }, [initial, load]);

  // The sync loop's success is what flips sign-in-required back to connected
  // without anyone clicking; it broadcasts a runtime change, and so does a
  // plugin reload after the user filled in a client id.
  useEvent('plugin:runtime-changed', () => { void load(); });

  // While a device code is outstanding, ask until the plugin says connected or
  // the code has expired. The relative times on the line tick with the same clock.
  const signingIn = report?.state === 'signing-in';
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      if (signingIn) void load();
    }, signingIn ? SIGNING_IN_POLL_MS : 30_000);
    return () => clearInterval(id);
  }, [signingIn, load]);

  const startSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/integrations/${encodeURIComponent(pluginId)}/connection/sign-in`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const copyCode = (code: string) => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => { if (mounted.current) setCopied(false); }, 2000);
  };

  if (!report) {
    return (
      <div className="plugin-connection" data-testid={`plugin-connection-${pluginId}`}>
        <span className="plugin-connection-line">{error ? `Connection status unavailable (${error}).` : 'Checking account…'}</span>
      </div>
    );
  }

  const badge = CONNECTION_BADGE[report.state] ?? { label: report.state, className: 'badge badge-none' };
  const renewsUntil = clock(report.credentialExpiresAt);
  const lastOk = relative(report.sync?.lastOkAt, now);
  const lastFail = relative(report.sync?.lastFailureAt, now);
  // Offered only when a sign-in is what fixes it. An unreachable provider gets no
  // button: the device-code flow would fail against the same endpoint, and the
  // button itself would say "re-auth" about an outage.
  const showSignIn = report.canSignIn
    && (report.state === 'sign-in-required' || report.state === 'signing-in');

  return (
    <div
      className={`plugin-connection plugin-connection--${report.state}`}
      data-testid={`plugin-connection-${pluginId}`}
      data-connection-state={report.state}
    >
      <div className="plugin-connection-row">
        <span className="plugin-connection-line">
          <span>Account:</span>
          <span className={badge.className} data-testid={`plugin-connection-badge-${pluginId}`}>{badge.label}</span>
          {report.account && <strong title={report.account}>{report.account}</strong>}
          {report.state === 'connected' && renewsUntil && (
            <span className="plugin-connection-muted">renews automatically · valid until {renewsUntil}</span>
          )}
          {report.state === 'connected' && lastOk && (
            <span className="plugin-connection-muted">· last sync {lastOk}</span>
          )}
        </span>
        <span className="plugin-connection-actions">
          {showSignIn && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid={`plugin-sign-in-${pluginId}`}
              disabled={busy || report.state === 'signing-in'}
              onClick={() => void startSignIn()}
            >
              {busy ? 'Starting…' : report.state === 'signing-in' ? 'Waiting for you…' : 'Sign in'}
            </button>
          )}
        </span>
      </div>

      {/* The plugin's own sentence about what is wrong, when something is. */}
      {report.state !== 'connected' && report.state !== 'signing-in' && report.detail && (
        <div className="plugin-connection-detail" data-testid={`plugin-connection-detail-${pluginId}`}>{report.detail}</div>
      )}

      {/* What the sync loop saw. Only spoken when it disagrees with "fine": a
          healthy line already carries the last-sync time above. */}
      {report.sync && report.sync.consecutiveFailures > 0 && (
        <div className="plugin-connection-detail plugin-connection-sync" data-testid={`plugin-connection-sync-${pluginId}`}>
          Sync has failed {report.sync.consecutiveFailures} time{report.sync.consecutiveFailures === 1 ? '' : 's'} in a row
          {lastFail ? ` (last ${lastFail})` : ''}
          {report.sync.lastError ? `: ${report.sync.lastError}` : '.'}
          {report.sync.lastFailureKind === 'unreachable' && ' Sync keeps retrying on its own; no sign-in needed.'}
          {report.sync.lastFailureKind !== 'unreachable' && lastOk ? ` Last good sync ${lastOk}.` : ''}
        </div>
      )}

      {/* The device code the human types at the provider. Stays until the plugin
          reports connected or the code expires; the panel polls meanwhile. */}
      {report.state === 'signing-in' && report.signIn && (
        <div className="plugin-connection-signin" data-testid={`plugin-signin-prompt-${pluginId}`}>
          <div>
            Open <a href={report.signIn.verificationUri} target="_blank" rel="noreferrer">{report.signIn.verificationUri}</a> and enter this code:
          </div>
          <div className="plugin-connection-code-row">
            <code className="plugin-connection-code" data-testid={`plugin-signin-code-${pluginId}`}>{report.signIn.userCode}</code>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => copyCode(report.signIn!.userCode)}
            >
              {copied ? 'Copied' : 'Copy code'}
            </button>
            <span className="plugin-connection-muted">
              Code expires {relative(report.signIn.expiresAt, now) ?? 'soon'}. This panel updates by itself once you finish.
            </span>
          </div>
        </div>
      )}

      {error && <div className="plugin-connection-error" data-testid={`plugin-connection-error-${pluginId}`}>{error}</div>}
    </div>
  );
}
