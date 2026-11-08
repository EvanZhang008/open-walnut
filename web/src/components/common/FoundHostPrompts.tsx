import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchFreshConfig } from '@/api/config';
import { answerFoundHost, connectHost } from '@/api/hosts';
import { useEvent } from '@/hooks/useWebSocket';
import { seedHostStatus, useAllHostStatus } from '@/hooks/useHostStatus';
import { foundHostsToAsk } from '@/utils/first-use';
import { isHostConnecting, isHostFailed, reconnectReasonOf } from '@/utils/host-connect';
import { HostConnectSteps } from '@/components/sessions/path-selector/HostConnectSteps';
import { log } from '@/utils/log';
import { useHostActions } from '@/hooks/useHostActions';
import { setPromptedHosts } from '@/utils/host-user-retrying';
import { openHostSettings } from '@/utils/host-settings-nav';
import { notNowLine } from '@/utils/found-host-words';
import { RemoteHostReadiness } from '@/components/settings/sections/RemoteHostReadiness';
import { autofixProgressText, autofixVerbFor, BLOCKING_READINESS_KINDS, hostReadinessConfirmed, isClaudeFixAction, readinessAnsweredThisConnection, READINESS_ANSWER_GRACE_MS, shownFailureSummary } from '@open-walnut/host-problem';
import { hostReadinessProblems } from '@/utils/host-readiness';
import { SetupProgress } from './SetupProgress';
import { useServerTick } from '@/hooks/useServerTick';
import type { HostStatus } from '@/api/hosts';
import '@/styles/first-use.css';

type Found = { host: string; label: string };

export function FoundHostPrompts() {
  const [found, setFound] = useState<Found[]>([]);
  const [connecting, setConnecting] = useState<Found[]>([]);
  const [consented, setConsented] = useState<Found[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Hosts the person said Not now to here: one line each, in place, until closed.
  const [deferred, setDeferred] = useState<Found[]>([]);
  const navigate = useNavigate();
  const busy = useRef(new Set<string>());
  const order = useRef(new Map<string, number>());
  const generation = useRef(0);
  const statuses = useAllHostStatus();
  const refresh = useCallback(() => {
    const own = ++generation.current;
    void fetchFreshConfig().then(config => {
      if (own !== generation.current) return;
      setFound(foundHostsToAsk(config.hosts));
      setConsented(Object.entries(config.hosts ?? {})
        .filter(([, h]) => h.discovered && h.connect === 'yes' && h.enabled !== false)
        .map(([host, h]) => ({ host, label: h.label?.trim() || host })));
    }).catch(error => log.warn('first-use', 'found hosts could not be read', { error: String(error) }));
  }, []);
  useEffect(() => { refresh(); return () => { generation.current++; }; }, [refresh]);
  useEvent('config:changed', refresh);
  useEvent('_ws:reconnected', refresh);
  useEffect(() => {
    setConnecting(prev => {
      const next = prev.filter(h => {
        const status = statuses.find(s => s.host === h.host);
        const ready = hostReadinessConfirmed(status);
        return !ready && (busy.current.has(h.host) || found.some(row => row.host === h.host) || consented.some(row => row.host === h.host));
      });
      for (const h of consented) {
        const status = statuses.find(s => s.host === h.host);
        if ((isHostConnecting(status) || isHostFailed(status) || (status?.connected && !hostReadinessConfirmed(status)))
          && !next.some(row => row.host === h.host)) next.push(h);
      }
      return next.length === prev.length && next.every((h, i) => h.host === prev[i].host) ? prev : next;
    });
  }, [statuses, consented, found]);

  const answer = async (h: Found, choice: 'yes' | 'not_now', retry = false) => {
    if (busy.current.has(h.host)) return;
    busy.current.add(h.host);
    setPending(new Set(busy.current));
    setErrors(prev => { const next = { ...prev }; delete next[h.host]; return next; });
    if (choice === 'yes') setConnecting(prev => prev.some(row => row.host === h.host) ? prev : [...prev, h]);
    try {
      if (retry) seedHostStatus(await connectHost(h.host));
      else {
        const result = await answerFoundHost(h.host, choice);
        seedHostStatus(result.status);
        refresh();
        setFound(prev => prev.filter(row => row.host !== h.host));
        if (choice === 'yes') setConsented(prev => prev.some(row => row.host === h.host) ? prev : [...prev, h]);
        if (choice === 'not_now') {
          // A row put aside while it connected leaves at once (the server ends its link).
          setConnecting(prev => prev.filter(row => row.host !== h.host));
          setConsented(prev => prev.filter(row => row.host !== h.host));
          setDeferred(prev => prev.some(row => row.host === h.host) ? prev : [...prev, h]);
        } else setDeferred(prev => prev.filter(row => row.host !== h.host));
      }
    } catch (error) {
      setErrors(prev => ({ ...prev, [h.host]: error instanceof Error ? error.message : String(error) }));
      if (!retry) setConnecting(prev => prev.filter(row => row.host !== h.host));
    } finally {
      busy.current.delete(h.host);
      setPending(new Set(busy.current));
    }
  };
  const rows = [...found.filter(h => !connecting.some(c => c.host === h.host)), ...connecting];
  const rowHosts = rows.map(h => h.host).sort().join('\n');
  useEffect(() => { setPromptedHosts(rowHosts ? rowHosts.split('\n') : []); }, [rowHosts]);
  useEffect(() => () => setPromptedHosts([]), []);
  // A Not now line holds its host's place; a host asked again (it came back as found) is a row again.
  const notNow = deferred.filter(d => !rows.some(r => r.host === d.host));
  for (const h of [...rows, ...notNow]) if (!order.current.has(h.host)) order.current.set(h.host, order.current.size);
  const items = [...rows.map(h => ({ h, deferred: false })), ...notNow.map(h => ({ h, deferred: true }))];
  items.sort((a, b) => order.current.get(a.h.host)! - order.current.get(b.h.host)!);
  if (!items.length) return null;
  // Several rows fold their connect steps to one progress line, so the card stays a few lines tall
  // above the task list (2026-11-11 review: at 1280x560 two rows took half the list).
  const compact = items.length > 1;
  return (
    <section className={`found-host-prompts${compact ? ' found-host-prompts-compact' : ''}`} data-testid="found-host-prompts" aria-label="Connect a found host">
      <h2>Your other computers</h2>
      <ul>{items.map(({ h, deferred: later }) => {
        if (later) return (
          <li key={h.host} className="found-host-prompt found-host-not-now" data-host={h.host} data-testid="found-host-not-now">
            <p role="status">{notNowLine(h.label)}</p>
            <div className="found-host-actions">
              <button type="button" className="setup-step-btn" onClick={() => openHostSettings(navigate, h.host)}>Open Remote Hosts</button>
              <button type="button" className="setup-step-btn" aria-label={`Close: ${h.label} stays off`} onClick={() => setDeferred(prev => prev.filter(row => row.host !== h.host))}>OK</button>
            </div>
          </li>
        );
        const active = connecting.some(c => c.host === h.host);
        const status = statuses.find(s => s.host === h.host);
        const failed = active && isHostFailed(status);
        // A row that failed, or keeps failing while it reconnects, can be put aside like a found host:
        // Not now (it stays off, and Settings > Remote Hosts connects it any time).
        const stuck = failed || (active && !status?.connected && !!reconnectReasonOf(status));
        return (
          <li key={h.host} className="found-host-prompt" data-host={h.host}>
            <p>{status?.connected ? `${h.label} is connected` : failed ? `Could not connect to ${h.label}` : active ? `Connecting to ${h.label}` : `Connect to ${h.label}?`}</p>
            {active && !failed && !status?.connected && <HostConnectSteps hostKey={h.host} label={h.label} compact={compact} />}
            {active && status?.connected && <FoundHostReadiness host={h} status={status} />}
            <div className="found-host-actions">
              {(!active || failed) && <button type="button" className="setup-step-btn" disabled={pending.has(h.host)} onClick={() => void answer(h, 'yes', failed)}>{failed ? 'Try again' : 'Connect'}</button>}
              {(!active || stuck) && <button type="button" className="setup-step-btn" disabled={pending.has(h.host)} onClick={() => void answer(h, 'not_now')}>Not now</button>}
              {(errors[h.host] || failed) && <span className="found-host-error" role="alert">{errors[h.host] || status?.hint || shownFailureSummary(status?.error)}</span>}
            </div>
          </li>
        );
      })}</ul>
    </section>
  );
}

function FoundHostReadiness({ host, status }: { host: Found; status: HostStatus }) {
  const actions = useHostActions(host.host);
  const answered = readinessAnsweredThisConnection(status);
  // This card is the host's row here: it offers the fix and shows its progress, as the
  // Remote Hosts row does (useLinkedHostRow); the readiness below folds the commands.
  const blocking = hostReadinessProblems(status).find((p) => BLOCKING_READINESS_KINDS.includes(p.kind));
  const verb = answered && blocking ? autofixVerbFor(blocking, status.readiness?.claude?.installMethod) : null;
  const claudeFix = !!actions.fixing && (actions.fixing.asked || isClaudeFixAction(actions.fixing.action));
  const fixRunning = !!verb && (blocking?.fix?.state === 'running' || claudeFix);
  const now = useServerTick(!answered || fixRunning);
  if (!answered) {
    const checking = actions.pending === 'check' || (typeof status.connectedAt === 'number' && now - status.connectedAt < READINESS_ANSWER_GRACE_MS);
    return <div className="rh-readiness-block">
      {checking ? <SetupProgress label={`Checking ${host.label}...`} /> : <p>Walnut could not check Claude Code on {host.label}. This host may need a daemon update. You can still open its files.</p>}
      <button type="button" className="setup-step-btn" disabled={actions.pending === 'check'} onClick={() => void actions.checkAgain()}>Check again</button>
      {actions.failed === 'check' && <span role="alert">The check could not finish. Try again.</span>}
    </div>;
  }
  const own = actions.fixing && isClaudeFixAction(actions.fixing.action) ? actions.fixing.verb : verb;
  return <>
    {verb && (fixRunning
      ? <div className="found-host-fix"><SetupProgress label={autofixProgressText(own ?? verb, host.label, actions.fixing?.startedAt ?? status.readiness?.fixing?.startedAt, now).text} /></div>
      : <div className="found-host-fix">
          <button type="button" className="setup-step-btn" onClick={() => void actions.update(verb)}>
            {blocking?.fix?.state === 'failed' ? 'Try again' : `${verb === 'install' ? 'Install' : 'Update'} Claude Code on ${host.label}`}
          </button>
        </div>)}
    <RemoteHostReadiness alias={host.host} label={host.label} status={status} actions={actions} />
  </>;
}
