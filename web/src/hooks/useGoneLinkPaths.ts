import { useEffect, useMemo, useState } from 'react';
import { fetchPathsExist } from '@/api/files';
import { log } from '@/utils/log';

/**
 * The file paths of a task's link tags the session header leaves out: a file that no longer
 * exists on the session's host (a report in /tmp is often cleaned away; 2026-10-26, the user: "if
 * a file is removed please don't show the tag"), and one not checked yet (`checked` is false until
 * every path has an answer, or for MAX_HOLD_MS at most, and the header draws its pills only then,
 * so a removed file's pill never flashes in and out and the head pill never swaps). One small request per header, answered
 * from a cache for a minute so a list of panels never asks twice. It asks again every minute while
 * the window is visible and when the window comes back, so a file that returns brings its pill
 * back. A path the server could not answer for, or a check that failed, is shown: a link is never
 * hidden on a guess. A path known to exist is drawn from the cache at once, even when that answer
 * is a few minutes old and the recheck is on its way (else every live pill would blink instead).
 */
const TTL_MS = 60_000;
/** The window came back: a path checked longer ago than this is asked again. */
const REFOCUS_MIN_AGE_MS = 5_000;
/** The longest the header holds its pills for an answer; past it, what is not known is shown. */
const MAX_HOLD_MS = 3_000;
const cache = new Map<string, { at: number; gone: boolean }>();
const inflight = new Map<string, Promise<void>>();

const keyOf = (host: string | undefined, path: string) => `${host ?? ''}\u0000${path}`;
const NONE: Set<string> = new Set();

function hiddenFromCache(host: string | undefined, paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    const hit = cache.get(keyOf(host, path));
    if (!hit || hit.gone) out.add(path);
  }
  return out;
}

/** Whether every path has an answer (a check that failed counts: its links are shown). */
export function allChecked(host: string | undefined, paths: readonly string[]): boolean {
  return paths.every((path) => cache.has(keyOf(host, path)));
}

export function useGoneLinkPaths(paths: readonly string[], host: string | undefined, enabled: boolean): { hidden: Set<string>; checked: boolean } {
  const joined = paths.join('\n');
  const list = useMemo(() => (joined ? joined.split('\n') : []), [joined]);
  // Bumped when an answer lands; the set is read from the cache while rendering, so a new
  // path is hidden in the very render that brings it (never drawn, then hidden after paint).
  const [version, setVersion] = useState(0);
  // Bumped to ask again: { the age past which a path is asked again }.
  const [recheck, setRecheck] = useState({ maxAge: TTL_MS });
  const active = enabled && list.length > 0;
  // The list the hold ran out for (a new list waits again, for its own answer).
  const [heldOut, setHeldOut] = useState('');
  useEffect(() => {
    if (!active || allChecked(host, list)) return;
    const timer = window.setTimeout(() => setHeldOut(joined), MAX_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [active, host, list, joined, version]);
  useEffect(() => {
    if (!active) return;
    const visible = () => document.visibilityState === 'visible';
    // A tick asks for every path the last tick could not (answers land a little after it).
    const timer = window.setInterval(() => { if (visible()) setRecheck({ maxAge: TTL_MS - REFOCUS_MIN_AGE_MS }); }, TTL_MS);
    const back = () => { if (visible()) setRecheck({ maxAge: REFOCUS_MIN_AGE_MS }); };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [active]);
  useEffect(() => {
    // Off (every task row) or nothing to check: no state change, so no extra render.
    if (!active) return;
    const stale = list.filter((path) => {
      const hit = cache.get(keyOf(host, path));
      return !hit || Date.now() - hit.at > recheck.maxAge;
    });
    if (stale.length === 0) return;
    let live = true;
    const before = JSON.stringify([...hiddenFromCache(host, list), allChecked(host, list)]);
    const reqKey = `${host ?? ''}\u0000${stale.join('\n')}`;
    let req = inflight.get(reqKey);
    if (!req) {
      req = fetchPathsExist(stale, host)
        .then((exists) => {
          const at = Date.now();
          for (const path of stale) cache.set(keyOf(host, path), { at, gone: exists[path] === false });
        })
        .catch((err) => {
          // Not known gone: shown, and asked again on the next round.
          const at = Date.now();
          for (const path of stale) if (!cache.has(keyOf(host, path))) cache.set(keyOf(host, path), { at, gone: false });
          log.warn('link-tags', 'link path check failed', { host, error: String(err) });
        })
        .finally(() => { inflight.delete(reqKey); });
      inflight.set(reqKey, req);
    }
    // Render again only when the answer changed what shows.
    void req.then(() => { if (live && JSON.stringify([...hiddenFromCache(host, list), allChecked(host, list)]) !== before) setVersion((v) => v + 1); });
    return () => { live = false; };
  }, [list, host, active, recheck]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version: the cache changed under us
  const hidden = useMemo(() => {
    if (!active) return NONE;
    const out = hiddenFromCache(host, list);
    // Held long enough: a path with no answer yet is shown (never hidden on a guess).
    if (heldOut === joined) for (const path of list) if (!cache.has(keyOf(host, path))) out.delete(path);
    return out;
  }, [active, host, list, version, heldOut, joined]);
  return { hidden, checked: !active || heldOut === joined || allChecked(host, list) };
}
