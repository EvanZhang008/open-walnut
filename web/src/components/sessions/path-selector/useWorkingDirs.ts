/**
 * useWorkingDirs: the folder picker's view of `GET /api/sessions/working-dirs`
 * (session history + configured hosts), stale-while-revalidate.
 *
 * The answer is cached for the page's life (see api/working-dirs-cache.ts). The
 * picker used to read only that cache, so a host added in Settings after the page
 * loaded had no tab and the All tab never listed it. Now each open renders the
 * cached answer at once and refetches; the fresh answer replaces it only when it
 * differs (an equal answer is the same object, so nothing re-renders). While the
 * picker is open, a `config:changed` that may touch hosts refetches too. Every
 * answer re-runs the per-host pre-warm, which skips hosts already warmed on this
 * page, so only a newly appeared host gets a connect.
 */
import { useEffect, useRef, useState } from 'react';
import {
  peekWorkingDirs, prewarmWorkingDirs, refreshWorkingDirs, revalidateWorkingDirs,
  type ConfiguredHost, type WorkingDirEntry, type WorkingDirsResult,
} from '@/api/sessions';
import { configChangeMayAffectHosts } from '@/api/working-dirs-cache';
import { wsClient } from '@/api/ws';
import { hydrateHostStatus } from '@/hooks/useHostStatus';

export interface WorkingDirsState {
  dirs: WorkingDirEntry[];
  /** Every enabled host from config.hosts, including ones with no history yet. */
  hosts: ConfiguredHost[];
  /** True only while there is nothing to show yet (a cold cache). */
  loading: boolean;
  error: string | null;
}

export function useWorkingDirs(open: boolean): WorkingDirsState {
  const [dirs, setDirs] = useState<WorkingDirEntry[]>([]);
  const [hosts, setHosts] = useState<ConfiguredHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hostsRef = useRef<ConfiguredHost[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const apply = (r: WorkingDirsResult) => {
      if (!alive) return;
      hostsRef.current = r.hosts;
      setDirs(r.dirs);
      setHosts(r.hosts);
      setLoading(false);
      setError(null);
      // Pre-warm only once the host statuses are known: prewarmWorkingDirs skips
      // hosts that are off, connected, connecting, or failed for good, and before
      // the first answer it would see none of that and dial every host.
      void hydrateHostStatus().catch(() => {}).then(() => { if (alive) prewarmWorkingDirs(r); });
    };
    const cached = peekWorkingDirs();
    if (cached) apply(cached);
    else { setLoading(true); setError(null); }

    const settle = (p: Promise<WorkingDirsResult>) => p.then(apply).catch((e: unknown) => {
      if (!alive) return;
      // A failed refetch keeps whatever is already on screen.
      if (!hostsRef.current) setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    });
    void settle(revalidateWorkingDirs());

    const onConfigChanged = (data: unknown) => {
      if (configChangeMayAffectHosts(data, hostsRef.current)) void settle(refreshWorkingDirs());
    };
    wsClient.onEvent('config:changed', onConfigChanged);
    return () => {
      alive = false;
      wsClient.offEvent('config:changed', onConfigChanged);
    };
  }, [open]);

  return { dirs, hosts, loading, error };
}
