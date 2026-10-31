/**
 * One host on the fleet dashboard (HostFleetGroup.tsx). A live host is a card:
 * name and roles, what it is, CPU and memory as rings, disk free, the last 12
 * hours as a timeline, sessions and spend, what it can do, at most one problem
 * line (the whole sentence in its tooltip) with a button when Walnut can fix it,
 * and the full key/value table behind Details. A host Walnut is not connected to
 * is one compact row with Connect. Words come from host-fleet-dashboard-model.ts
 * and host-fleet-model.ts.
 */
import { useState } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import {
  capabilityChips, diskFree, gauges, offlineLine, problemsOf, problemTitle, roleChips, systemLine, timeline,
  type Chip, type Gauge,
} from './host-fleet-dashboard-model';
import { dayTitle, dayTone, fleetRows, statusKind, usd } from './host-fleet-model';
import { SettingsButton } from '../inputs/SettingsButton';

/** A reason names a command in backticks (the same text an agent reads): shown as code. */
function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/** A button's press: running, refused (error), or done with something to say (note). */
export type ActionState = { busy: boolean; error: string | null; note?: string | null };

function Ring({ g }: { g: Gauge }) {
  const r = 21;
  const c = 2 * Math.PI * r;
  const share = g.share === null ? 0 : Math.min(1, Math.max(0, g.share));
  return (
    <div className="hf-gauge" data-testid="host-fleet-gauge" data-gauge={g.key} data-tone={g.tone} title={g.title}>
      <svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true">
        <circle className="hf-gauge-track" cx="26" cy="26" r={r} />
        {g.share !== null && (
          <circle className="hf-gauge-fill" cx="26" cy="26" r={r} strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 26 26)" />
        )}
      </svg>
      <span className="hf-gauge-value">{g.share === null ? '?' : `${Math.round(share * 100)}%`}</span>
      <span className="hf-gauge-label">{g.label}</span>
    </div>
  );
}

function Chips({ list, className, testId }: { list: Chip[]; className: string; testId: string }) {
  if (!list.length) return null;
  return (
    <span className={className} data-testid={testId}>
      {list.map((c) => <span key={c.key} className="hf-chip" data-chip={c.key} data-tone={c.tone} title={c.title}>{c.text}</span>)}
    </span>
  );
}

function Details({ host, now }: { host: FleetHost; now: number }) {
  const days = host.history?.buckets ?? [];
  const fit = host.placement.longRunning;
  return (
    <div className="hf-details" data-testid="host-fleet-details">
      <dl className="hf-rows">
        {fleetRows(host, now).map((r) => (
          <div className="hf-row" key={r.key} data-row={r.key} data-tone={r.tone}>
            <dt>{r.label}</dt>
            <dd title={r.title}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {days.length > 0 && (
        <div className="hf-days" role="img" aria-label={`Up time per day, last ${days.length} days`} data-testid="host-fleet-days">
          {days.map((b) => <i key={b.start} data-tone={dayTone(b)} title={dayTitle(b, host.history!.bucketMinutes)} />)}
        </div>
      )}
      <p className="hf-fit" data-ok={fit.ok ? 'true' : 'false'} data-testid="host-fleet-fit">
        {fit.ok ? 'Fits a job that must keep running.' : withCode(`Not for a job that must keep running: ${fit.reasons.join(' ')}`)}
      </p>
    </div>
  );
}

function DetailsToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="hf-link" aria-expanded={open} onClick={onToggle} data-testid="host-fleet-details-toggle" aria-label={`${open ? 'Hide' : 'Show'} details of ${label}`}>
      {open ? 'Hide details' : 'Details'}
    </button>
  );
}

export function HostFleetCard({ host, now, action, onBootStart }: {
  host: FleetHost; now: number; action?: ActionState; onBootStart: (host: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const problems = problemsOf(host, now);
  const first = problems[0];
  const disk = diskFree(host);
  const segments = timeline(host, now);
  const roles = roleChips(host);
  return (
    <article className="hf-card" data-testid="host-fleet-card" data-host={host.host} id={`hf-card-${host.host}`} tabIndex={-1}>
      <header className="hf-card-head">
        <span className="sps-host-dot hsd" data-kind={statusKind(host)} aria-hidden="true" />
        <span className="hf-card-name" title={host.label}>{host.label}</span>
        <Chips list={roles} className="hf-roles" testId="host-fleet-roles" />
      </header>
      <p className="hf-card-sys" data-testid="host-fleet-system">{systemLine(host)}</p>
      <div className="hf-vitals">
        {gauges(host).map((g) => <Ring key={g.key} g={g} />)}
        <div className="hf-disk" data-testid="host-fleet-disk" data-low={disk?.low ? 'true' : 'false'}>
          <span className="hf-big">{disk?.text ?? '?'}</span>
          <span className="hf-big-label">Disk free</span>
        </div>
      </div>
      <div className="hf-timeline-wrap">
        <div className="hf-timeline" role="img" aria-label="The last 12 hours" data-testid="host-fleet-timeline">
          {segments.map((s) => (
            <i key={`${s.from}-${s.tone}`} data-tone={s.tone} title={s.title} style={{ left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%` }} />
          ))}
        </div>
        <div className="hf-timeline-axis" aria-hidden="true"><span>12 h ago</span><span>6 h</span><span>{host.now?.stale ? 'Last reading' : 'Now'}</span></div>
      </div>
      <div className="hf-numbers">
        <div data-testid="host-fleet-sessions">
          <span className="hf-big">{host.sessions.running ?? '?'}</span>
          <span className="hf-big-label">{host.sessions.running === 1 ? 'Session open' : 'Sessions open'}</span>
        </div>
        <div data-testid="host-fleet-spend" title={host.spend ? 'At list price, not a bill' : 'Not counted yet'}>
          <span className="hf-big">{host.spend ? usd(host.spend.last30dUsd) : '?'}</span>
          <span className="hf-big-label">Spend, 30 days</span>
        </div>
      </div>
      <Chips list={capabilityChips(host)} className="hf-caps" testId="host-fleet-caps" />
      {first && (
        <div className="hf-problem" data-testid="host-fleet-problem" data-problem={first.key} data-tone={first.tone} title={problemTitle(problems)}>
          <span className="hf-problem-text">{first.text}{problems.length > 1 ? ` (+${problems.length - 1})` : ''}</span>
          {first.action && (
            <SettingsButton busy={action?.busy} busyLabel="Setting up..." onClick={() => onBootStart(host.host)} data-testid="host-fleet-fix">
              {first.action.label}
            </SettingsButton>
          )}
        </div>
      )}
      {action?.error && <p className="hf-action-error" role="status" data-testid="host-fleet-action-error">{action.error}</p>}
      {action?.note && <p className="hf-action-note" role="status" data-testid="host-fleet-action-note">{action.note}</p>}
      <div className="hf-card-foot"><DetailsToggle open={open} onToggle={() => setOpen((v) => !v)} label={host.label} /></div>
      {open && <Details host={host} now={now} />}
    </article>
  );
}

export function HostFleetOfflineRow({ host, now, action, onConnect }: {
  host: FleetHost; now: number; action?: ActionState; onConnect: (host: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const canConnect = host.connection.kind === 'ssh-tunnel';
  return (
    <div className="hf-off" data-testid="host-fleet-offline" data-host={host.host} id={`hf-card-${host.host}`} tabIndex={-1}>
      <div className="hf-off-line">
        <span className="sps-host-dot hsd" data-kind={statusKind(host)} aria-hidden="true" />
        <span className="hf-off-name" title={host.label}>{host.label}</span>
        <span className="hf-off-why" title={host.connection.error ?? undefined}>{offlineLine(host)}</span>
        <DetailsToggle open={open} onToggle={() => setOpen((v) => !v)} label={host.label} />
        {canConnect && (
          <SettingsButton busy={action?.busy} busyLabel="Connecting..." onClick={() => onConnect(host.host)} data-testid="host-fleet-connect">
            Connect
          </SettingsButton>
        )}
      </div>
      {action?.error && <p className="hf-action-error" role="status" data-testid="host-fleet-action-error">{action.error}</p>}
      {open && <Details host={host} now={now} />}
    </div>
  );
}
