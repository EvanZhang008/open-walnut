/**
 * Settings > Remote Hosts: what each host answered last (GET /api/v1/hosts?cached=1, server:
 * src/core/hosts/fleet-refresh.ts), for the one list of machines (RemoteHostsSection.tsx):
 * the summary line, each row's state line and its Details. Agents read the same cards with
 * `host_list`.
 *
 * It opens on what each host answered last, at once (the last answer this browser kept,
 * fleet-last.ts, then the server's cached read); a value stays on screen until a newer reading
 * replaces it, however old (2026-11-03, the user: "just show cache and fetch when user click").
 * The hosts are read again only on a press (Refresh, a row's Details, "What Walnut knows",
 * Set up); a host never read, or read before it connected, is read once on its own. While a
 * read runs the page polls the cached read, so each row changes as its own read ends. A host
 * that connects or drops (useHostLinkChange) reads the cached cards again, which costs no host
 * a round trip: the server holds the link state itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFleet, onFleetRefresh, refreshFleet, setUpBootStart, type FleetHost } from '@/api/hosts-fleet';
import { keepFleet, lastFleet } from '@/api/fleet-last';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { useHostLinkChange } from '@/hooks/useHostLinkChange';
import { followRead, markRefreshing, newestRead, READ_OLD_MS, ownReadKey, readOnOpen, replaceCard, shownHosts } from './host-fleet-read-model';

/** How often the cached read is asked again while a read of the hosts runs. */
const POLL_MS = 1_500;
/** The "read N min ago" words age on this clock; nothing is fetched by it. */
const TICK_MS = 30_000;

/** A press on a row's Set up: running, refused (error), or done with something to say (note). */
export type ActionState = { busy: boolean; error: string | null; note?: string | null };

/**
 * When this page last read a host on its own. Kept for the tab, not the mount: the section
 * mounts again as hosts connect, and each mount must not read the host again.
 */
const openAsks = new Map<string, number>();
const askedOnOpen = (host: string, now: number) => now - (openAsks.get(host) ?? -Infinity) < READ_OLD_MS;

function errorText(err: unknown): string {
  return (err instanceof ApiError || err instanceof Error ? err.message : String(err)).replace(/[.\s]*$/, '');
}

export interface HostFleet {
  /** Every card the server answered (null before the first answer). */
  hosts: FleetHost[] | null;
  /** The cards to show (shownHosts: a never-read host waits for its first read). */
  shown: FleetHost[];
  /** Cards still waiting for their first read. */
  pending: number;
  card: (host: string) => FleetHost | undefined;
  refreshing: boolean;
  error: string | null;
  refreshError: string | null;
  now: number;
  newest: number | null;
  /** Read these hosts again (every host with none named). */
  refresh: (names?: string[]) => void;
  /** Set up the host's daemon to start after a reboot. */
  bootStart: (host: string) => void;
  /** A host removed on this page: out of the list and the counts at once, though the last read names it. */
  forget: (host: string) => void;
  /** Each host's Set up press. */
  boot: Record<string, ActionState>;
}

export function useHostFleet(): HostFleet {
  const [hosts, setHosts] = useState<FleetHost[] | null>(lastFleet);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [boot, setBoot] = useState<Record<string, ActionState>>({});
  const inflight = useRef<AbortController | null>(null);
  // A read asked for while one runs: done once that one ends (never cutting it off).
  const readAgain = useRef(false);
  const pollTimer = useRef<number | null>(null);
  // When this page first saw the running read (followRead); null while none runs.
  const followSince = useRef<number | null>(null);
  // Hosts removed here, kept out until a read no longer names them (2026-11-04: a machine
  // removed from the host network stayed on as a fleet row until the next read).
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(() => new Set());

  const load = useCallback(async (): Promise<void> => {
    if (inflight.current) { readAgain.current = true; return; }
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const r = await fetchFleet({ signal: ctrl.signal });
      // A host never read, or one whose card is old, is read once, marked as being read in this
      // same paint so its empty card never flashes.
      const keyOf = new Map(r.hosts.map((h) => [h.host, ownReadKey(h)]));
      const unread = readOnOpen(r.hosts, Date.now()).filter((h) => !askedOnOpen(keyOf.get(h) ?? h, Date.now()));
      const follow = followRead(followSince.current, r.refreshing === true, Date.now());
      followSince.current = follow.since;
      setHosts(unread.length ? markRefreshing(r.hosts, unread) : r.hosts);
      keepFleet(r.hosts);
      setForgotten((f) => (f.size ? new Set([...f].filter((h) => r.hosts.some((x) => x.host === h))) : f));
      setRefreshing(follow.poll || unread.length > 0);
      setError(null);
      setNow(Date.now());
      if (follow.poll && pollTimer.current === null) {
        pollTimer.current = window.setTimeout(() => { pollTimer.current = null; void load(); }, POLL_MS);
      }
      if (unread.length) {
        for (const h of unread) openAsks.set(keyOf.get(h) ?? h, Date.now());
        void refreshFleet(unread).catch((err) => {
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

  const refresh = useCallback((names?: string[]) => {
    setRefreshError(null);
    // Said at once: the press shows it runs before the server has answered.
    setRefreshing(true);
    void refreshFleet(names).catch((err) => {
      setRefreshing(false);
      // An older server has no refresh: its read is live, so read that.
      if (err instanceof ApiError && err.status === 404) { void load(); return; }
      const msg = errorText(err);
      log.warn('host-fleet', 'fleet refresh failed', { hosts: names ?? 'all', error: msg });
      setRefreshError(msg);
    });
  }, [load]);

  const timers = useRef(new Set<number>());
  const later = useCallback((ms: number, names: string[]) => {
    const id = window.setTimeout(() => { timers.current.delete(id); refresh(names); }, ms);
    timers.current.add(id);
  }, [refresh]);
  useEffect(() => {
    const pending = timers.current;
    return () => { for (const id of pending) window.clearTimeout(id); pending.clear(); };
  }, []);

  // A host that connects, drops or is new: the cached read carries the live link, at no host's cost.
  const readCached = useCallback(() => { void load(); }, [load]);
  useHostLinkChange(readCached);

  const bootStart = useCallback((host: string) => {
    setBoot((a) => ({ ...a, [host]: { busy: true, error: null } }));
    void (async () => {
      try {
        const card = (await setUpBootStart(host)).host;
        const d = card.daemon;
        let note: string | null;
        // A finished setup hands the daemon to its service, which drops the link for a moment.
        if (!card.connection.connected) { later(5_000, [host]); note = 'Set up. Walnut reconnects to it now.'; }
        else if (d?.bootStart?.setupRunning) { later(15_000, [host]); note = null; }
        else if (d?.startsAfterReboot) note = `Set up: ${(d.reboot ?? 'it starts by itself after a reboot').replace(/`/g, '')}.`;
        else note = `Checked just now: ${(d?.reboot ?? 'it still does not start by itself after a reboot').replace(/`/g, '')}.`;
        if (card.connection.connected) setHosts((list) => (list ? replaceCard(list, card, Date.now()) : list));
        setBoot((a) => ({ ...a, [host]: { busy: false, error: null, note } }));
        setNow(Date.now());
      } catch (err) {
        const msg = errorText(err);
        log.warn('host-fleet', 'set it up failed', { host, error: msg });
        setBoot((a) => ({ ...a, [host]: { busy: false, error: `Could not set it up: ${msg}.` } }));
      }
    })();
  }, [later]);

  const forget = useCallback((host: string) => {
    setForgotten((f) => new Set(f).add(host));
    void load();
  }, [load]);

  const readable = hosts ? shownHosts(hosts) : [];
  const shown = forgotten.size ? readable.filter((h) => !forgotten.has(h.host)) : readable;
  // A forgotten host that joins again still finds its card.
  const byHost = new Map(readable.map((h) => [h.host, h]));
  return {
    hosts,
    shown,
    pending: (hosts?.length ?? 0) - readable.length,
    card: (host) => byHost.get(host),
    refreshing,
    error,
    refreshError,
    now,
    newest: hosts ? newestRead(hosts) : null,
    refresh,
    bootStart,
    boot,
    forget,
  };
}
