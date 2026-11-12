/**
 * One host on the Remote Hosts Overview (HostFleetOverview.tsx), the dashboard as it was on
 * 2026-11-03 (2026-11-11, the user asked for that dashboard back: it was nicer than the list of
 * rows that replaced it on 11-07). A live host is a card: name and roles, what it is, CPU, memory, GPU (a
 * host with one) and disk as rings, the last 12 hours as an online timeline with a small chart
 * each of CPU, memory, GPU and sessions under it, sessions and spend, what it can do, at most
 * one problem line (the whole list in its tooltip) with a button when Walnut can fix it, and the
 * facts table behind Details. A host Walnut is not connected to is one compact row with
 * Connect. The rings, charts and chips are the ones a row's Details draw (HostFleetVitals.tsx);
 * words come from host-fleet-dashboard-model.ts and host-fleet-model.ts. Each says how old it
 * is and when a read of it runs (host-fleet-read-model.ts); opening Details reads that host again.
 */
import { useState } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import { capabilityChips, gauges, offlineLine, problemsOf, problemTitle, roleChips, sessionsTitle, sessionsUnknown, sparks, spendUnknown, systemLine, timeline } from './host-fleet-dashboard-model';
import { statusKind, THIS_MAC, usd } from './host-fleet-model';
import { readFailure, readLabel } from './host-fleet-read-model';
import { SettingsButton } from '../inputs/SettingsButton';
import { FleetNumber } from './FleetNumber';
import { Chips, FleetFacts, Ring, SparkRow } from './HostFleetVitals';
import type { ActionState } from './useHostFleet';
import { RETRY_FAILED_TEXT, useHostActions } from '@/hooks/useHostActions';
import { useHostStatus } from '@/hooks/useHostStatus';

/** How old the card is, or that a read of it runs now. */
function ReadMark({ host, now }: { host: FleetHost; now: number }) {
  const text = readLabel(host, now);
  if (!text) return null;
  return (
    <span className="hf-read" data-testid="host-fleet-read-age" data-refreshing={host.refreshing ? 'true' : 'false'}
      title={typeof host.readAt === 'number' ? `Read ${new Date(host.readAt).toLocaleString()}` : undefined}>
      {text}
    </span>
  );
}

function ReadError({ host, now }: { host: FleetHost; now: number }) {
  const text = readFailure(host, now);
  return text ? <p className="hf-read-error" role="status" data-testid="host-fleet-read-error">{text}</p> : null;
}

/** Details opens and closes; opening it reads the host again (the person is looking at it). */
function useDetails(host: string, onDetails?: (host: string) => void): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  return [open, () => { if (!open) onDetails?.(host); setOpen(!open); }];
}

function DetailsToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="hf-link" aria-expanded={open} onClick={onToggle} data-testid="hf-dash-details-toggle" aria-label={`${open ? 'Hide' : 'Show'} details of ${label}`}>
      {open ? 'Hide details' : 'Details'}
    </button>
  );
}

export function HostFleetCard({ host, now, action, onBootStart, onDetails }: {
  host: FleetHost; now: number; action?: ActionState; onBootStart: (host: string) => void; onDetails?: (host: string) => void;
}) {
  const [open, toggle] = useDetails(host.host, onDetails);
  // A read that failed says so in its own line, so the stale reading's line would only repeat it.
  const problems = problemsOf(host, now).filter((p) => !(host.readError && p.key === 'stale'));
  const first = problems[0];
  const segments = timeline(host, now);
  // This computer is "This Mac", as its row and its diagram node say.
  const name = host.local ? THIS_MAC : host.label;
  return (
    <article className="hf-card" data-testid="hf-dash-card" data-host={host.host} id={`hf-card-${host.host}`} tabIndex={-1}>
      <header className="hf-card-head">
        <span className="sps-host-dot hsd" data-kind={statusKind(host)} aria-hidden="true" />
        <span className="hf-card-name">{name}</span>
        <Chips list={roleChips(host)} className="hf-roles" testId="host-fleet-roles" />
      </header>
      <p className="hf-card-sys" data-testid="host-fleet-system">{systemLine(host)}</p>
      <div className="hf-vitals">
        {gauges(host).map((g) => <Ring key={g.key} g={g} />)}
      </div>
      <div className="hf-history" data-testid="host-fleet-history">
        <div className="hf-lane">
          <span className="hf-lane-label">Online</span>
          <div className="hf-timeline" role="img" aria-label="Online over the last 12 hours" data-testid="host-fleet-timeline">
            {segments.map((s) => (
              <i key={`${s.from}-${s.tone}`} data-tone={s.tone} title={s.title} style={{ left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%` }} />
            ))}
          </div>
          <span className="hf-lane-value" />
        </div>
        {sparks(host).map((c) => <SparkRow key={c.key} s={c} />)}
        <div className="hf-lane hf-lane-axis" aria-hidden="true">
          <span />
          <div className="hf-timeline-axis"><span>12 h ago</span><span>6 h</span><span>{host.now?.stale ? 'Last reading' : 'Now'}</span></div>
          <span />
        </div>
      </div>
      <div className="hf-numbers">
        <div data-testid="host-fleet-sessions" data-source={host.sessions.source ?? undefined} title={sessionsTitle(host, now)}>
          <FleetNumber className="hf-big" value={host.sessions.running} unknown={sessionsUnknown(host)} />
          <span className="hf-big-label">{host.sessions.running === 1 ? 'Session open' : 'Sessions open'}</span>
        </div>
        <div data-testid="host-fleet-spend" title={host.spend ? 'At list price, not a bill' : 'Not counted yet'}>
          <FleetNumber className="hf-big" value={host.spend ? usd(host.spend.last30dUsd) : null} unknown={spendUnknown(host)} />
          <span className="hf-big-label">Spend, 30 days</span>
        </div>
      </div>
      <Chips list={capabilityChips(host)} className="hf-caps" testId="host-fleet-caps" />
      {first && (
        <div className="hf-problem" data-testid="hf-dash-problem" data-problem={first.key} data-tone={first.tone} title={problemTitle(problems)}>
          <span className="hf-problem-text">{first.text}{problems.length > 1 ? ` (+${problems.length - 1})` : ''}</span>
          {first.action && (
            <SettingsButton busy={action?.busy} busyLabel="Setting up..." onClick={() => onBootStart(host.host)} data-testid="hf-dash-fix">
              {first.action.label}
            </SettingsButton>
          )}
        </div>
      )}
      {action?.error && <p className="hf-action-error" role="status" data-testid="hf-dash-action-error">{action.error}</p>}
      {action?.note && <p className="hf-action-note" role="status" data-testid="hf-dash-action-note">{action.note}</p>}
      <ReadError host={host} now={now} />
      <div className="hf-card-foot"><DetailsToggle open={open} onToggle={toggle} label={name} /><ReadMark host={host} now={now} /></div>
      {open && <FleetFacts host={host} now={now} />}
    </article>
  );
}

/** Connect is the list's own Retry (useHostActions): one attempt per host, whichever surface asked. */
export function HostFleetOfflineRow({ host, now, onDetails }: { host: FleetHost; now: number; onDetails?: (host: string) => void }) {
  const [open, toggle] = useDetails(host.host, onDetails);
  const actions = useHostActions(host.host);
  const connecting = actions.pending === 'retry';
  const failed = actions.failed !== 'retry' ? null : actions.failedReason ? `Could not connect: ${actions.failedReason}.` : RETRY_FAILED_TEXT;
  // A machine that is not Linux never connects over SSH: its row below offers the join link instead.
  const status = useHostStatus(host.host);
  const notLinux = (status?.kind ?? status?.lastKind) === 'not_linux';
  const canConnect = (host.connection.kind === 'ssh-tunnel' || host.connection.kind === 'host-network') && !notLinux;
  return (
    <div className="hf-off" data-testid="hf-dash-offline" data-host={host.host} id={`hf-card-${host.host}`} tabIndex={-1}>
      <div className="hf-off-line">
        <span className="sps-host-dot hsd" data-kind={statusKind(host)} aria-hidden="true" />
        <span className="hf-off-name">{host.label}</span>
        <span className="hf-off-why" title={host.connection.error ?? undefined}>{offlineLine(host)}</span>
        {host.refreshing && <ReadMark host={host} now={now} />}
        <DetailsToggle open={open} onToggle={toggle} label={host.label} />
        {canConnect && (
          <SettingsButton busy={connecting} busyLabel="Connecting..." onClick={() => void actions.retry()} data-testid="hf-dash-connect">
            Connect
          </SettingsButton>
        )}
      </div>
      {failed && !connecting && <p className="hf-action-error" role="status" data-testid="hf-dash-action-error">{failed}</p>}
      <ReadError host={host} now={now} />
      {open && <FleetFacts host={host} now={now} fit={false} />}
    </div>
  );
}
