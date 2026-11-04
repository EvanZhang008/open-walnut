/**
 * One host on the fleet dashboard (HostFleetGroup.tsx). A live host is a card:
 * name and roles, what it is, CPU, memory, GPU (a host with one) and disk as
 * rings, the last 12 hours as an online timeline with a small chart each of
 * CPU, memory, GPU and sessions under it, sessions and spend, what it can do, at most one problem
 * line (the whole sentence in its tooltip) with a button when Walnut can fix it,
 * and the full key/value table behind Details. A host Walnut is not connected to
 * is one compact row with Connect. Words come from host-fleet-dashboard-model.ts
 * and host-fleet-model.ts. Each says how old it is and when a read of it runs
 * (host-fleet-read-model.ts); opening Details reads that host again.
 */
import { useState } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import {
  capabilityChips, sessionsTitle, sessionsUnknown, spendUnknown, gauges, offlineLine, problemsOf, problemTitle, roleChips, sparkPaths, sparks, systemLine, timeline,
  type Chip, type Gauge, type Spark,
} from './host-fleet-dashboard-model';
import { dayTitle, dayTone, fleetRows, statusKind, usd } from './host-fleet-model';
import { readFailure, readLabel } from './host-fleet-read-model';
import { SettingsButton } from '../inputs/SettingsButton';
import { FleetNumber, UNKNOWN_MARK } from './FleetNumber';

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
      <span className="hf-gauge-value" data-num={g.share === null && !g.text ? 'unknown' : 'known'} data-text={g.text ? 'true' : undefined}>
        {g.share !== null ? `${Math.round(share * 100)}%` : g.text ?? UNKNOWN_MARK}
      </span>
      <span className="hf-gauge-label">{g.label}</span>
      {g.sub && <span className="hf-gauge-sub" data-low={g.subLow ? 'true' : 'false'} data-testid="host-fleet-disk-free">{g.sub}</span>}
      {g.why && <span className="hf-why" data-testid="host-fleet-why">{g.why}</span>}
    </div>
  );
}

const SPARK_H = 20;

function SparkRow({ s }: { s: Spark }) {
  const { line, area } = sparkPaths(s.values, s.max, SPARK_H);
  return (
    <div className="hf-lane" data-testid="host-fleet-spark" data-spark={s.key} title={s.title}>
      <span className="hf-lane-label">{s.label}</span>
      <svg className="hf-spark" viewBox={`0 0 100 ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="hf-spark-area" d={area} />
        <path className="hf-spark-line" d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="hf-lane-value">{s.value}</span>
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
    <button type="button" className="hf-link" aria-expanded={open} onClick={onToggle} data-testid="host-fleet-details-toggle" aria-label={`${open ? 'Hide' : 'Show'} details of ${label}`}>
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
  const charts = sparks(host);
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
        {charts.map((c) => <SparkRow key={c.key} s={c} />)}
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
      <ReadError host={host} now={now} />
      <div className="hf-card-foot"><DetailsToggle open={open} onToggle={toggle} label={host.label} /><ReadMark host={host} now={now} /></div>
      {open && <Details host={host} now={now} />}
    </article>
  );
}

export function HostFleetOfflineRow({ host, now, action, onConnect, onDetails }: {
  host: FleetHost; now: number; action?: ActionState; onConnect: (host: string) => void; onDetails?: (host: string) => void;
}) {
  const [open, toggle] = useDetails(host.host, onDetails);
  const canConnect = host.connection.kind === 'ssh-tunnel' || host.connection.kind === 'host-network';
  return (
    <div className="hf-off" data-testid="host-fleet-offline" data-host={host.host} id={`hf-card-${host.host}`} tabIndex={-1}>
      <div className="hf-off-line">
        <span className="sps-host-dot hsd" data-kind={statusKind(host)} aria-hidden="true" />
        <span className="hf-off-name" title={host.label}>{host.label}</span>
        <span className="hf-off-why" title={host.connection.error ?? undefined}>{offlineLine(host)}</span>
        {host.refreshing && <ReadMark host={host} now={now} />}
        <DetailsToggle open={open} onToggle={toggle} label={host.label} />
        {canConnect && (
          <SettingsButton busy={action?.busy} busyLabel="Connecting..." onClick={() => onConnect(host.host)} data-testid="host-fleet-connect">
            Connect
          </SettingsButton>
        )}
      </div>
      {action?.error && <p className="hf-action-error" role="status" data-testid="host-fleet-action-error">{action.error}</p>}
      <ReadError host={host} now={now} />
      {open && <Details host={host} now={now} />}
    </div>
  );
}
