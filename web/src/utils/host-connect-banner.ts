/**
 * The live host-connect banner's state machine, as pure functions: which remote
 * hosts get a row, when the banner appears, when it goes away. No React, no
 * timers; `now` is the caller's MONOTONIC clock (performance.now()), never the
 * server's `at`, because the browser and the server need not share a clock.
 *
 * The banner is news, not a health panel:
 *  . a connect gets a row only once it has lasted 1.5s (quick reconnects never
 *    flash), measured from the first frame this page saw minus the time the
 *    server says the attempt had already run;
 *  . a failure is shown only when this page saw that attempt start (a host that
 *    was already down when the page loaded stays in the picker and Settings);
 *  . once every shown host is connected, a short "Connected to ..." state holds
 *    for SUCCESS_HOLD_MS, then the banner hides;
 *  . dismiss hides the shown rows until a NEW attempt starts. The server's own
 *    timed retry of a dismissed failure is not a new attempt (it would pop the
 *    banner back every few minutes); it only reappears if that retry succeeds.
 */
import type { HostStatus } from '@/api/hosts';
import { isHostConnecting, isHostFailed } from '@/utils/host-connect';

export const SHOW_AFTER_MS = 1500;
export const SUCCESS_HOLD_MS = 3000;

type Kind = 'connecting' | 'failed' | 'connected' | 'idle';

export interface BannerHostRec {
  host: string;
  status: HostStatus;
  /** Monotonic time the latest frame arrived. */
  receivedAt: number;
  kind: Kind;
  /** Bumps on every new connect attempt seen by this page. */
  episode: number;
  /** When the current attempt becomes eligible to show. */
  showAt: number;
  /** This page saw the current attempt start (a connecting frame). */
  startedSeen: boolean;
  /** The row has been on screen during the current attempt. */
  shown: boolean;
  /** Hidden for this attempt: by the user, or a quiet timed retry. */
  dismissed: boolean;
  /** A server-timed retry of a failure nobody is looking at: silent unless it
   *  succeeds, and then only the good news shows. */
  quietRetry?: boolean;
  /** Turned connected while shown: its ✓ row is part of the success state. */
  connectedAt?: number;
}

export interface BannerState {
  /** First-seen order; never reshuffled. */
  order: string[];
  hosts: Record<string, BannerHostRec>;
}

export const EMPTY_BANNER: BannerState = { order: [], hosts: {} };

function kindOf(s: HostStatus): Kind {
  if (isHostConnecting(s)) return 'connecting';
  if (isHostFailed(s)) return 'failed';
  if (s.connected) return 'connected';
  return 'idle';
}

/** Fold the store's current statuses into the banner state. */
export function ingestHostStatuses(state: BannerState, statuses: readonly HostStatus[], now: number): BannerState {
  let changed = false;
  const hosts = { ...state.hosts };
  const order = [...state.order];
  for (const s of statuses) {
    if (!s || !s.host || s.discovered) continue;
    const prev = hosts[s.host];
    if (prev && prev.status === s) continue;
    changed = true;
    const kind = kindOf(s);
    if (!prev) order.push(s.host);
    const base: BannerHostRec = prev ?? {
      host: s.host, status: s, receivedAt: now, kind: 'idle', episode: 0,
      showAt: Infinity, startedSeen: false, shown: false, dismissed: false,
    };
    const next: BannerHostRec = { ...base, status: s, receivedAt: now, kind };
    if (kind === 'connecting' && base.kind !== 'connecting') {
      // A new attempt. The server's timed retry of a failure that is not on
      // screen (dismissed, or already down when the page loaded) stays quiet;
      // anything else (Retry, Connect now, a fresh warmup) is news.
      const timedRetry = base.kind === 'failed' && (base.status.retryInMs ?? 0) > 0;
      const quiet = timedRetry && (base.dismissed || !base.shown);
      next.episode = base.episode + 1;
      next.startedSeen = true;
      next.dismissed = quiet;
      next.quietRetry = quiet;
      next.connectedAt = undefined;
      next.showAt = now + Math.max(0, SHOW_AFTER_MS - (s.connectElapsedMs ?? 0));
      // A row already on screen switches state in place: no threshold, no gap.
      next.shown = base.shown && !next.dismissed;
      if (next.shown) next.showAt = now;
    }
    if (kind === 'connected' && base.kind !== 'connected') {
      next.connectedAt = base.shown && !base.dismissed ? now : undefined;
      if (base.quietRetry) {
        // A host that was down came back by itself: the good news shows, briefly.
        next.connectedAt = now;
        next.dismissed = false;
      }
      next.quietRetry = false;
    }
    hosts[s.host] = next;
  }
  return changed ? { order, hosts } : state;
}

/** Visible as a connecting or failed row (the ✓ rows are decided after). */
function liveVisible(r: BannerHostRec, now: number, anyOtherShown: boolean): boolean {
  if (r.dismissed) return false;
  if (r.kind === 'connecting') {
    if (r.shown || now >= r.showAt) return true;
    // "Waiting for another host" only means something when another host shows.
    return r.status.phase === 'queued' && anyOtherShown;
  }
  return r.kind === 'failed' && r.startedSeen;
}

/** Latch `shown` for rows that became visible and drop finished ✓ rows. */
export function settleBanner(state: BannerState, now: number): BannerState {
  const view = bannerView(state, now);
  let changed = false;
  const hosts = { ...state.hosts };
  const visible = new Set(view.rows.map((r) => r.host));
  for (const id of state.order) {
    const r = hosts[id];
    const on = visible.has(id);
    if (on && !r.shown) { hosts[id] = { ...r, shown: true }; changed = true; }
    else if (!on && r.shown && r.kind !== 'connecting') {
      hosts[id] = { ...r, shown: false, connectedAt: view.mode === 'hidden' ? undefined : r.connectedAt };
      changed = true;
    }
  }
  return changed ? { order: state.order, hosts } : state;
}

/** Hide everything on screen until a new attempt starts. */
export function dismissBanner(state: BannerState, now: number): BannerState {
  const view = bannerView(state, now);
  if (view.mode === 'hidden') return state;
  const hosts = { ...state.hosts };
  for (const row of view.rows) {
    const r = hosts[row.host];
    hosts[row.host] = { ...r, dismissed: r.kind !== 'connected', shown: false, connectedAt: undefined };
  }
  return { order: state.order, hosts };
}

export type BannerMode = 'hidden' | 'connecting' | 'failed' | 'success';

export interface BannerRow {
  host: string;
  status: HostStatus;
  state: 'connecting' | 'queued' | 'reconnecting' | 'failed' | 'connected';
  /** Time on this attempt, from the server's own count plus local time since. */
  elapsedMs: number;
  /** Failed with a server-scheduled retry: ms left (0 = retrying now). */
  retryInMs?: number;
}

export interface BannerView {
  mode: BannerMode;
  rows: BannerRow[];
  /** Next moment the view changes on its own (ms from now), or null when idle. */
  wakeInMs: number | null;
}

export function bannerView(state: BannerState, now: number): BannerView {
  const recs = state.order.map((id) => state.hosts[id]);
  const unqueuedShown = recs.some((r) => r.status.phase !== 'queued' && liveVisible(r, now, false));
  const live = new Set(recs.filter((r) => liveVisible(r, now, unqueuedShown)).map((r) => r.host));
  const lastConnect = Math.max(-Infinity, ...recs.map((r) => (r.dismissed ? -Infinity : r.connectedAt ?? -Infinity)));
  // ✓ rows stay while anything else is still on screen, then hold briefly.
  const holdOn = live.size > 0 || now - lastConnect < SUCCESS_HOLD_MS;
  const rows: BannerRow[] = [];
  let wake: number | null = null;
  const soon = (ms: number) => { if (ms > 0 && (wake === null || ms < wake)) wake = ms; };
  for (const r of recs) {
    const done = r.kind === 'connected' && r.connectedAt !== undefined && !r.dismissed && holdOn;
    if (!live.has(r.host) && !done) {
      if (r.kind === 'connecting' && !r.dismissed && Number.isFinite(r.showAt)) soon(r.showAt - now);
      continue;
    }
    const since = Math.max(0, now - r.receivedAt);
    const phase = r.status.phase;
    const state: BannerRow['state'] = r.kind === 'failed' ? 'failed'
      : r.kind === 'connected' ? 'connected'
      : phase === 'queued' ? 'queued' : phase === 'reconnecting' ? 'reconnecting' : 'connecting';
    const row: BannerRow = { host: r.host, status: r.status, state, elapsedMs: (r.status.connectElapsedMs ?? 0) + since };
    if (state === 'failed' && (r.status.retryInMs ?? 0) > 0) {
      row.retryInMs = Math.max(0, (r.status.retryInMs ?? 0) - since);
      if (row.retryInMs > 0) soon(1000);
    }
    if (state === 'connecting' || state === 'queued' || state === 'reconnecting') soon(1000);
    rows.push(row);
  }
  if (!rows.length) return { mode: 'hidden', rows, wakeInMs: wake };
  if (live.size === 0) {
    soon(SUCCESS_HOLD_MS - (now - lastConnect));
    return { mode: 'success', rows, wakeInMs: wake };
  }
  const connecting = rows.some((r) => r.state === 'connecting' || r.state === 'queued' || r.state === 'reconnecting');
  return { mode: connecting ? 'connecting' : 'failed', rows, wakeInMs: wake };
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The banner's title line. `label` maps a host alias to its display name. */
export function bannerTitle(view: BannerView, label: (host: string) => string): string {
  const of = (pred: (r: BannerRow) => boolean) => view.rows.filter(pred);
  if (view.mode === 'success') return `Connected to ${joinNames(view.rows.map((r) => label(r.host)))}`;
  const active = of((r) => r.state === 'connecting' || r.state === 'reconnecting');
  const queued = of((r) => r.state === 'queued');
  const failed = of((r) => r.state === 'failed');
  if (active.length === 1) return `Connecting to ${label(active[0].host)}`;
  if (active.length > 1) return `Connecting to ${active.length} remote hosts`;
  if (queued.length) return queued.length === 1 ? `Waiting to connect ${label(queued[0].host)}` : `Waiting to connect ${queued.length} remote hosts`;
  if (failed.length === 1) return `Couldn't connect to ${label(failed[0].host)}`;
  return `Couldn't connect to ${failed.length} remote hosts`;
}
