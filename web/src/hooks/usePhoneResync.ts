/**
 * Back-in-front resync on the phone (spec 4.5 R) and the connection lines under
 * the top bar (C63, C88).
 *
 * `visibilitychange` to visible, `online` and `pageshow` each run
 * `wsClient.resync()`: backoff reset, a ping when the socket is not OPEN or
 * went silent, an immediate reconnect when the ping goes unanswered, and then
 * `_ws:reconnected`, which every store already answers with a refetch. The
 * page is never reloaded and nothing is unmounted, so scroll positions stay.
 *
 * Connection state, read from the socket:
 * - `offline`: the socket has not been connected for 5 s.
 * - `macAway`: while offline, GET /api/v1/me answered 503 with
 *   `{ error: { code: 'leader_away' } }`. That is the host server's own answer
 *   when neither the Mac nor the companion takes a request
 *   (src/host-server/pages.ts `aloneJson`), so it replaces the offline line.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { wsClient, type ConnectionState, type ResyncReason } from '@/api/ws';
import { log } from '@/utils/log';

export interface ResyncState {
  /** A resync is running: the 2px line under the top bar. */
  syncing: boolean;
  /** Not connected for 5 s or more. */
  offline: boolean;
  /** Offline, and the server that answers is a host server alone. */
  macAway: boolean;
}

export const OFFLINE_AFTER_MS = 5_000;
const MAC_PROBE_EVERY_MS = 10_000;
const MAC_PROBE_DEADLINE_MS = 3_000;
/** The sync line stays up at least this long so it reads as "updating". */
const SYNC_LINE_MIN_MS = 600;
export const LEADER_AWAY_CODE = 'leader_away';

let state: ResyncState = { syncing: false, offline: false, macAway: false };
const listeners = new Set<() => void>();
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
let macTimer: ReturnType<typeof setInterval> | null = null;
let installedCount = 0;

function set(patch: Partial<ResyncState>): void {
  const next = { ...state, ...patch };
  if (next.syncing === state.syncing && next.offline === state.offline && next.macAway === state.macAway) return;
  state = next;
  for (const l of [...listeners]) l();
}

/** Is this answer the host server's "the Mac is away" reply? (pure, unit tested) */
export function isLeaderAwayAnswer(status: number, body: unknown): boolean {
  if (status !== 503 || !body || typeof body !== 'object') return false;
  const err = (body as { error?: { code?: unknown } }).error;
  return err?.code === LEADER_AWAY_CODE;
}

async function probeMac(): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MAC_PROBE_DEADLINE_MS);
  try {
    const res = await fetch('/api/v1/me', { cache: 'no-store', signal: ctrl.signal, headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (wsClient.state === 'connected') return;
    const away = isLeaderAwayAnswer(res.status, body);
    if (away !== state.macAway) log.info('phone-resync', away ? 'host server answers alone' : 'leader answers again', { status: res.status });
    set({ macAway: away, offline: !away });
  } catch {
    // No answer at all: plain offline.
    if (wsClient.state !== 'connected') set({ macAway: false, offline: true });
  } finally {
    clearTimeout(timer);
  }
}

function onConnection(s: ConnectionState): void {
  if (s === 'connected') {
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    if (macTimer) { clearInterval(macTimer); macTimer = null; }
    set({ offline: false, macAway: false });
    return;
  }
  if (offlineTimer || state.offline || state.macAway) return;
  offlineTimer = setTimeout(() => {
    offlineTimer = null;
    if (wsClient.state === 'connected') return;
    set({ offline: true });
    void probeMac();
    if (!macTimer) macTimer = setInterval(() => { void probeMac(); }, MAC_PROBE_EVERY_MS);
  }, OFFLINE_AFTER_MS);
}

/** Run one resync with the sync line up (Retry, pull to refresh, the events below). */
export function runPhoneResync(reason: ResyncReason): Promise<void> {
  const started = Date.now();
  set({ syncing: true });
  if (reason === 'retry' || reason === 'pull') void probeMacIfOffline();
  return wsClient.resync(reason).finally(() => {
    const left = SYNC_LINE_MIN_MS - (Date.now() - started);
    setTimeout(() => set({ syncing: false }), Math.max(0, left));
  });
}

function probeMacIfOffline(): Promise<void> {
  return state.offline || state.macAway ? probeMac() : Promise.resolve();
}

function install(): () => void {
  installedCount += 1;
  if (installedCount > 1) return () => { installedCount -= 1; };
  let wasHidden = document.visibilityState === 'hidden';
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') { wasHidden = true; return; }
    if (!wasHidden) return;
    wasHidden = false;
    void runPhoneResync('visible');
  };
  const onOnline = () => { void runPhoneResync('online'); };
  const onPageShow = () => { void runPhoneResync('pageshow'); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('pageshow', onPageShow);
  wsClient.onConnectionChange(onConnection);
  onConnection(wsClient.state);
  return () => {
    installedCount -= 1;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pageshow', onPageShow);
    wsClient.offConnectionChange(onConnection);
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    if (macTimer) { clearInterval(macTimer); macTimer = null; }
  };
}

/** AppShell mounts this on the phone layout. */
export function usePhoneResync(enabled: boolean): void {
  useEffect(() => (enabled ? install() : undefined), [enabled]);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot(): ResyncState { return state; }

/** The sync line and the connection rows read this. */
export function useResyncState(): ResyncState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
