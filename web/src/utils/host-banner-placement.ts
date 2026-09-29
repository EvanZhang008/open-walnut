/**
 * Where the attention banner is on screen, and who speaks for it when it is not.
 *
 * Placement is the IN-PAGE position MainPage publishes: the task panel when it
 * shows (the primary mount), else the Ask Walnut slot, else the leftmost draft
 * column, else nowhere. The owner is the one mount that renders the card right
 * now: the in-page placement on the home route, else none (MainPage stays
 * mounted, hidden, on every other route, so its placement says nothing there).
 * The notification panel never holds the card: a problem host is its card row
 * at the top of All and Errors (NotificationProblems), and System lists every
 * host once (NotificationHostRow).
 *
 * The rail Settings dot and the bell dot read the PAGE rule only (placement +
 * pathname), never whether the panel is open: the panel is a passing overlay
 * and opening it must not make the rail blink.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { getAllHostStatus, serverNow, subscribeHostStatus } from '@/hooks/useHostStatus';
import { nextBanner, type BannerInput } from '@/utils/attention-banner-model';
import { getHostDismissed, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { getUserEngagedHosts, subscribeUserRetry } from '@/utils/host-user-retrying';

export type HostBannerPlacement = 'tasks' | 'slot' | 'draft' | 'none';
export type HostBannerOwner = HostBannerPlacement;
export type BannerMount = Exclude<HostBannerOwner, 'none'>;

let placement: HostBannerPlacement = 'slot';
const listeners = new Set<() => void>();
const notify = (): void => { for (const l of listeners) l(); };

export function setHostBannerPlacement(next: HostBannerPlacement): void {
  if (next === placement) return;
  placement = next;
  notify();
}

export function getHostBannerPlacement(): HostBannerPlacement {
  return placement;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Placement changes (the owner's store input; the pathname is the router's). */
export const subscribeHostBannerOwner = subscribe;

export function useHostBannerPlacement(): HostBannerPlacement {
  return useSyncExternalStore(subscribe, getHostBannerPlacement, getHostBannerPlacement);
}

// A new host row the card on screen is holding back (the pointer rests where it
// would move things, spec 5.5): the bell carries the host reason until it lands.
let deferredRows = false;

export function setBannerRowsDeferred(on: boolean): void {
  if (on === deferredRows) return;
  deferredRows = on;
  notify();
}

export function getBannerRowsDeferred(): boolean {
  return deferredRows;
}

export function useBannerRowsDeferred(): boolean {
  return useSyncExternalStore(subscribe, getBannerRowsDeferred, getBannerRowsDeferred);
}

/**
 * Placement rule: the task panel when it shows, else the slot, else the
 * leftmost draft column, else none. The two-argument form is the old
 * (chatVisible, hasDraftColumn) call, kept so a caller mid-migration reads the same.
 */
export function placementFor(todoVisible: boolean, chatVisible: boolean, hasDraftColumn?: boolean): HostBannerPlacement {
  if (hasDraftColumn === undefined) return todoVisible ? 'slot' : chatVisible ? 'draft' : 'none';
  return todoVisible ? 'tasks' : chatVisible ? 'slot' : hasDraftColumn ? 'draft' : 'none';
}

/** Which mount renders the card: the in-page placement on Home, else none. */
export function ownerFor(where: HostBannerPlacement, pathname: string): HostBannerOwner {
  return pathname === '/' ? where : 'none';
}

export function useHostBannerOwner(): HostBannerOwner {
  const where = useHostBannerPlacement();
  const { pathname } = useLocation();
  return ownerFor(where, pathname);
}

/** Settings > Remote hosts (or one host's row there): the user is looking at those rows. */
export function onRemoteHostsPane(pathname: string, hash: string): boolean {
  return pathname === '/settings' && (hash === '#remote-hosts' || hash.startsWith('#rh-host-'));
}

/**
 * The rail dot shows when a host needs attention and no banner is on screen
 * (another route counts as none), except on the remote hosts pane itself.
 */
export function railDotShows(attention: boolean, where: HostBannerPlacement, pathname: string, hash = ''): boolean {
  return attention && (where === 'none' || pathname !== '/') && !onRemoteHostsPane(pathname, hash);
}

// ── The bell: a dot when no card on the page says it ──

export type BellReason = 'hosts' | 'local' | 'both' | null;

/** hostUncovered / localUncovered: the problem exists and no in-page card shows it (useAttentionDots). */
export function bellDotReason(hostUncovered: boolean, localUncovered: boolean): BellReason {
  if (hostUncovered && localUncovered) return 'both';
  return hostUncovered ? 'hosts' : localUncovered ? 'local' : null;
}

const REASON_TEXT: Record<Exclude<BellReason, null>, string> = {
  hosts: 'remote hosts need attention',
  local: 'Claude Code needs attention',
  both: 'Claude Code and remote hosts need attention',
};

export interface BellPresentationInput {
  reason: BellReason;
  /** Asks and unread letters: human decisions, the only thing the bell counts. */
  attentionCount: number;
  /** The older system dot (git sync, index). */
  hasIssues: boolean;
  quiet: boolean;
  quietLabel: string;
  collapsed: boolean;
}

export interface BellPresentation {
  ariaLabel: string;
  title: string | undefined;
  /** The single dot (no count). */
  dot: boolean;
  /** The same dot at the count's corner. */
  cornerDot: boolean;
  /**
   * Which dot: 'attention' is the host / Claude Code reason and wears the rail
   * Settings entry's warn dot (one look for one alert); 'system' is the older
   * git sync / index dot, which keeps its own look so it reads as another cause.
   */
  dotKind: 'attention' | 'system' | null;
}

/**
 * The bell's name, tooltip and marks. A count always wins over the dot; a
 * reason next to a count draws the dot at its corner. With no reason the name
 * stays 'Notifications' even when the older system dot shows, so the user can
 * tell a leftover dot is about something else.
 */
export function bellPresentation(i: BellPresentationInput): BellPresentation {
  const counted = i.attentionCount > 0;
  const dot = !counted && (i.reason !== null || i.hasIssues);
  const cornerDot = counted && i.reason !== null;
  const dotKind = i.reason !== null ? 'attention' : dot ? 'system' : null;
  if (i.reason === null) {
    const title = i.quiet ? i.quietLabel : i.collapsed ? 'Notifications' : undefined;
    return { ariaLabel: 'Notifications', title, dot, cornerDot, dotKind };
  }
  const ariaLabel = counted
    ? `Notifications, ${i.attentionCount} waiting; ${REASON_TEXT[i.reason]}`
    : `Notifications: ${REASON_TEXT[i.reason]}`;
  return { ariaLabel, title: i.quiet ? `${i.quietLabel}; ${ariaLabel}` : ariaLabel, dot, cornerDot, dotKind };
}

// ── Host attention off the card's own model ──

type AttentionInput = Pick<BannerInput, 'statuses' | 'dismissed' | 'now' | 'engaged'>;

/**
 * Would the banner give any host a row right now? The SAME model the banner
 * runs (from an empty state: no row is on screen for the rail), so a dismissed
 * row, a discovered host nobody reached for, and a reconnect younger than
 * 2 minutes light nothing. `wakeAt` is the next time the answer can flip
 * without a new frame (the 2-minute reconnect line).
 */
export function hostAttentionOf(input: AttentionInput): { on: boolean; wakeAt: number | null } {
  const { view } = nextBanner(input);
  return { on: view.rows.some((r) => r.type !== 'ready') || view.more > 0, wakeAt: view.wakeAt };
}

function inputNow(): AttentionInput {
  return { statuses: getAllHostStatus(), dismissed: getHostDismissed(), now: serverNow(), engaged: getUserEngagedHosts() };
}

function subscribeAttention(cb: () => void): () => void {
  const a = subscribeHostStatus(cb);
  const b = subscribeHostDismissed(cb);
  const c = subscribeUserRetry(cb);
  return () => { a(); b(); c(); };
}

const readOn = (): boolean => hostAttentionOf(inputNow()).on;
const readWake = (): number | null => hostAttentionOf(inputNow()).wakeAt;

/**
 * A primitive read of the model that re-renders when the answer flips, not on
 * every host frame; a timer re-reads at `wakeAt`.
 */
function useAttentionRead<T extends boolean | string>(read: () => T, fallback: T): T {
  const [tick, setTick] = useState(0);
  // `tick` in the getter's identity makes a timer wake re-read the clock.
  const get = useCallback(() => read(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const getWake = useCallback(() => readWake(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = useSyncExternalStore(subscribeAttention, get, () => fallback);
  const wakeAt = useSyncExternalStore(subscribeAttention, getWake, () => null);
  useEffect(() => {
    if (wakeAt === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, wakeAt - serverNow()) + 30);
    return () => clearTimeout(t);
  }, [wakeAt, tick]);
  return value;
}

/** The rail's boolean: the card would show a host problem row. */
export function useHostAttentionNeeded(): boolean {
  return useAttentionRead(readOn, false);
}

/**
 * The section the notification panel opens on: Needs Action while a human
 * decision waits, else All, which leads with what is broken right now (this
 * machine's Claude Code, a host that cannot connect), so opening the bell for
 * its host reason shows the reason without a second click.
 */
export function landingSectionFor(actionCount: number): 'action' | 'all' {
  return actionCount > 0 ? 'action' : 'all';
}

/** Test hook. */
export function __resetHostBannerPlacementForTests(): void {
  placement = 'slot';
  deferredRows = false;
  listeners.clear();
}
