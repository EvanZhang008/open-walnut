/**
 * Settings › Remote Hosts › Overview: the fleet as a dashboard (GET /api/v1/hosts?cached=1,
 * server: src/core/hosts/fleet-refresh.ts). Agents read the same cards with `host_list`.
 *
 * From the top: a summary strip (hosts online, sessions open, 30 day spend,
 * hosts with a problem), a diagram of how Walnut reaches each host
 * (HostFleetTopology.tsx), one card per live host (HostFleetCard.tsx), then the
 * hosts Walnut is not connected to, one compact row each with Connect. It sits
 * in the section beside the Hosts group, never inside one, so no card is nested
 * in a card.
 *
 * It opens on what each host answered last, at once (the last answer this browser kept,
 * fleet-last.ts, then the server's cached read), and says how old each card is; a value
 * stays on screen until a newer reading replaces it, however old
 * (2026-11-03, the user: "just show cache and fetch when user click"). The hosts are
 * read again only on a press: opening the Overview, Refresh, a card's Details, a host's
 * "What Walnut knows" or Set up. A host never read, or read only before its link came up
 * (a Connect included), is read once on its own per link.
 * While a read runs the page polls the cached read, so each card changes as its own
 * read ends; a failed one keeps its card and says why. A host that connects or drops
 * (useHostLinkChange) reads the cached cards again, which costs no host a round trip:
 * the server holds the link state itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFleet, onFleetRefresh, refreshFleet, setUpBootStart, type FleetHost } from '@/api/hosts-fleet';
import { keepFleet, lastFleet } from '@/api/fleet-last';
import { connectHost } from '@/api/hosts';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { useHostLinkChange } from '@/hooks/useHostLinkChange';
import { usePersistentState } from '@/hooks/usePersistentState';
import { fleetSummary, isLive } from './host-fleet-dashboard-model';
import { usd } from './host-fleet-model';
import { followRead, markRefreshing, newestRead, READ_OLD_MS, ownReadKey, readOnOpen, readAgo, replaceCard, shownHosts } from './host-fleet-read-model';
import { HostFleetCard, HostFleetOfflineRow, type ActionState } from './HostFleetCard';
import { HostFleetTopology } from './HostFleetTopology';
import { FleetNumber } from './FleetNumber';
import { ChevronGlyph } from '../settings-glyphs';
import '@/styles/host-status.css';
import '@/styles/host-fleet.css';

/** How often the cached read is asked again while a read of the hosts runs. */
const POLL_MS = 1_500;
/** The "read N min ago" words age on this clock; nothing is fetched by it. */
const TICK_MS = 30_000;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * When this page last read a host on its own (never read, or this computer's old card). Kept
 * for the tab, not the mount: the section mounts again as hosts connect, and each mount must not
 * read the host again.
 */
const openAsks = new Map<string, number>();
const askedOnOpen = (host: string, now: number) => now - (openAsks.get(host) ?? -Infinity) < READ_OLD_MS;

function errorText(err: unknown): string {
  return (err instanceof ApiError || err instanceof Error ? err.message : String(err)).replace(/[.\s]*$/, '');
}

function Stat({ value, label, tone, testId, title, why }: { value: string | null; label: string; tone?: string; testId: string; title?: string; why?: string }) {
  return (
    <div className="hf-stat" data-testid={testId} data-tone={tone} title={title}>
      <FleetNumber className="hf-stat-value" value={value} unknown={value === null ? { why: why ?? 'not known yet', title: title ?? label } : null} />
      <span className="hf-stat-label">{label}</span>
    </div>
  );
}

export function HostFleetGroup() {
  const [open, setOpen] = usePersistentState<boolean>('walnut-host-fleet-open', true, isBool);
  // The last answer this browser kept paints at once; the server's read replaces it.
  const [hosts, setHosts] = useState<FleetHost[] | null>(lastFleet);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const inflight = useRef<AbortController | null>(null);
  // A read asked for while one runs: done once that one ends (never cutting it off).
  const readAgain = useRef(false);
  const pollTimer = useRef<number | null>(null);
  // When this page first saw the running read (followRead); null while none runs.
  const followSince = useRef<number | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(async (): Promise<void> => {
    if (inflight.current) { readAgain.current = true; return; }
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const r = await fetchFleet({ signal: ctrl.signal });
      // A host never read, or one whose card is old, is read once (only while the Overview is
      // open), marked as being read in this same paint so its empty card never flashes.
      const keyOf = new Map(r.hosts.map((h) => [h.host, ownReadKey(h)]));
      const unread = openRef.current ? readOnOpen(r.hosts, Date.now()).filter((h) => !askedOnOpen(keyOf.get(h) ?? h, Date.now())) : [];
      const follow = followRead(followSince.current, r.refreshing === true, Date.now());
      followSince.current = follow.since;
      setHosts(unread.length ? markRefreshing(r.hosts, unread) : r.hosts);
      keepFleet(r.hosts);
      setRefreshing(follow.poll || unread.length > 0);
      setError(null);
      setNow(Date.now());
      if (follow.poll && pollTimer.current === null) {
        pollTimer.current = window.setTimeout(() => { pollTimer.current = null; void load(); }, POLL_MS);
      }
      if (unread.length) {
        for (const h of unread) openAsks.set(keyOf.get(h) ?? h, Date.now());
        void refreshFleet(unread).catch((err) => {
          // Not read after all: their cards show as not read yet, and Refresh is back.
          setRefreshError(errorText(err));
          setRefreshing(false);
          setHosts((list) => list?.map((h) => (unread.includes(h.host) ? { ...h, refreshing: false } : h)) ?? list);
        });
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const msg = errorText(err);
      log.warn('host-fleet', 'fleet read failed', { error: msg });
      setError(msg);
      // Whether a read still runs is not known now: Refresh is back for the next press.
      setRefreshing(false);
    } finally {
      if (inflight.current === ctrl) inflight.current = null;
      if (readAgain.current && !inflight.current && !ctrl.signal.aborted) { readAgain.current = false; void load(); }
    }
  }, []);

  useEffect(() => {
    void load();
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    // A read of the hosts started here or by another part of the page ("What Walnut knows"): follow it.
    const off = onFleetRefresh((names) => {
      followSince.current = Date.now();
      setRefreshing(true);
      setHosts((list) => (list ? markRefreshing(list, names) : list));
      void load();
    });
    return () => {
      window.clearInterval(tick);
      off();
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [load]);

  /** Read these hosts again (every host with none named); the cards follow as each read ends. */
  const refresh = useCallback((names?: string[]) => {
    setRefreshError(null);
    void refreshFleet(names).catch((err) => {
      // An older server has no refresh: its read is live, so read that.
      if (err instanceof ApiError && err.status === 404) { void load(); return; }
      const msg = errorText(err);
      log.warn('host-fleet', 'fleet refresh failed', { hosts: names ?? 'all', error: msg });
      setRefreshError(msg);
    });
  }, [load]);

  const timers = useRef(new Set<number>());
  const after = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => { timers.current.delete(id); fn(); }, ms);
    timers.current.add(id);
  }, []);
  const later = useCallback((ms: number, names: string[]) => after(ms, () => refresh(names)), [after, refresh]);
  useEffect(() => {
    const pending = timers.current;
    return () => { for (const id of pending) window.clearTimeout(id); pending.clear(); };
  }, []);

  // A host that connects, drops or is new: the cached read carries the live link, at no host's cost.
  const readCached = useCallback(() => { void load(); }, [load]);
  useHostLinkChange(readCached);

  const onToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) refresh();
  }, [open, setOpen, refresh]);

  /**
   * One press per button at a time (keyed host and kind, so a card's Set up never shows on its
   * row's Connect); a refusal stays on that host until the next press, and so does what a check found.
   */
  const run = useCallback(async (key: string, what: string, act: () => Promise<{ card: FleetHost | null; note: string | null }>) => {
    setActions((a) => ({ ...a, [key]: { busy: true, error: null } }));
    try {
      const { card, note } = await act();
      if (card) setHosts((list) => (list ? replaceCard(list, card, Date.now()) : list));
      setActions((a) => ({ ...a, [key]: { busy: false, error: null, note } }));
      setNow(Date.now());
    } catch (err) {
      const msg = errorText(err);
      log.warn('host-fleet', `${what} failed`, { key, error: msg });
      setActions((a) => ({ ...a, [key]: { busy: false, error: `Could not ${what}: ${msg}.` } }));
    }
  }, []);

  /**
   * Connect only dials: the host is read once on its new link, by the server when it connects
   * and by load's once-per-link rule (readOnOpen, ownReadKey), never by the press itself.
   * 2026-11-04: the press read it at once (while it was still dialing) and again 5 s later, on
   * top of that per-link read, so one Connect read the host two or three times.
   */
  const onConnect = useCallback((host: string) => {
    void run(`${host}:connect`, 'connect', async () => {
      await connectHost(host);
      void load();
      // The link takes a few seconds to come up; look at the cached read again when it should
      // be, in case no link change reached this page.
      after(5_000, () => { void load(); });
      return { card: null, note: null };
    });
  }, [run, load, after]);

  const onBootStart = useCallback((host: string) => {
    void run(`${host}:boot`, 'set it up', async () => {
      const card = (await setUpBootStart(host)).host;
      const d = card.daemon;
      // A finished setup hands the daemon to its service, which drops the link for a moment.
      if (!card.connection.connected) { later(5_000, [host]); return { card: null, note: 'Set up. Walnut reconnects to it now.' }; }
      if (d?.bootStart?.setupRunning) { later(15_000, [host]); return { card, note: null }; }
      if (d?.startsAfterReboot) return { card, note: null };
      return { card, note: `Checked just now: ${(d?.reboot ?? 'it still does not start by itself after a reboot').replace(/`/g, '')}.` };
    });
  }, [run, later]);

  const onDetails = useCallback((host: string) => refresh([host]), [refresh]);

  const onPick = useCallback((host: string) => {
    const el = document.getElementById(`hf-card-${host}`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }, []);

  const shown = hosts ? shownHosts(hosts) : [];
  const pending = (hosts?.length ?? 0) - shown.length;
  const live = shown.filter(isLive);
  const off = shown.filter((h) => !isLive(h));
  const sum = shown.length ? fleetSummary(shown, now) : null;
  const newest = hosts ? newestRead(hosts) : null;

  return (
    <section className="hf-dash" data-testid="host-fleet" data-open={open ? 'true' : 'false'} aria-labelledby="hf-dash-title">
      <div className="hf-dash-head">
        <h4 className="hf-dash-title" id="hf-dash-title">
          <button type="button" className="hf-dash-toggle" aria-expanded={open} onClick={onToggle} data-testid="host-fleet-toggle">
            <ChevronGlyph size={12} className="settings-disclosure-chevron" />
            Overview
          </button>
        </h4>
        <span className="hf-dash-read">
          {refreshing ? <span className="hf-refreshing" role="status" data-testid="host-fleet-refreshing">Refreshing...</span> : (
            <>
              {newest !== null && <span className="hf-dash-updated" data-testid="host-fleet-read" title={new Date(newest).toLocaleString()}>Read {readAgo(newest, now)}</span>}
              <button type="button" className="hf-link" onClick={() => refresh()} data-testid="host-fleet-refresh" aria-label="Read every host again">Refresh</button>
            </>
          )}
        </span>
      </div>
      {open && (
        <>
          {error && <p className="hf-error" role="status">Could not read the overview: {error}.{hosts ? ' Showing the last cards.' : ''}</p>}
          {refreshError && <p className="hf-error" role="status" data-testid="host-fleet-refresh-error">Could not read the hosts again: {refreshError}.{newest !== null ? ` Showing what was read ${readAgo(newest, now)}.` : ''}</p>}
          {hosts && !shown.length && pending > 0 && <p className="hf-loading" data-testid="host-fleet-reading">Reading each host...</p>}
          {sum && (
            <>
              <div className="hf-stats" data-testid="host-fleet-summary">
                <Stat testId="host-fleet-stat-online" value={`${sum.online}/${sum.total}`} label="Hosts online" tone={sum.online < sum.total ? 'warn' : 'good'} />
                <Stat testId="host-fleet-stat-sessions" value={sum.sessions === null ? null : String(sum.sessions)} label="Sessions open" why={sum.online ? 'no host counted yet' : 'no host connected'} />
                <Stat testId="host-fleet-stat-spend" value={sum.spendUsd === null ? null : usd(sum.spendUsd)} label="Spend, 30 days" title="At list price, not a bill" why="not counted yet" />
                <Stat testId="host-fleet-stat-problems" value={sum.problems ? String(sum.problems) : 'None'} label={sum.problems === 1 ? 'Host needs a look' : 'Hosts need a look'} tone={sum.problems ? 'warn' : 'good'} title="Hosts that are not connected, or have a line under their card" />
              </div>
              <div className="hf-panel hf-topo-panel">
                <HostFleetTopology hosts={shown} onPick={onPick} />
              </div>
              {pending > 0 && <p className="hf-loading hf-loading-more" data-testid="host-fleet-reading">Reading {pending === 1 ? '1 more host' : `${pending} more hosts`}...</p>}
              <div className="hf-grid">
                {live.map((h) => <HostFleetCard key={h.host} host={h} now={now} action={actions[`${h.host}:boot`]} onBootStart={onBootStart} onDetails={onDetails} />)}
              </div>
              {off.length > 0 && (
                <div className="hf-panel hf-off-list" data-testid="host-fleet-offline-list">
                  <p className="hf-off-head">Not connected ({off.length})</p>
                  {off.map((h) => <HostFleetOfflineRow key={h.host} host={h} now={now} action={actions[`${h.host}:connect`]} onConnect={onConnect} onDetails={onDetails} />)}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
