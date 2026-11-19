/**
 * A feature a session's host cannot give right now, said in place of it (the user,
 * 2026-11-18: "make sure all feature is availble. no matter the connection type"). A
 * connection is an abstraction: a feature is unavailable only when it truly cannot work
 * (a daemon too old for it, the host not connected), and then the surface keeps its
 * chip or row and says why and how to fix it, never hides it.
 *
 * The fix is by how the host's daemon is updated, in the server's own sentence (the host
 * frame's `daemonUpdateHow`, providers/daemon-update-paths.ts daemonUpdateHowSentence), with
 * the "Update the daemon" button where a host-network machine takes one. daemonUpdatePath
 * is only the fallback for an older server that sends no sentence.
 */
import { useState, type ReactNode } from 'react';
import { requestHostDaemonUpdate } from '@/api/hosts';
import { ApiError } from '@/api/api-error';
import { useHostDisplayLabel, useHostRoute } from '@/hooks/useHostDisplayLabel';
import { useHostStatus } from '@/hooks/useHostStatus';
import type { HostRoute } from '@/utils/host-display-label';
import { log } from '@/utils/log';

/**
 * How the daemon of a host reached this way gets updated, for an older server whose host frame
 * has no `daemonUpdateHow` (none for a host-network machine: it has the button).
 */
export function daemonUpdatePath(route: HostRoute, name: string): string | null {
  if (route === 'host-network') return null;
  if (route === 'cloud') return 'Deploying the cloud companion updates the daemon there.';
  if (route === 'local') return 'Walnut updates this machine\'s daemon itself when it starts: restart Walnut to update it.';
  return `Walnut updates the daemon on ${name} itself the next time it connects there.`;
}

/** The fix line under a "the daemon needs an update" sentence: the button where one exists, else how it updates. */
export function DaemonUpdateFix({ host }: { host: string | null | undefined }) {
  const route = useHostRoute(host);
  const name = useHostDisplayLabel(host);
  const serverHow = useHostStatus(host)?.daemonUpdateHow;
  const [ask, setAsk] = useState<{ state: 'idle' | 'asking' | 'done' | 'failed'; text?: string }>({ state: 'idle' });
  const how = serverHow ? (/[.!?]$/.test(serverHow) ? serverHow : `${serverHow}.`) : daemonUpdatePath(route, name);
  const fixLine = how ? <p className="session-code-error-hint" data-testid="host-feature-fix">{how}</p> : null;
  if (route !== 'host-network' || !host) return fixLine;
  const update = () => {
    setAsk({ state: 'asking' });
    requestHostDaemonUpdate(host).then((r) => {
      setAsk({ state: 'done', text: r.message || `Updating the daemon on ${name}; this comes back by itself once the new one is up.` });
    }).catch((err: unknown) => {
      const body = err instanceof ApiError ? (err.body as { error?: string } | undefined) : undefined;
      const text = body?.error ?? (err instanceof Error ? err.message : String(err));
      log.warn('host-feature', 'daemon update ask failed', { host, error: text });
      setAsk({ state: 'failed', text });
    });
  };
  return (
    <>
      {fixLine}
      <button type="button" className="session-code-btn" data-testid="host-feature-update-daemon"
        disabled={ask.state === 'asking' || ask.state === 'done'} onClick={update}>
        {ask.state === 'asking' ? 'Asking…' : ask.state === 'done' ? 'Update started' : 'Update the daemon'}
      </button>
      {ask.text && <p className="session-code-error-hint" role="status" data-testid="host-feature-update-answer">{ask.text}</p>}
    </>
  );
}

/** The card a view shows in place of a feature its host cannot give: what, why, and the fix. */
export function HostFeatureUnavailable({ host, title, why, fix = 'daemon-update', testId }: {
  host: string | null | undefined;
  title: string;
  /** The server's sentence (a host frame's terminalWhy, a servers answer's why). */
  why: string;
  /** 'daemon-update': the daemon is too old; 'none': nothing to do here (the host is away). */
  fix?: 'daemon-update' | 'none';
  testId?: string;
}) {
  return (
    <div className="session-code-error-card" data-testid={testId ?? 'host-feature-unavailable'}>
      <div className="session-code-error-title">{title}</div>
      <p className="session-code-error-body" data-testid="host-feature-why">{/[.!?]$/.test(why) ? why : `${why}.`}</p>
      {fix === 'daemon-update' && <DaemonUpdateFix host={host} />}
    </div>
  );
}

/**
 * The Terminal tab of a session whose host cannot open a terminal yet (its status frame's
 * `terminal: false`): the tab's own bar, then why and the fix. No pty is opened.
 */
export function TerminalUnavailableView({ host, why, barRightSlot }: { host: string | null | undefined; why: string; barRightSlot?: ReactNode }) {
  const name = useHostDisplayLabel(host);
  return (
    <div className="session-code-panel" data-testid="terminal-unavailable">
      <div className="session-code-header">
        <div className="session-code-title"><span className="session-code-label">Terminal</span></div>
        <div className="session-code-actions">{barRightSlot}</div>
      </div>
      <HostFeatureUnavailable host={host} title={`No terminal on ${name} yet`} why={why} testId="terminal-unavailable-card" />
    </div>
  );
}
