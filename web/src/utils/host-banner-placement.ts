/**
 * Where the home attention banner is mounted right now: the Ask Walnut slot,
 * the leftmost draft column (slot hidden), or nowhere (neither on screen).
 * MainPage publishes it; the sidebar reads it, so a host problem is never
 * invisible: with no banner on screen, the rail's Settings entry wears a warn dot.
 *
 * MainPage stays mounted (hidden) on every other route, so its placement says
 * nothing there: off the home route the banner is never on screen, and the
 * rail dot is the only place left to say it.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getAllHostStatus, serverNow, subscribeHostStatus } from '@/hooks/useHostStatus';
import { nextBanner, type BannerInput } from '@/utils/attention-banner-model';
import { getHostDismissed, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { getUserEngagedHosts, subscribeUserRetry } from '@/utils/host-user-retrying';

export type HostBannerPlacement = 'slot' | 'draft' | 'none';

let placement: HostBannerPlacement = 'slot';
const listeners = new Set<() => void>();

export function setHostBannerPlacement(next: HostBannerPlacement): void {
  if (next === placement) return;
  placement = next;
  for (const l of listeners) l();
}

export function getHostBannerPlacement(): HostBannerPlacement {
  return placement;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useHostBannerPlacement(): HostBannerPlacement {
  return useSyncExternalStore(subscribe, getHostBannerPlacement, getHostBannerPlacement);
}

/** Placement rule: the slot when it shows, else the leftmost draft column, else none. */
export function placementFor(chatVisible: boolean, hasDraftColumn: boolean): HostBannerPlacement {
  return chatVisible ? 'slot' : hasDraftColumn ? 'draft' : 'none';
}

/** The rail dot shows when a host needs attention and no banner is on screen (another route counts as none). */
export function railDotShows(attention: boolean, where: HostBannerPlacement, pathname: string): boolean {
  return attention && (where === 'none' || pathname !== '/');
}

/**
 * Would the banner give any host a row right now? The SAME model the banner
 * runs (from an empty state: no row is on screen for the rail), so a dismissed
 * row, a discovered host nobody reached for, and a reconnect younger than
 * 2 minutes light nothing. `wakeAt` is the next time the answer can flip
 * without a new frame (the 2-minute reconnect line).
 */
export function hostAttentionOf(input: Pick<BannerInput, 'statuses' | 'dismissed' | 'now' | 'engaged'>): { on: boolean; wakeAt: number | null } {
  const { view } = nextBanner(input);
  return { on: view.rows.some((r) => r.type !== 'ready') || view.more > 0, wakeAt: view.wakeAt };
}

function current(): { on: boolean; wakeAt: number | null } {
  return hostAttentionOf({ statuses: getAllHostStatus(), dismissed: getHostDismissed(), now: serverNow(), engaged: getUserEngagedHosts() });
}

function subscribeAttention(cb: () => void): () => void {
  const a = subscribeHostStatus(cb);
  const b = subscribeHostDismissed(cb);
  const c = subscribeUserRetry(cb);
  return () => { a(); b(); c(); };
}

/**
 * The rail's boolean. Primitive snapshots, so the rail re-renders when the
 * answer flips, not on every host frame; a timer re-reads at `wakeAt`.
 */
export function useHostAttentionNeeded(): boolean {
  const [tick, setTick] = useState(0);
  // `tick` in the getter's identity makes a timer wake re-read the clock.
  const getOn = useCallback(() => current().on, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const getWake = useCallback(() => current().wakeAt, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = useSyncExternalStore(subscribeAttention, getOn, () => false);
  const wakeAt = useSyncExternalStore(subscribeAttention, getWake, () => null);
  useEffect(() => {
    if (wakeAt === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, wakeAt - serverNow()) + 30);
    return () => clearTimeout(t);
  }, [wakeAt, tick]);
  return on;
}

/** Test hook. */
export function __resetHostBannerPlacementForTests(): void {
  placement = 'slot';
  listeners.clear();
}
