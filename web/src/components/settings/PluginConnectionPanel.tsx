/**
 * A plugin's account link: indented rows under the plugin's own row in
 * Settings: Plugins (the same group, never a box of its own).
 *
 * Two sources in one line: the plugin's own view of its credential (signed in
 * as whom, renews on its own until when, or needs a new sign-in) and what
 * Walnut's sync loop last saw (last synced at / failing since). Together they
 * answer the question the notification card raises: is this a dead credential
 * I must fix, or a provider outage sync will ride out by itself.
 *
 * Sign in is the device-code flow: POST starts it, the panel shows the code and
 * the link, and polls the status until the plugin reports 'connected' (or the
 * code expires). Nothing here ever needs the terminal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { SettingsRow, SettingsTag } from './SettingsSection';
import { SettingsButton } from './inputs/SettingsButton';
import { CopyButton } from './inputs/CopyButton';
import { formatAbsoluteTime } from './sections/addons-format';
import '@/styles/settings-sections-addons.css';

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

export type TagTone = 'neutral' | 'warning' | 'success';

/** One tag per state, the same words the plugin row uses. */
export const CONNECTION_BADGE: Record<ConnectionState, { label: string; tone: TagTone; help: string }> = {
  connected: { label: 'Signed in', tone: 'success', help: '' },
  'signing-in': { label: 'Signing in...', tone: 'neutral', help: 'Waiting for you to finish signing in.' },
  'sign-in-required': { label: 'Sign in needed', tone: 'warning', help: 'Sign in again to keep syncing.' },
  unreachable: { label: "Can't reach the provider", tone: 'warning', help: "Can't reach the provider right now." },
  'not-configured': { label: 'Not set up', tone: 'neutral', help: 'Add the missing settings under Configure.' },
};

/** `Renews automatically, last synced 11:44 PM`: absolute times, never `ago`. */
export function connectedHelp(report: Pick<ConnectionReport, 'credentialExpiresAt' | 'sync'>, now?: Date): string {
  const parts: string[] = [];
  if (report.credentialExpiresAt) parts.push('Renews automatically');
  if (report.sync?.lastOkAt) parts.push(`last synced ${formatAbsoluteTime(report.sync.lastOkAt, now)}`);
  const text = parts.join(', ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

const SIGNING_IN_POLL_MS = 4000;

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
  const [, setNow] = useState(() => Date.now());
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
  // A sync failure or recovery arrives as a notification keyed `plugin:<id>`; it is
  // the only signal that the failure streak changed, so the Sync row clears live.
  const onNotice = (data: unknown) => {
    if ((data as { recoveryKey?: string } | undefined)?.recoveryKey === `plugin:${pluginId}`) void load();
  };
  useEvent('notification:updated', onNotice);
  useEvent('notification:new', onNotice);

  // While a device code is outstanding, ask until the plugin says connected or
  // the code has expired.
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

  if (!report) {
    return (
      <div className="settings-addons-rows plugin-connection" data-testid={`plugin-connection-${pluginId}`}>
        <SettingsRow
          indent
          label="Account"
          help={error ? `Couldn't read the account status: ${error}` : 'Checking account...'}
          state={error ? 'error' : undefined}
        />
      </div>
    );
  }

  const badge = CONNECTION_BADGE[report.state] ?? { label: report.state, tone: 'neutral' as const, help: '' };
  // Offered only when a sign-in is what fixes it. An unreachable provider gets
  // Retry instead: the device-code flow would fail against the same endpoint.
  const showSignIn = report.canSignIn && report.state === 'sign-in-required';
  const accountHelp = report.state === 'connected'
    ? connectedHelp(report)
    : badge.help;

  return (
    <div
      className={`settings-addons-rows plugin-connection plugin-connection--${report.state}`}
      data-testid={`plugin-connection-${pluginId}`}
      data-connection-state={report.state}
    >
      <SettingsRow
        indent
        className="plugin-connection-row"
        label={
          <span className="settings-addons-inline">
            <span>Account</span>
            {report.account && (
              <span className="settings-addons-ellipsis settings-addons-account" title={report.account}>{report.account}</span>
            )}
          </span>
        }
        help={accountHelp || undefined}
        control={
          <>
            <span data-testid={`plugin-connection-badge-${pluginId}`}>
              <SettingsTag tone={badge.tone}>{badge.label}</SettingsTag>
            </span>
            {showSignIn && (
              <SettingsButton
                variant="primary"
                data-testid={`plugin-sign-in-${pluginId}`}
                busy={busy}
                busyLabel="Starting..."
                onClick={() => void startSignIn()}
              >
                Sign in
              </SettingsButton>
            )}
            {report.state === 'unreachable' && (
              <SettingsButton data-testid={`plugin-connection-retry-${pluginId}`} onClick={() => void load()}>
                Retry
              </SettingsButton>
            )}
          </>
        }
      />

      {/* The plugin's own sentence about what is wrong, when something is. */}
      {report.state !== 'connected' && report.state !== 'signing-in' && report.detail && (
        <SettingsRow
          indent
          className="plugin-connection-detail"
          data-testid={`plugin-connection-detail-${pluginId}`}
          label="Reason"
          help={report.detail}
        />
      )}

      {/* What the sync loop saw. Only spoken when it disagrees with "fine": a
          healthy account row already carries the last-sync time. */}
      {report.sync && report.sync.consecutiveFailures > 0 && (
        <SettingsRow
          indent
          className="plugin-connection-sync"
          data-testid={`plugin-connection-sync-${pluginId}`}
          label="Sync"
          state="warning"
          help={
            `Sync has failed ${report.sync.consecutiveFailures} time${report.sync.consecutiveFailures === 1 ? '' : 's'} in a row` +
            (report.sync.lastFailureAt ? `, last at ${formatAbsoluteTime(report.sync.lastFailureAt)}` : '') +
            (report.sync.lastError ? `: ${report.sync.lastError}` : '.') +
            (report.sync.lastFailureKind === 'unreachable' ? ' It keeps retrying on its own.' : '')
          }
        />
      )}

      {/* The device code the human types at the provider. Stays until the plugin
          reports connected or the code expires; the rows poll meanwhile. */}
      {report.state === 'signing-in' && report.signIn && (
        <div className="settings-addons-rows plugin-connection-signin" data-testid={`plugin-signin-prompt-${pluginId}`}>
          <SettingsRow
            indent
            label="Code"
            help={`Expires at ${formatAbsoluteTime(report.signIn.expiresAt)}; this updates by itself once you finish.`}
            control={
              <>
                <code className="settings-addons-mono plugin-connection-code" data-testid={`plugin-signin-code-${pluginId}`}>
                  {report.signIn.userCode}
                </code>
                <CopyButton text={report.signIn.userCode} />
              </>
            }
          />
          <SettingsRow
            indent
            label="Sign-in page"
            help={<span className="settings-addons-mono">{report.signIn.verificationUri}</span>}
            control={
              <a
                className="settings-button settings-button-primary"
                href={report.signIn.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                <span className="settings-button-stack">
                  <span className="settings-button-label">Open sign-in page</span>
                </span>
              </a>
            }
          />
        </div>
      )}

      {error && (
        <p className="settings-row-error settings-row-error-indent" role="alert" data-testid={`plugin-connection-error-${pluginId}`}>
          {error}
        </p>
      )}
    </div>
  );
}
