/**
 * useLiveDirs — live directory listing with multi-host fan-out.
 *
 * All-tab: parallel listDirs to local + every configured host, PROGRESSIVE
 * rendering (each host's result lands independently; local is fastest and
 * shows first). A host that errors/times out shows status:'error' — the UI
 * renders it as a visible "could not connect" row with the cause and a next
 * step, never a modal.
 *
 * A remote host that is still CONNECTING (first connect installs the session
 * daemon, which can take a minute) answers `pending` with the connect phase;
 * the hook keeps that host in status:'loading' with the phase label and polls
 * until dirs arrive or the connect fails. Polling is bounded so a host that
 * never answers ends in status:'error' rather than spinning forever.
 *
 * The connect is a property of the HOST, not of the prefix being typed: the
 * phase label and the poll clock live in a per-host ref that survives the
 * effect re-running on every keystroke. Otherwise each character replaced the
 * "Installing the daemon…" row with the generic spinner for a round trip, and
 * the give-up clock restarted, so a wedged host was polled for as long as the
 * user kept typing.
 *
 * Epoch guard: every debounce fire bumps an epoch; responses from stale
 * epochs are discarded so a slow SSH reply can't clobber newer input.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { listDirsCached, type ConfiguredHost, type DirListingHostError, type DirListingPending } from '@/api/sessions';

export interface HostLiveState {
  status: 'loading' | 'done' | 'error';
  parent: string;
  exists: boolean;
  dirs: string[];
  /** Transport-level failure text (the request itself failed). */
  error?: string;
  /** Connect progress while status is 'loading' (remote hosts only). */
  pending?: DirListingPending;
  /** Structured connect failure while status is 'error' (remote hosts only). */
  hostError?: DirListingHostError;
}

export interface LiveDirsResult {
  /** Keyed by host alias ('__local__' for local). Empty when no live listing active. */
  byHost: Map<string, HostLiveState>;
  anyLoading: boolean;
  /** Re-list ONE host now (after the user's Retry cleared the server's failure cache). */
  retryHost: (hostKey: string) => void;
}

const DEBOUNCE_MS = 150;
/** Gap between polls while a host answers `pending`. */
export const PENDING_POLL_MS = 1500;
/** Server-side wait on a follow-up poll. The first request waits the server
 *  default (3s) so a warm host answers with dirs in one round trip; once the
 *  host is known to be connecting, a long wait would only pin one of the
 *  browser's 6 connections per pending host for most of each poll cycle. */
export const PENDING_POLL_WAIT_MS = 500;
/** Give up polling a host that keeps answering `pending` after this long. */
export const PENDING_POLL_MAX_MS = 5 * 60_000;
const EMPTY_HOSTS = new Map<string, HostLiveState>();

/** Per-host connect bookkeeping that outlives one effect run. */
interface ConnectTrack {
  startedAt: number;
  pending?: DirListingPending;
}

const LOADING: HostLiveState = { status: 'loading', parent: '', exists: true, dirs: [] };

export function useLiveDirs(
  activePath: string,
  hostFilter: string,
  configuredHosts: ConfiguredHost[],
): LiveDirsResult {
  const [snapshot, setSnapshot] = useState<{ key: string; byHost: Map<string, HostLiveState> }>({ key: '', byHost: EMPTY_HOSTS });
  const epochRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const connectingRef = useRef<Map<string, ConnectTrack>>(new Map());
  // The current batch's fetcher, so retryHost can re-list one host without
  // re-running the whole effect (which would reseed every host to loading).
  const batchRef = useRef<{ epoch: number; targets: (string | null)[]; fetchHost: (target: string | null) => void; markLoading: (key: string) => void } | null>(null);

  // Stable key for configuredHosts (avoid refiring on referentially-new but equal arrays)
  const hostsKey = configuredHosts.map(h => h.alias).join(',');
  const requestKey = JSON.stringify([activePath, hostFilter, hostsKey]);
  const byHost = snapshot.key === requestKey ? snapshot.byHost : EMPTY_HOSTS;

  const clearPollTimers = () => {
    for (const t of pollTimersRef.current) clearTimeout(t);
    pollTimersRef.current.clear();
  };

  useEffect(() => {
    // Invalidate any in-flight batch immediately — even before deciding to fetch.
    const epoch = ++epochRef.current;
    clearPollTimers();
    batchRef.current = null;

    // '' = browse mode (nothing path-like typed). A bare '/' IS a path: it
    // must list the root — the old `length < 2` guard made "/" list nothing.
    if (!activePath) {
      connectingRef.current.clear();
      setSnapshot({ key: requestKey, byHost: EMPTY_HOSTS });
      return;
    }

    const targets: (string | null)[] = hostFilter === 'all'
      ? [null, ...configuredHosts.map(h => h.alias)]
      : [hostFilter === '__local__' ? null : hostFilter];
    const targetKeys = new Set(targets.map(t => t ?? '__local__'));
    // A host that left the target set is no longer being watched.
    for (const key of connectingRef.current.keys()) {
      if (!targetKeys.has(key)) connectingRef.current.delete(key);
    }

    // Seed all targets as loading NOW (not after the debounce), keeping a known
    // connect phase visible: an empty snapshot for even 150ms swaps the host's
    // "Installing the daemon…" row for the generic spinner on every keystroke.
    setSnapshot(() => {
      const next = new Map<string, HostLiveState>();
      for (const key of targetKeys) {
        const track = connectingRef.current.get(key);
        next.set(key, track?.pending ? { ...LOADING, pending: track.pending } : LOADING);
      }
      return { key: requestKey, byHost: next };
    });

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (epoch !== epochRef.current) return;

      const update = (key: string, state: HostLiveState) => {
        setSnapshot(prev => {
          const next = new Map(prev.key === requestKey ? prev.byHost : EMPTY_HOSTS);
          next.set(key, state);
          return { key: requestKey, byHost: next };
        });
      };

      const fetchHost = (target: string | null) => {
        const key = target ?? '__local__';
        const track = connectingRef.current.get(key);
        // Follow-up polls ask the server for a short wait; see PENDING_POLL_WAIT_MS.
        const waitMs = track ? PENDING_POLL_WAIT_MS : undefined;
        listDirsCached(activePath, target, { waitMs })
          .then(listing => {
            if (epoch !== epochRef.current) return; // stale response — drop
            if (listing.hostError) {
              connectingRef.current.delete(key);
              update(key, { status: 'error', parent: '', exists: true, dirs: [], hostError: listing.hostError });
              return;
            }
            if (listing.pending) {
              const startedAt = connectingRef.current.get(key)?.startedAt ?? Date.now();
              if (Date.now() - startedAt > PENDING_POLL_MAX_MS) {
                connectingRef.current.delete(key);
                update(key, {
                  status: 'error', parent: '', exists: true, dirs: [],
                  hostError: {
                    message: 'Still connecting after several minutes',
                    kind: 'timeout',
                    hint: 'The host has not finished connecting. Check the server log for this host, then retry.',
                  },
                });
                return;
              }
              connectingRef.current.set(key, { startedAt, pending: listing.pending });
              update(key, { ...LOADING, pending: listing.pending });
              const t = setTimeout(() => {
                pollTimersRef.current.delete(t);
                if (epoch !== epochRef.current) return;
                fetchHost(target);
              }, PENDING_POLL_MS);
              pollTimersRef.current.add(t);
              return;
            }
            connectingRef.current.delete(key);
            update(key, { status: 'done', parent: listing.parent, exists: listing.exists, dirs: listing.dirs });
          })
          .catch(err => {
            if (epoch !== epochRef.current) return;
            connectingRef.current.delete(key);
            update(key, {
              status: 'error', parent: '', exists: true, dirs: [],
              error: err instanceof Error ? err.message : String(err),
            });
          });
      };

      batchRef.current = { epoch, targets, fetchHost, markLoading: (key) => update(key, LOADING) };
      for (const target of targets) fetchHost(target);
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      clearPollTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, hostFilter, hostsKey]);

  const retryHost = useCallback((hostKey: string) => {
    const batch = batchRef.current;
    if (!batch || batch.epoch !== epochRef.current) return;
    const target = hostKey === '__local__' ? null : hostKey;
    if (!batch.targets.includes(target)) return;
    // A retry is a fresh connect attempt: restart that host's give-up clock.
    connectingRef.current.delete(hostKey);
    batch.markLoading(hostKey);
    batch.fetchHost(target);
  }, []);

  let anyLoading = !!activePath && snapshot.key !== requestKey;
  for (const state of byHost.values()) {
    if (state.status === 'loading') { anyLoading = true; break; }
  }
  return { byHost, anyLoading, retryHost };
}
