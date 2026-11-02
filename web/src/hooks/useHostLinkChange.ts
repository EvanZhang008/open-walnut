/**
 * For a surface that polls its own snapshot of hosts (the fleet overview, the machines
 * that joined with a link): read it again when a host connects or drops, from the live
 * host frames, instead of at its next refresh. 2026-11-02: a machine that had just
 * connected still read "Not connected" and "Connecting to it" on the overview for up to
 * 30 s.
 */
import { useEffect, useRef } from 'react';
import { useAllHostStatus, useHostStatusHydration } from './useHostStatus';

const COALESCE_MS = 400;

/**
 * Did a host connect or drop between two reads (host -> '1' connected, '0' not)? A host first
 * heard of counts when every host counts (`countNew`: it is new to the list), or when it is
 * already connected (the snapshot read it as not connected).
 */
export function linkMoved(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>, countNew: boolean): boolean {
  return [...next].some(([host, on]) => (prev.has(host) ? prev.get(host) !== on : countNew || on === '1'));
}

/** `hosts`: only these count. Without it every host counts, and one that appears too. */
export function useHostLinkChange(onChange: () => void, hosts?: readonly string[]): void {
  const statuses = useAllHostStatus();
  // Until the store has heard from the server, what fills it is no change (each page open
  // would read once more for nothing).
  const hydration = useHostStatusHydration();
  const settled = hydration !== 'never' && hydration !== 'pending';
  const watched = hosts ? statuses.filter((s) => hosts.includes(s.host)) : statuses;
  const key = watched.map((s) => `${s.host}\u0000${s.connected ? 1 : 0}`).join('\u0001');
  const countNew = !hosts;
  const seen = useRef<Map<string, string> | null>(null);
  const latest = useRef(onChange);
  const timer = useRef<number | null>(null);
  useEffect(() => { latest.current = onChange; }, [onChange]);
  useEffect(() => {
    const next = new Map(key ? key.split('\u0001').map((x) => x.split('\u0000') as [string, string]) : []);
    const prev = seen.current;
    seen.current = next;
    if (!prev || !settled) return;
    const moved = linkMoved(prev, next, countNew);
    // Several hosts moving at once (a reconnect after sleep) read it once.
    if (moved && timer.current === null) {
      timer.current = window.setTimeout(() => { timer.current = null; latest.current(); }, COALESCE_MS);
    }
  }, [key, countNew, settled]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }, []);
}
