/**
 * Who speaks for a host or Claude Code problem: never a card on the page. The
 * problem is a notification: a row at the top of the notification panel's All
 * and Errors views (NotificationProblems), a toast at the top when it arrives
 * (HostProblemToasts), a dot on the bell, and a warn dot on the rail's Settings
 * entry (2026-11-16, the user: "this shoudl not show on top of quick chat
 * pannel", "please unified, shodl as notificaiton in the notificaiton bar").
 * tests/web/app-alert-placement-guard.test.ts fails on an alert mounted in a
 * chat, session or task column.
 *
 * The dots read the problem and the route only, never whether the panel is
 * open: the panel is a passing overlay and opening it must not make the rail blink.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getAllHostStatus, serverNow, subscribeHostStatus } from '@/hooks/useHostStatus';
import { nextBanner, type BannerInput } from '@/utils/attention-banner-model';
import { getHostDismissed, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { getPromptedHosts, getUserEngagedHosts, subscribeUserRetry } from '@/utils/host-user-retrying';

/** Settings > Remote hosts (or one host's row there): the user is looking at those rows. */
export function onRemoteHostsPane(pathname: string, hash: string): boolean {
  return pathname === '/settings' && (hash === '#remote-hosts' || hash.startsWith('#rh-host-'));
}

/** The rail dot shows while a host needs attention, except on the remote hosts pane itself. */
export function railDotShows(attention: boolean, pathname: string, hash = ''): boolean {
  return attention && !onRemoteHostsPane(pathname, hash);
}

// ── The bell: a dot for a host or Claude Code problem ──

export type BellReason = 'hosts' | 'local' | 'both' | null;

/** hosts / local: the problem exists and the user is not on the page that lists it (useAttentionDots). */
export function bellDotReason(hosts: boolean, local: boolean): BellReason {
  if (hosts && local) return 'both';
  return hosts ? 'hosts' : local ? 'local' : null;
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
  // Quiet (Do Not Disturb): no count, no dot and no count in the name until it ends;
  // the panel still lists everything once opened (quiet-model.ts).
  if (i.quiet) return { ariaLabel: `Notifications. ${i.quietLabel}`, title: i.quietLabel, dot: false, cornerDot: false, dotKind: null };
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

// ── Host attention off the problem-row model ──

type AttentionInput = Pick<BannerInput, 'statuses' | 'dismissed' | 'now' | 'engaged' | 'prompted'>;

/**
 * Would any host get a problem row right now? The SAME model the notification
 * panel's rows follow (from an empty state), so a dismissed
 * row, a discovered host nobody reached for, and a reconnect younger than
 * 2 minutes light nothing. `wakeAt` is the next time the answer can flip
 * without a new frame (the 2-minute reconnect line).
 */
export function hostAttentionOf(input: AttentionInput): { on: boolean; wakeAt: number | null } {
  const { view } = nextBanner(input);
  return { on: view.rows.some((r) => r.type !== 'ready') || view.more > 0, wakeAt: view.wakeAt };
}

function inputNow(): AttentionInput {
  return { statuses: getAllHostStatus(), dismissed: getHostDismissed(), now: serverNow(), engaged: getUserEngagedHosts(), prompted: getPromptedHosts() };
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

/** The rail's and the bell's boolean: some host has a problem row. */
export function useHostAttentionNeeded(): boolean {
  return useAttentionRead(readOn, false);
}

/**
 * The section the notification panel opens on: Needs Action while a session
 * asks something live, else All, which leads with what is broken right now (this
 * machine's Claude Code, a host that cannot connect), so opening the bell for
 * its host reason shows the reason without a second click.
 */
export function landingSectionFor(actionCount: number): 'action' | 'all' {
  return actionCount > 0 ? 'action' : 'all';
}
