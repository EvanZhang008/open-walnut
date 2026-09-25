/**
 * Module-level store behind the live host-connect banner.
 *
 * Module scope, not component state: the banner moves between two mounts (the
 * Ask Walnut slot, or the leftmost draft column while a draft has borrowed the
 * chat spot), and a move must not restart the 1.5s threshold or bring back a
 * banner the user dismissed. Fed only by the host status store (WS push + one
 * hydrate), so it never polls; its one timer runs only while the view is due to
 * change by itself (a threshold, a ticking elapsed count, the success hold).
 */
import { useSyncExternalStore } from 'react';
import {
  getAllHostStatus, getHostStatusHydration, subscribeHostStatus,
} from '@/hooks/useHostStatus';
import {
  EMPTY_BANNER, bannerView, dismissBanner, ingestHostStatuses, settleBanner,
  type BannerState, type BannerView,
} from '@/utils/host-connect-banner';

const HIDDEN: BannerView = { mode: 'hidden', rows: [], wakeInMs: null };

let state: BannerState = EMPTY_BANNER;
let view: BannerView = HIDDEN;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeHosts: (() => void) | null = null;
const listeners = new Set<() => void>();

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function recompute(): void {
  const now = clock();
  if (getHostStatusHydration() === 'done') {
    state = settleBanner(ingestHostStatuses(state, getAllHostStatus(), now), now);
    view = bannerView(state, now);
  } else {
    view = HIDDEN;
  }
  if (timer) { clearTimeout(timer); timer = null; }
  if (listeners.size && view.wakeInMs !== null) {
    timer = setTimeout(() => { timer = null; recompute(); }, Math.max(50, Math.ceil(view.wakeInMs)));
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!unsubscribeHosts) unsubscribeHosts = subscribeHostStatus(recompute);
  recompute();
  return () => {
    listeners.delete(cb);
    if (listeners.size) return;
    unsubscribeHosts?.();
    unsubscribeHosts = null;
    if (timer) { clearTimeout(timer); timer = null; }
  };
}

function snapshot(): BannerView {
  return view;
}

/** The banner's current view; re-renders on every host push and timed change. */
export function useHostConnectBanner(): BannerView {
  return useSyncExternalStore(subscribe, snapshot);
}

/** The × button: hide what is on screen until a host starts a new attempt. */
export function dismissHostConnectBanner(): void {
  state = dismissBanner(state, clock());
  recompute();
}

/** Test hook. */
export function __resetHostConnectBannerForTests(): void {
  state = EMPTY_BANNER;
  view = HIDDEN;
  if (timer) { clearTimeout(timer); timer = null; }
}
