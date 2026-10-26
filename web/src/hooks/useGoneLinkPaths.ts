import { useEffect, useMemo, useState } from 'react';
import { fetchPathsExist } from '@/api/files';
import { log } from '@/utils/log';

/**
 * The file paths of a task's link tags that no longer exist on the session's host (a report in
 * /tmp is often cleaned away). One small request per header, answered from a cache for a minute
 * so a list of panels never asks twice; a path the server could not answer for is never gone.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; gone: boolean }>();
const inflight = new Map<string, Promise<void>>();

const keyOf = (host: string | undefined, path: string) => `${host ?? ''}\u0000${path}`;
const NONE: Set<string> = new Set();

function goneFromCache(host: string | undefined, paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths) if (cache.get(keyOf(host, path))?.gone) out.add(path);
  return out;
}

export function useGoneLinkPaths(paths: readonly string[], host: string | undefined, enabled: boolean): Set<string> {
  const joined = paths.join('\n');
  const list = useMemo(() => (joined ? joined.split('\n') : []), [joined]);
  const [gone, setGone] = useState(() => (enabled ? goneFromCache(host, list) : NONE));
  useEffect(() => {
    // Off (every task row) or nothing to check: no state change, so no extra render.
    if (!enabled || list.length === 0) return;
    setGone(goneFromCache(host, list));
    const stale = list.filter((path) => {
      const hit = cache.get(keyOf(host, path));
      return !hit || Date.now() - hit.at > TTL_MS;
    });
    if (stale.length === 0) return;
    let live = true;
    const reqKey = `${host ?? ''}\u0000${stale.join('\n')}`;
    let req = inflight.get(reqKey);
    if (!req) {
      req = fetchPathsExist(stale, host)
        .then((exists) => {
          const at = Date.now();
          for (const path of stale) cache.set(keyOf(host, path), { at, gone: exists[path] === false });
        })
        .catch((err) => { log.warn('link-tags', 'link path check failed', { host, error: String(err) }); })
        .finally(() => { inflight.delete(reqKey); });
      inflight.set(reqKey, req);
    }
    void req.then(() => { if (live) setGone(goneFromCache(host, list)); });
    return () => { live = false; };
  }, [list, host, enabled]);
  return enabled && list.length > 0 ? gone : NONE;
}
