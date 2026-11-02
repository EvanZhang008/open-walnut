/**
 * Settings › Remote Hosts › Overview: the fleet as a dashboard (GET /api/v1/hosts,
 * server: src/core/hosts/fleet.ts). Agents read the same cards with `host_list`.
 *
 * From the top: a summary strip (hosts online, sessions open, 30 day spend,
 * hosts with a problem), a diagram of how Walnut reaches each host
 * (HostFleetTopology.tsx), one card per live host (HostFleetCard.tsx), then the
 * hosts Walnut is not connected to, one compact row each with Connect. It sits
 * in the section beside the Hosts group, never inside one, so no card is nested
 * in a card. It refreshes every 30 s while the page is visible, and at once when a host
 * connects, drops or is new (useHostLinkChange); a failed refresh keeps the cards it had
 * and says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFleet, setUpBootStart, type FleetHost } from '@/api/hosts-fleet';
import { connectHost } from '@/api/hosts';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { useHostLinkChange } from '@/hooks/useHostLinkChange';
import { fleetSummary, isLive } from './host-fleet-dashboard-model';
import { usd } from './host-fleet-model';
import { HostFleetCard, HostFleetOfflineRow, type ActionState } from './HostFleetCard';
import { HostFleetTopology } from './HostFleetTopology';
import '@/styles/host-status.css';
import '@/styles/host-fleet.css';

const REFRESH_MS = 30_000;

function errorText(err: unknown): string {
  return (err instanceof ApiError || err instanceof Error ? err.message : String(err)).replace(/[.\s]*$/, '');
}

function Stat({ value, label, tone, testId, title }: { value: string; label: string; tone?: string; testId: string; title?: string }) {
  return (
    <div className="hf-stat" data-testid={testId} data-tone={tone} title={title}>
      <span className="hf-stat-value">{value}</span>
      <span className="hf-stat-label">{label}</span>
    </div>
  );
}

export function HostFleetGroup() {
  const [hosts, setHosts] = useState<FleetHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const inflight = useRef<AbortController | null>(null);
  // A read asked for while one runs: done once that one ends (never cutting it off).
  const readAgain = useRef(false);

  const load = useCallback(async (): Promise<void> => {
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
      const msg = errorText(err);
      log.warn('host-fleet', 'fleet refresh failed', { error: msg });
      setError(msg);
    } finally {
      if (inflight.current === ctrl) inflight.current = null;
      if (readAgain.current && !inflight.current && !ctrl.signal.aborted) { readAgain.current = false; void load(); }
    }
  }, []);

  const timers = useRef(new Set<number>());
  /** Read now, even with a periodic read in flight: what a button changed shows at once. */
  const reload = useCallback(() => {
    inflight.current?.abort();
    inflight.current = null;
    return load();
  }, [load]);
  const later = useCallback((ms: number) => {
    const id = window.setTimeout(() => { timers.current.delete(id); void reload(); }, ms);
    timers.current.add(id);
  }, [reload]);

  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    const pending = timers.current;
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      for (const id of pending) window.clearTimeout(id);
      pending.clear();
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [load]);

  // A host that connects, drops or is new: read the fleet again now, not at the next refresh,
  // after a read in flight (hosts reconnecting one by one never keep cutting it off).
  const readSoon = useCallback(() => {
    if (inflight.current) readAgain.current = true;
    else void load();
  }, [load]);
  useHostLinkChange(readSoon);

  /**
   * One press per button at a time (keyed host and kind, so a card's Set up never shows on its
   * row's Connect); a refusal stays on that host until the next press, and so does what a check found.
   */
  const run = useCallback(async (key: string, what: string, act: () => Promise<{ card: FleetHost | null; note: string | null }>) => {
    setActions((a) => ({ ...a, [key]: { busy: true, error: null } }));
    try {
      const { card, note } = await act();
      if (card) setHosts((list) => list?.map((h) => (h.host === card.host ? card : h)) ?? list);
      setActions((a) => ({ ...a, [key]: { busy: false, error: null, note } }));
      setNow(Date.now());
    } catch (err) {
      const msg = errorText(err);
      log.warn('host-fleet', `${what} failed`, { key, error: msg });
      setActions((a) => ({ ...a, [key]: { busy: false, error: `Could not ${what}: ${msg}.` } }));
    }
  }, []);

  const onConnect = useCallback((host: string) => {
    void run(`${host}:connect`, 'connect', async () => {
      await connectHost(host);
      await reload();
      // The link takes a few seconds to come up; read once more when it should be.
      later(5_000);
      return { card: null, note: null };
    });
  }, [run, reload, later]);

  const onBootStart = useCallback((host: string) => {
    void run(`${host}:boot`, 'set it up', async () => {
      const card = (await setUpBootStart(host)).host;
      const d = card.daemon;
      // A finished setup hands the daemon to its service, which drops the link for a moment.
      if (!card.connection.connected) { later(5_000); return { card: null, note: 'Set up. Walnut reconnects to it now.' }; }
      if (d?.bootStart?.setupRunning) { later(15_000); return { card, note: null }; }
      if (d?.startsAfterReboot) return { card, note: null };
      return { card, note: `Checked just now: ${(d?.reboot ?? 'it still does not start by itself after a reboot').replace(/`/g, '')}.` };
    });
  }, [run, later]);

  const onPick = useCallback((host: string) => {
    const el = document.getElementById(`hf-card-${host}`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }, []);

  const live = hosts?.filter(isLive) ?? [];
  const off = hosts?.filter((h) => !isLive(h)) ?? [];
  const sum = hosts ? fleetSummary(hosts, now) : null;
  const updated = new Date(now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <section className="hf-dash" data-testid="host-fleet" aria-labelledby="hf-dash-title">
      <div className="hf-dash-head">
        <h4 className="hf-dash-title" id="hf-dash-title">Overview</h4>
        {hosts && <span className="hf-dash-updated">Updated {updated}</span>}
      </div>
      {error && <p className="hf-error" role="status">Could not refresh the overview: {error}.{hosts ? ' Showing the last cards.' : ''}</p>}
      {!hosts && !error && <p className="hf-loading">Reading each host...</p>}
      {hosts && sum && (
        <>
          <div className="hf-stats" data-testid="host-fleet-summary">
            <Stat testId="host-fleet-stat-online" value={`${sum.online}/${sum.total}`} label="Hosts online" tone={sum.online < sum.total ? 'warn' : 'good'} />
            <Stat testId="host-fleet-stat-sessions" value={sum.sessions === null ? '?' : String(sum.sessions)} label="Sessions open" />
            <Stat testId="host-fleet-stat-spend" value={sum.spendUsd === null ? '?' : usd(sum.spendUsd)} label="Spend, 30 days" title="At list price, not a bill" />
            <Stat testId="host-fleet-stat-problems" value={sum.problems ? String(sum.problems) : 'None'} label={sum.problems === 1 ? 'Host needs a look' : 'Hosts need a look'} tone={sum.problems ? 'warn' : 'good'} title="Hosts that are not connected, or have a line under their card" />
          </div>
          <div className="hf-panel hf-topo-panel">
            <HostFleetTopology hosts={hosts} onPick={onPick} />
          </div>
          <div className="hf-grid">
            {live.map((h) => <HostFleetCard key={h.host} host={h} now={now} action={actions[`${h.host}:boot`]} onBootStart={onBootStart} />)}
          </div>
          {off.length > 0 && (
            <div className="hf-panel hf-off-list" data-testid="host-fleet-offline-list">
              <p className="hf-off-head">Not connected ({off.length})</p>
              {off.map((h) => <HostFleetOfflineRow key={h.host} host={h} now={now} action={actions[`${h.host}:connect`]} onConnect={onConnect} />)}
            </div>
          )}
        </>
      )}
    </section>
  );
}
