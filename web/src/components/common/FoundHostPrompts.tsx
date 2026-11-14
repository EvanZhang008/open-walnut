import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchFreshConfig } from '@/api/config';
import { answerFoundHost } from '@/api/hosts';
import { useEvent } from '@/hooks/useWebSocket';
import { seedHostStatus, useAllHostStatus } from '@/hooks/useHostStatus';
import { consentedFoundHosts, foundHostsToAsk } from '@/utils/first-use';
import { log } from '@/utils/log';
import { useHostActions } from '@/hooks/useHostActions';
import { setPromptedHosts } from '@/utils/host-user-retrying';
import { openHostSettings } from '@/utils/host-settings-nav';
import { notNowLine } from '@/utils/found-host-words';
import { RemoteHostReadiness } from '@/components/settings/sections/RemoteHostReadiness';
import { autofixProgressText, autofixVerbFor, BLOCKING_READINESS_KINDS, hostReadinessConfirmed, isClaudeFixAction, readinessAnsweredThisConnection, READINESS_ANSWER_GRACE_MS } from '@open-walnut/host-problem';
import { hostReadinessProblems } from '@/utils/host-readiness';
import { SetupProgress } from './SetupProgress';
import { markHostConnectAsked } from '@/components/hosts/background-connect';
import { useServerTick } from '@/hooks/useServerTick';
import type { HostStatus } from '@/api/hosts';
import '@/styles/first-use.css';

type Found = { host: string; label: string };

/**
 * Home's "Your other computers": only real choices and the last step of a setup.
 *   ask      a found host Walnut can add (found-host-offer.ts foundHostsToAsk): Connect / Not now
 *   ready    a host the person said Connect to, connected, while Walnut checks or fixes Claude
 *            Code there (FoundHostReadiness)
 *   not now  the line that says where to connect it later, in the host's place, until closed
 * A host it cannot add (not Linux, or a machine already connected under another name) is never
 * asked, a connect in progress shows in the background connect card, and a host that cannot
 * connect is one Notifications entry (src/core/hosts/found-host-alert.ts), never a row here
 * (2026-11-13, the user: "I don't want it keep showing ... Just show it inside notification").
 */
export function FoundHostPrompts() {
  const [found, setFound] = useState<Found[]>([]);
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
      setFound(foundHostsToAsk(config.hosts, config.net));
      setConsented(consentedFoundHosts(config.hosts, config.net));
    }).catch(error => log.warn('first-use', 'found hosts could not be read', { error: String(error) }));
  }, []);
  useEffect(() => { refresh(); return () => { generation.current++; }; }, [refresh]);
  useEvent('config:changed', refresh);
  useEvent('_ws:reconnected', refresh);

  const answer = async (h: Found, choice: 'yes' | 'not_now') => {
    if (busy.current.has(h.host)) return;
    busy.current.add(h.host);
    setPending(new Set(busy.current));
    setErrors(prev => { const next = { ...prev }; delete next[h.host]; return next; });
    // The floating card shows a Connect at once, before the server's first status lands.
    if (choice === 'yes') markHostConnectAsked(h.host);
    try {
      const result = await answerFoundHost(h.host, choice);
      seedHostStatus(result.status);
      refresh();
      setFound(prev => prev.filter(row => row.host !== h.host));
      if (choice === 'not_now') {
        setConsented(prev => prev.filter(row => row.host !== h.host));
        setDeferred(prev => prev.some(row => row.host === h.host) ? prev : [...prev, h]);
      } else {
        setConsented(prev => prev.some(row => row.host === h.host) ? prev : [...prev, h]);
        setDeferred(prev => prev.filter(row => row.host !== h.host));
      }
    } catch (error) {
      setErrors(prev => ({ ...prev, [h.host]: error instanceof Error ? error.message : String(error) }));
    } finally {
      busy.current.delete(h.host);
      setPending(new Set(busy.current));
    }
  };
  const statusOf = (host: string) => statuses.find(s => s.host === host);
  // Connected, and Claude Code there not confirmed yet: the setup's last step shows here.
  const settingUp = consented.filter(h => { const s = statusOf(h.host); return !!s?.connected && !hostReadinessConfirmed(s); });
  const rows = [...found.filter(h => !settingUp.some(c => c.host === h.host)), ...settingUp];
  // The hosts this setup speaks for (asked here, or said Connect to and not set up yet), so the
  // System attention banner gives them no row: their progress is the background connect card and
  // their failure the one Notifications entry.
  const ownedHosts = [...new Set([...found, ...consented.filter(h => !hostReadinessConfirmed(statusOf(h.host)))].map(h => h.host))].sort().join('\n');
  useEffect(() => { setPromptedHosts(ownedHosts ? ownedHosts.split('\n') : []); }, [ownedHosts]);
  useEffect(() => () => setPromptedHosts([]), []);
  // A Not now line holds its host's place; a host asked again (it came back as found) is a row again.
  const notNow = deferred.filter(d => !rows.some(r => r.host === d.host));
  for (const h of [...rows, ...notNow]) if (!order.current.has(h.host)) order.current.set(h.host, order.current.size);
  const items = [...rows.map(h => ({ h, deferred: false })), ...notNow.map(h => ({ h, deferred: true }))];
  items.sort((a, b) => order.current.get(a.h.host)! - order.current.get(b.h.host)!);
  if (!items.length) return null;
  // Several rows keep the card a few lines tall above the task list (2026-11-11 review: at
  // 1280x560 two rows took half the list).
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
        const status = statusOf(h.host);
        if (settingUp.some(c => c.host === h.host) && status) return (
          <li key={h.host} className="found-host-prompt" data-host={h.host}>
            <p>{`${h.label} is connected`}</p>
            <FoundHostReadiness host={h} status={status} />
          </li>
        );
        return (
          <li key={h.host} className="found-host-prompt" data-host={h.host}>
            <p>{`Connect to ${h.label}?`}</p>
            <div className="found-host-actions">
              <button type="button" className="setup-step-btn" disabled={pending.has(h.host)} onClick={() => void answer(h, 'yes')}>Connect</button>
              <button type="button" className="setup-step-btn" disabled={pending.has(h.host)} onClick={() => void answer(h, 'not_now')}>Not now</button>
              {errors[h.host] && <span className="found-host-error" role="alert">{errors[h.host]}</span>}
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
