/**
 * Settings › Remote Hosts › Overview: one card per host Walnut runs work on,
 * this Mac first (GET /api/v1/hosts, server: src/core/hosts/fleet.ts). Agents
 * read the same cards with `host_list`.
 *
 * Each card says what the host is, how it is doing now, how much of the last
 * 7 days it was up (from the ledger its own daemon writes, so a Mac that slept
 * never counts against it), one cell per day for the last 30, its sessions and
 * spend, how it connects, its Walnut server and daemon, and whether a job that
 * must keep running belongs there. It refreshes every 30 s while the page is
 * visible; a failed refresh keeps the cards it had and says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFleet, type FleetHost } from '@/api/hosts-fleet';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsGroup } from '../SettingsSection';
import { dayTitle, dayTone, fleetRows, statusKind } from './host-fleet-model';
import '@/styles/host-status.css';
import '@/styles/host-fleet.css';

const REFRESH_MS = 30_000;

/** A reason names a command in backticks (the same text an agent reads): shown as code. */
function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

function HostCard({ host, now }: { host: FleetHost; now: number }) {
  const rows = fleetRows(host, now);
  const days = host.history?.buckets ?? [];
  const fit = host.placement.longRunning;
  return (
    <article className="hf-card" data-testid="host-fleet-card" data-host={host.host}>
      <header className="hf-card-head">
        <span className="sps-host-dot hsd" data-kind={statusKind(host)} aria-hidden="true" />
        <span className="hf-card-name">{host.label}</span>
        {host.local && <span className="hf-tag">Primary</span>}
      </header>
      <dl className="hf-rows">
        {rows.map((r) => (
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
    </article>
  );
}

export function HostFleetGroup() {
  const [hosts, setHosts] = useState<FleetHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (inflight.current) return;
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const r = await fetchFleet({ signal: ctrl.signal });
      setHosts(r.hosts);
      setError(null);
      setNow(Date.now());
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      log.warn('host-fleet', 'fleet refresh failed', { error: msg });
      setError(msg);
    } finally {
      if (inflight.current === ctrl) inflight.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [load]);

  return (
    <SettingsGroup heading="Overview" data-testid="host-fleet">
      {error && <p className="hf-error" role="status">Could not refresh the overview: {error.replace(/[.\s]*$/, '')}.{hosts ? ' Showing the last cards.' : ''}</p>}
      {!hosts && !error && <p className="hf-loading">Reading each host...</p>}
      {hosts && (
        <div className="hf-grid">
          {hosts.map((h) => <HostCard key={h.host} host={h} now={now} />)}
        </div>
      )}
    </SettingsGroup>
  );
}
