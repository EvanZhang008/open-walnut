/**
 * useLiveDirs — live directory listing with multi-host fan-out.
 *
 * All-tab: parallel listDirs to local + every configured host, PROGRESSIVE
 * rendering (each host's result lands independently; local is fastest and
 * shows first). A host that errors/times out shows status:'error' — the UI
 * renders it as a subtle "not responding" row, never a modal.
 *
 * Epoch guard: every debounce fire bumps an epoch; responses from stale
 * epochs are discarded so a slow SSH reply can't clobber newer input.
 */

import { useState, useEffect, useRef } from 'react';
import { listDirsCached, type ConfiguredHost } from '@/api/sessions';

export interface HostLiveState {
  status: 'loading' | 'done' | 'error';
  parent: string;
  exists: boolean;
  dirs: string[];
  error?: string;
}

export interface LiveDirsResult {
  /** Keyed by host alias ('__local__' for local). Empty when no live listing active. */
  byHost: Map<string, HostLiveState>;
  anyLoading: boolean;
}

const DEBOUNCE_MS = 150;

export function useLiveDirs(
  activePath: string,
  hostFilter: string,
  configuredHosts: ConfiguredHost[],
): LiveDirsResult {
  const [byHost, setByHost] = useState<Map<string, HostLiveState>>(new Map());
  const epochRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable key for configuredHosts (avoid refiring on referentially-new but equal arrays)
  const hostsKey = configuredHosts.map(h => h.alias).join(',');

  useEffect(() => {
    // Invalidate any in-flight batch immediately — even before deciding to fetch.
    const epoch = ++epochRef.current;

    if (!activePath || activePath.length < 2) {
      setByHost(prev => (prev.size === 0 ? prev : new Map()));
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (epoch !== epochRef.current) return;

      const targets: (string | null)[] = hostFilter === 'all'
        ? [null, ...configuredHosts.map(h => h.alias)]
        : [hostFilter === '__local__' ? null : hostFilter];

      // Seed all targets as loading in one update
      setByHost(() => {
        const next = new Map<string, HostLiveState>();
        for (const t of targets) {
          next.set(t ?? '__local__', { status: 'loading', parent: '', exists: true, dirs: [] });
        }
        return next;
      });

      for (const target of targets) {
        const key = target ?? '__local__';
        listDirsCached(activePath, target)
          .then(listing => {
            if (epoch !== epochRef.current) return; // stale response — drop
            setByHost(prev => {
              const next = new Map(prev);
              next.set(key, { status: 'done', parent: listing.parent, exists: listing.exists, dirs: listing.dirs });
              return next;
            });
          })
          .catch(err => {
            if (epoch !== epochRef.current) return;
            setByHost(prev => {
              const next = new Map(prev);
              next.set(key, {
                status: 'error', parent: '', exists: true, dirs: [],
                error: err instanceof Error ? err.message : String(err),
              });
              return next;
            });
          });
      }
    }, DEBOUNCE_MS);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, hostFilter, hostsKey]);

  let anyLoading = false;
  for (const state of byHost.values()) {
    if (state.status === 'loading') { anyLoading = true; break; }
  }
  return { byHost, anyLoading };
}
