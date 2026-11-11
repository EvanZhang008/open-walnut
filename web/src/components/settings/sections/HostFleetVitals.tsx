/**
 * What a host's Details show from its last reading (useHostFleet.ts): what it is (one System
 * line, with Probe again where Walnut probes it), CPU, memory, GPU (a host with one) and disk as
 * rings, the last 12 hours as the one online bar with a small chart each of CPU, memory, GPU and
 * sessions under it, sessions and spend, what it can do, the problems its row does not already
 * name, and the facts table. Each fact once (2026-11-04 review). Words come from
 * host-fleet-dashboard-model.ts and host-fleet-model.ts.
 */
import type { ReactNode } from 'react';
import type { FleetHost } from '@/api/hosts-fleet';
import {
  capabilityChips, problemsOf, roleChips, sessionsTitle, sessionsUnknown, spendUnknown, gauges, sparkPaths, sparks, systemLine, timeline,
  type Chip, type Gauge, type Spark,
} from './host-fleet-dashboard-model';
import { fleetRows, usd } from './host-fleet-model';
import { readFailure, readLabel } from './host-fleet-read-model';
import { FleetNumber, UNKNOWN_MARK } from './FleetNumber';

/** A reason names a command in backticks (the same text an agent reads): shown as code. */
export function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

export function Ring({ g }: { g: Gauge }) {
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

export function SparkRow({ s }: { s: Spark }) {
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

export function Chips({ list, className, testId }: { list: Chip[]; className: string; testId: string }) {
  if (!list.length) return null;
  return (
    <span className={className} data-testid={testId}>
      {list.map((c) => <span key={c.key} className="hf-chip" data-chip={c.key} data-tone={c.tone} title={c.title}>{c.text}</span>)}
    </span>
  );
}

/** The one System line: what the host is, its role chips, and on the right its action (Probe again). */
export interface SystemLine { text: string; meta?: ReactNode; action?: ReactNode }

/** The reading: system, rings, the last 12 hours, sessions and spend, what it can do. */
export function FleetVitals({ host, now, system }: { host: FleetHost; now: number; system?: SystemLine }) {
  const segments = timeline(host, now);
  const read = readLabel(host, now);
  const failure = readFailure(host, now);
  return (
    <div className="hf-vitals-block" data-testid="host-fleet-card" data-host={host.host}>
      <div className="hf-card-sys-row">
        <p className="hf-card-sys" data-testid="host-fleet-system">
          <span data-testid="host-system-line">{system?.text ?? systemLine(host)}</span>
          <Chips list={roleChips(host)} className="hf-roles" testId="host-fleet-roles" />
        </p>
        {system?.action}
      </div>
      <p className="hf-card-meta">
        {system?.meta}
        {read && (
          <span className="hf-read" data-testid="host-fleet-read-age" title={typeof host.readAt === 'number' ? `Read ${new Date(host.readAt).toLocaleString()}` : undefined}>{read}</span>
        )}
      </p>
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
      {failure && <p className="hf-read-error" role="status" data-testid="host-fleet-read-error">{failure}</p>}
    </div>
  );
}

/** Every problem its reading shows, beyond the one the row names (`skip`); a long job's fit is a fact (FleetFacts). */
export function FleetProblems({ host, now, skip }: { host: FleetHost; now: number; skip?: string | null }) {
  const list = problemsOf(host, now).filter((p) => !(host.readError && p.key === 'stale') && p.key !== skip && p.key !== 'long-running');
  if (!list.length) return null;
  return (
    <ul className="hf-problem-list" data-testid="host-fleet-problems">
      {list.map((p) => (
        <li key={p.key} data-testid="host-fleet-problem" data-problem={p.key} data-tone={p.tone} title={p.detail.replace(/`/g, '')}>{p.text}</li>
      ))}
    </ul>
  );
}

/**
 * The facts table, its last row whether it fits a long job, each said once (2026-11-05 review:
 * "Not for jobs that must keep running" showed as a problem and again under the table). `omit`:
 * facts said elsewhere (a host not connected says its connection in its failure, once). `fit`:
 * false for a host Walnut cannot reach, which fits nothing.
 */
export function FleetFacts({ host, now, omit = [], fit: judge = true }: { host: FleetHost; now: number; omit?: string[]; fit?: boolean }) {
  const fit = host.placement.longRunning;
  // The reboot reason is already a problem line; the fit says only what it alone says, and never
  // "starts again after a reboot" beside that line (a reading older than the fit's).
  const rebootGap = !host.local && !!host.daemon && !host.daemon.startsAfterReboot;
  const ok = fit.ok && !rebootGap;
  const reasons = fit.reasons.filter((r) => !/does not start by itself after a reboot/.test(r));
  const fitText = !judge ? null : ok ? 'Good fit: it stays up, and Walnut starts again after a reboot' : reasons.length ? `Not a good fit: ${reasons.join(' ')}` : null;
  const rows = fleetRows(host, now).filter((r) => !omit.includes(r.key));
  if (!rows.length && !fitText) return null;
  return (
    <div className="hf-details" data-testid="host-fleet-details">
      <dl className="hf-rows">
        {rows.map((r) => (
          <div className="hf-row" key={r.key} data-row={r.key} data-tone={r.tone}>
            <dt>{r.label}</dt>
            <dd title={r.title}>{r.value}</dd>
          </div>
        ))}
        {fitText && (
          <div className="hf-row" data-row="fit" data-tone={ok ? undefined : 'muted'}>
            <dt>Long jobs</dt>
            <dd className="hf-fit" data-ok={ok ? 'true' : 'false'} data-testid="host-fleet-fit">{withCode(fitText)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
