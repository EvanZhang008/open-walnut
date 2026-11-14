/**
 * Which hosts the "connecting in the background" card shows (HostConnectCard.tsx), and its
 * words. The rules are pure (the host statuses and a small memory in, the rows and the next
 * memory out); the tab's one copy of that memory is the store at the end.
 *
 * 2026-11-13, the user, of a first connect that takes minutes: "make it clear, close & run
 * background that make it clear that it will still running ... make it maybe collapse into an
 * always on notification like this" (the approval card).
 *
 * A host is shown while its FIRST connect runs: the server says so (`firstConnect`: no daemon was
 * on the host and its link was never up), or the person just added it here (`asked`, which covers
 * the seconds before the server's probe, and a host queued behind another). An established host's
 * reconnect never shows. Once followed, a host stays until its connect ends: connected, it reads
 * "<name> is connected" for CONNECTED_HOLD_MS, then goes; failed, it goes at once (the
 * Notifications panel says why). It comes back for a person's retry (markHostConnectAsked: first
 * run's Try again, Home's Connect) or a fresh attempt with no failure before it; never for a dial
 * of the server's retry loop (a status carrying `lastError` or `reconnectSince`), so a machine
 * that is switched off does not pop the card up every few minutes.
 * Everything shown is read from the live host status, so a reload shows a running first connect
 * again (the server still flags it).
 */
import { useSyncExternalStore } from 'react';
import type { HostStatus } from '@/api/hosts';
import { getHostStatus } from '@/hooks/useHostStatus';
import { connectProgress, hostStatusText, isHostConnecting, isHostFailed } from '@/utils/host-connect';
import { hostDisplayLabel } from '@/utils/host-display-label';

/** How long a host that just connected keeps its "is connected" line. */
export const CONNECTED_HOLD_MS = 4_000;
/** An Add whose host never starts connecting is forgotten after this. */
export const ASKED_TTL_MS = 120_000;

export interface BackgroundConnectMemory {
  /**
   * Hosts the person added here, not yet seen connecting: when (this browser's clock), and the
   * `at` of the host's status at that moment, so that frame (a failure a Try again answers) is
   * not read as the new attempt's end.
   */
  readonly asked: Readonly<Record<string, { at: number; frame?: number }>>;
  /**
   * Hosts the card follows: when each was seen connected (absent while connecting), and whether
   * a person asked for this attempt (then the retry loop's marks on its frames do not end it).
   */
  readonly following: Readonly<Record<string, { connectedAt?: number; asked?: true }>>;
  /** Hosts whose followed connect failed, by that attempt (attemptKey): only a new attempt shows again. */
  readonly dropped: Readonly<Record<string, number>>;
}

export const EMPTY_MEMORY: BackgroundConnectMemory = { asked: {}, following: {}, dropped: {} };

export interface BackgroundConnectRow {
  /** The config alias (a key, never shown). */
  host: string;
  /** The name the person knows the host by. */
  label: string;
  state: 'connecting' | 'connected';
  /** The step in flight, in words. */
  stepWords: string;
  /** 0..100, or undefined while nothing is measured. */
  percent: number | undefined;
  valueText: string;
}

/** The person added this host (or asked it to try again) here: follow its connect. */
export function withAsked(memory: BackgroundConnectMemory, host: string, now: number, frame?: number): BackgroundConnectMemory {
  return {
    asked: { ...memory.asked, [host]: frame === undefined ? { at: now } : { at: now, frame } },
    following: memory.following,
    dropped: memory.dropped,
  };
}

/**
 * Which connect attempt a status belongs to: when the server began it (`attemptStartedAt`, new
 * for every try, the reconnect loop's included), else the frame's own time.
 */
export function attemptKey(status: HostStatus): number {
  return status.attemptStartedAt ?? status.at;
}

/**
 * The attempt ended in a failure: failed, or the reconnect loop waiting out its pause after one
 * (`reconnecting` with its `lastError`). The Notifications panel says why, so the card lets the
 * host go.
 */
export function failedNow(status: HostStatus): boolean {
  return isHostFailed(status) || (!status.connected && status.phase === 'reconnecting' && !!status.lastError);
}

/**
 * A dial of the server's retry loop: its frames carry the loop's last failure or when the loop
 * began (host-status.ts). Never a reason for the card to show a host by itself.
 */
export function isLoopDial(status: HostStatus): boolean {
  return !status.connected && (!!status.lastError || typeof status.reconnectSince === 'number');
}

/**
 * Is this host's connect one the card shows? Asked by the person here: any attempt in flight.
 * Otherwise only a first connect the server flags that is not a dial of its retry loop.
 */
export function isFirstConnect(status: HostStatus | undefined, asked: boolean): boolean {
  if (!status || !isHostConnecting(status) || failedNow(status)) return false;
  return asked || (status.firstConnect === true && !isLoopDial(status));
}

function rowOf(status: HostStatus, state: BackgroundConnectRow['state']): BackgroundConnectRow {
  const progress = connectProgress(status);
  return {
    host: status.host,
    label: hostDisplayLabel(status.host, status.label),
    state,
    stepWords: hostStatusText(status),
    percent: progress.percent,
    valueText: progress.valueText,
  };
}

/**
 * One look at the statuses: the rows to show now, the memory for the next look (the SAME object
 * when nothing changed, so a caller can commit it without looping), and when to look again for a
 * connected line's hold to run out.
 */
export function stepBackgroundConnects(
  prev: BackgroundConnectMemory,
  statuses: readonly HostStatus[],
  now: number,
): { memory: BackgroundConnectMemory; rows: BackgroundConnectRow[]; wakeAt?: number } {
  const byHost = new Map(statuses.map((s) => [s.host, s]));
  let changed = false;
  const asked: Record<string, { at: number; frame?: number }> = {};
  const following: Record<string, { connectedAt?: number; asked?: true }> = {};
  const dropped: Record<string, number> = {};
  const rows: BackgroundConnectRow[] = [];
  let wakeAt: number | undefined;
  const wake = (at: number) => { wakeAt = wakeAt === undefined ? at : Math.min(wakeAt, at); };

  // A dropped host stays dropped through its failed attempt and every dial of the retry loop
  // after it; a fresh attempt with no failure before it, a connect, or the host gone ends it.
  for (const [host, key] of Object.entries(prev.dropped)) {
    const s = byHost.get(host);
    if (s && !s.connected && (failedNow(s) || isLoopDial(s) || attemptKey(s) === key)) dropped[host] = key;
    else changed = true;
  }

  for (const [host, f] of Object.entries(prev.following)) {
    const s = byHost.get(host);
    if (!s) { changed = true; continue; }
    if (s.connected) {
      const at = f.connectedAt ?? now;
      if (f.connectedAt === undefined) changed = true;
      if (now - at < CONNECTED_HOLD_MS) {
        following[host] = { ...f, connectedAt: at };
        rows.push(rowOf(s, 'connected'));
        wake(at + CONNECTED_HOLD_MS);
      } else changed = true;
      continue;
    }
    // Connected, then connecting again within the hold: that is a reconnect, not this card's.
    if (f.connectedAt !== undefined || s.phase === 'off') { changed = true; continue; }
    // Failed, or (an attempt nobody here asked for) the retry loop took it over: it failed once.
    if (failedNow(s) || (!f.asked && isLoopDial(s))) {
      changed = true;
      dropped[host] = attemptKey(s);
      continue;
    }
    following[host] = f;
    // Between tries (a retry put it back to idle): followed, nothing to draw yet.
    if (isHostConnecting(s)) rows.push(rowOf(s, 'connecting'));
  }

  for (const [host, ask] of Object.entries(prev.asked)) {
    // The frame the ask was made over says nothing about the attempt it started.
    const s = byHost.get(host);
    const fresh = s && (ask.frame === undefined || s.at > ask.frame) ? s : undefined;
    if (host in following) { changed = true; continue; }
    // The person's own retry: shown again whatever happened to the attempt before it.
    if (fresh && isFirstConnect(fresh, true)) {
      following[host] = { asked: true };
      delete dropped[host];
      rows.push(rowOf(fresh, 'connecting'));
      changed = true;
      continue;
    }
    // Connected at once, failed, or never started: nothing for the card.
    if ((fresh && (fresh.connected || failedNow(fresh) || fresh.phase === 'off')) || now - ask.at >= ASKED_TTL_MS) { changed = true; continue; }
    asked[host] = ask;
  }

  for (const s of statuses) {
    if (s.host in following || s.host in dropped || !isFirstConnect(s, false)) continue;
    following[s.host] = {};
    rows.push(rowOf(s, 'connecting'));
    changed = true;
  }

  // Rows in the order the hosts were first followed: a host that connects never jumps the list.
  const order = [...Object.keys(prev.following), ...Object.keys(prev.asked), ...statuses.map((s) => s.host)];
  rows.sort((a, b) => order.indexOf(a.host) - order.indexOf(b.host));
  const memory = changed ? { asked, following, dropped } : prev;
  return { memory, rows, ...(wakeAt !== undefined ? { wakeAt } : {}) };
}

/** The minimized card's one line: "Connecting to build-box · 34%". */
export function pillParts(rows: readonly BackgroundConnectRow[]): { words: string; percent?: number } {
  const connecting = rows.filter((r) => r.state === 'connecting');
  if (connecting.length === 0) {
    return { words: rows.length === 1 ? `${rows[0]!.label} is connected` : `${rows.length} machines connected` };
  }
  const words = connecting.length === 1 ? `Connecting to ${connecting[0]!.label}` : `Connecting to ${connecting.length} machines`;
  const measured = connecting.map((r) => r.percent).filter((p): p is number => typeof p === 'number');
  if (measured.length === 0) return { words };
  return { words, percent: Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) };
}

export function pillText(rows: readonly BackgroundConnectRow[]): string {
  const { words, percent } = pillParts(rows);
  return percent === undefined ? words : `${words} · ${percent}%`;
}

// The tab's memory: module scope, so an Add in the first-run dialog reaches the card (App mounts
// it once), and the card's own unmounts (a popout window has none) lose nothing.
let memory: BackgroundConnectMemory = EMPTY_MEMORY;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const read = () => memory;

/** The person added `host` here (Add, Add all, Try again): the card follows its first connect. Call it before the request. */
export function markHostConnectAsked(host: string): void {
  memory = withAsked(memory, host, Date.now(), getHostStatus(host)?.at);
  for (const l of listeners) l();
}

/** The card's memory, live. */
export function useBackgroundConnectMemory(): BackgroundConnectMemory {
  return useSyncExternalStore(subscribe, read, read);
}

/** Keeps what stepBackgroundConnects answered; a no-op for the same object. */
export function commitBackgroundConnectMemory(next: BackgroundConnectMemory): void {
  if (next === memory) return;
  memory = next;
  for (const l of listeners) l();
}

/** Test hook. */
export function __resetBackgroundConnectForTests(): void {
  memory = EMPTY_MEMORY;
  listeners.clear();
}
