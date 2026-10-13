import { useEffect, useRef } from 'react';
import { fetchDirListMany, type BatchDirListing } from '@/api/files';
import { useEvent } from '@/hooks/useWebSocket';
import { isPageHidden, onPageVisible, visibleInterval } from '@/utils/page-visibility';

const REFRESH_MS = 5_000;
const BATCH_SIZE = 64;

export function useDirectoryRefresh(
  paths: string[],
  host: string | undefined,
  showHidden: boolean,
  onListings: (listings: BatchDirListing[]) => void,
  readRevision: (path: string) => string,
): void {
  const current = useRef({ paths, onListings, readRevision });
  current.current = { paths, onListings, readRevision };
  const refreshRef = useRef<(() => void) | null>(null);

  useEvent('_ws:reconnected', () => refreshRef.current?.());
  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let controller: AbortController | undefined;
    let deferred: string[] = [];
    const refresh = async () => {
      if (cancelled || busy || isPageHidden()) return;
      const visible = new Set(current.current.paths);
      const wanted = [...new Set([...deferred.filter(path => visible.has(path)), ...visible])];
      if (!wanted.length) return;
      busy = true;
      deferred = [];
      try {
        for (let start = 0; start < wanted.length; start += BATCH_SIZE) {
          if (cancelled || isPageHidden()) break;
          const active = new Set(current.current.paths);
          const batch = wanted.slice(start, start + BATCH_SIZE).filter(path => active.has(path));
          if (!batch.length) continue;
          const revisions = new Map(batch.map(path => [path, current.current.readRevision(path)]));
          controller = new AbortController();
          try {
            const result = await fetchDirListMany(batch, host, showHidden, { signal: controller.signal, background: true });
            if (cancelled) break;
            const answered = new Set(result.listings.map(listing => listing.path));
            deferred.push(...batch.filter(path => !answered.has(path)));
            const now = new Set(current.current.paths);
            const fresh = result.listings.filter(listing =>
              now.has(listing.path) && revisions.get(listing.path) === current.current.readRevision(listing.path));
            if (fresh.length) current.current.onListings(fresh);
          } catch {
            // Failed or unserved paths lead the next round, not the same slow prefix.
            deferred.push(...batch);
          }
        }
      } finally {
        busy = false;
      }
    };
    refreshRef.current = () => { void refresh(); };
    const stop = visibleInterval(() => { void refresh(); }, REFRESH_MS, { catchUp: false });
    const offVisible = onPageVisible(() => { void refresh(); });
    return () => {
      cancelled = true;
      controller?.abort();
      refreshRef.current = null;
      stop();
      offVisible();
    };
  }, [host, showHidden]);
}
