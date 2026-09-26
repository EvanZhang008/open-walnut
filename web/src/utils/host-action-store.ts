/**
 * One attempt per host, shared by every surface (banner mounts, picker,
 * Settings, gate bar), keyed by alias: a card that remounts elsewhere keeps its
 * 'Connecting to X...', and a second click in flight sends no second request.
 * Listens to host status only while an attempt or a fix hold is open.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { checkHostReadiness, connectHost, type HostStatus } from '@/api/hosts';
import { getHostStatus, seedHostStatus, serverNow, subscribeHostStatus } from '@/hooks/useHostStatus';
import { isConnectingPhaseWire, sameResultReceipt } from '@open-walnut/host-problem';
import { markUserRetry } from '@/utils/host-user-retrying';
import { log } from '@/utils/log';

export const RETRY_FAILED_TEXT = 'Could not retry right now.';
export const CHECK_FAILED_TEXT = 'Check failed';
export const RECEIPT_MS = 5_000;
const CHECK_CAP_MS = 20_000, CONNECT_CAP_MS = 6 * 60_000, FIX_NO_START_MS = 30_000;

export type HostActionPending = 'retry' | 'check' | 'fix' | null;
export type HostActionFailed = 'retry' | 'check' | null;
export type HostActionKind = 'retry' | 'fix' | 'check';
export interface HostFixStart { verb: 'update' | 'install'; at: number }
export interface HostActionSnapshot { pending: HostActionPending; failed: HostActionFailed; receipt: string | null; fixStart: HostFixStart | null; lastTriedAt: number | null }
export interface HostActionEvent { alias: string; kind: 'receipt' | 'failed'; text: string }
/**
 * `posted`: the request came back. A connect attempt settles only after it: the
 * route answers with the attempt's own result, while a frame pushed before that
 * answer (the pre-click frame, or one re-stamped with the OLD kind a moment
 * before the result) says nothing about this attempt (C23, C48).
 */
interface Attempt { mode: 'connect' | 'readiness'; before: HostStatus | undefined; startedAt: number; checkedAt: number; posted: boolean }
type Timer = ReturnType<typeof setTimeout>;
interface Entry { snap: HostActionSnapshot; attempt: Attempt | null; sawServerFix: boolean; release: (() => void) | null; timers: { cap?: Timer; receipt?: Timer; fix?: Timer } }

const EMPTY: HostActionSnapshot = { pending: null, failed: null, receipt: null, fixStart: null, lastTriedAt: null };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: HostActionEvent) => void>();
let unsubStatus: (() => void) | null = null;
const checkedAtOf = (s: HostStatus | undefined): number => s?.readiness?.checkedAt ?? 0;
export const fixVerbOf = (action: string): 'update' | 'install' => (action === 'update-claude' ? 'update' : 'install');

function entryOf(alias: string): Entry {
  if (!entries.has(alias)) entries.set(alias, { snap: EMPTY, attempt: null, sawServerFix: false, release: null, timers: {} });
  return entries.get(alias)!;
}

const emit = (ev: HostActionEvent): void => { for (const l of eventListeners) l(ev); };
/** Replace the snapshot (new identity only on a real change), then re-check the status listener. */
function patch(e: Entry, next: Partial<HostActionSnapshot>): void {
  const merged = { ...e.snap, ...next };
  const changed = (Object.keys(merged) as (keyof HostActionSnapshot)[]).some((k) => merged[k] !== e.snap[k]);
  if (changed) e.snap = merged;
  if (merged.pending !== 'retry' && e.release) { e.release(); e.release = null; }
  syncStatusListener();
  if (changed) for (const l of listeners) l();
}

function syncStatusListener(): void {
  const open = [...entries.values()].some((e) => e.attempt !== null || e.snap.fixStart !== null);
  if (open && !unsubStatus) unsubStatus = subscribeHostStatus(settleAll);
  else if (!open && unsubStatus) { unsubStatus(); unsubStatus = null; }
}

const settleAll = (): void => { for (const alias of [...entries.keys()]) settleHostAction(alias); };

function endAttempt(e: Entry, alias: string, failed: HostActionFailed): void {
  e.attempt = null; clearTimeout(e.timers.cap);
  patch(e, { pending: null, failed });
  if (failed) emit({ alias, kind: 'failed', text: failed === 'check' ? CHECK_FAILED_TEXT : RETRY_FAILED_TEXT });
}

/** Follow the server's fix, and hold it past the end until a NEWER readiness answer (the 14s flicker). */
function holdFix(e: Entry, s: HostStatus | undefined): void {
  const sf = s?.readiness?.fixing;
  const fs = e.snap.fixStart;
  clearTimeout(e.timers.fix);
  if (sf) {
    e.sawServerFix = true;
    // Hold from the FIX's start, not the click: the click's own re-check lands before the fix begins.
    const at = sf.startedAt;
    if (!fs) patch(e, { fixStart: { verb: fixVerbOf(sf.action), at: at ?? serverNow() } });
    else if (typeof at === 'number' && at > fs.at) patch(e, { fixStart: { verb: fixVerbOf(sf.action), at } });
    return;
  }
  if (!fs) return;
  const fixFailed = !!s?.readiness?.problems?.some((p) => p.fix?.state === 'failed');
  if (fixFailed || (e.sawServerFix && checkedAtOf(s) > fs.at)) { e.sawServerFix = false; patch(e, { fixStart: null }); return; }
  // Update was clicked but the server never started a fix: do not spin forever.
  if (!e.sawServerFix) e.timers.fix = setTimeout(() => patch(e, { fixStart: null }), FIX_NO_START_MS);
}

/** Settle an open attempt on a frame after the request, and move the fix hold. Idempotent. */
export const settleHostAction = (alias: string): void => observeHostStatus(alias, getHostStatus(alias));
/** The same, on a status the caller already holds (useHostActions passes its own frame). */
export function observeHostStatus(alias: string, s: HostStatus | undefined): void {
  const e = entries.get(alias) ?? (s?.readiness?.fixing ? entryOf(alias) : undefined);
  if (!e) return;
  const a = e.attempt;
  if (a && s) {
    let done = false;
    if (a.mode === 'connect') done = a.posted && !isConnectingPhaseWire(s.phase) && s.phase !== 'idle' && (s.at ?? 0) >= a.startedAt - 1000;
    else if (s.readiness?.checkError && checkedAtOf(s) > a.checkedAt) endAttempt(e, alias, 'check');
    else done = checkedAtOf(s) > a.checkedAt || !s.connected;
    if (done) {
      e.attempt = null; clearTimeout(e.timers.cap); clearTimeout(e.timers.receipt);
      const receipt = sameResultReceipt(a.before, s, a.mode);
      patch(e, { pending: null, receipt });
      if (receipt) {
        e.timers.receipt = setTimeout(() => patch(e, { receipt: null }), RECEIPT_MS);
        emit({ alias, kind: 'receipt', text: receipt });
      }
    }
  }
  holdFix(e, s);
}

/** Retry / Connect now ('retry'), Update or Install ('fix'), Check again ('check'). A run while one is pending is a no-op. */
export async function runHostAction(alias: string, kind: HostActionKind, verb: 'update' | 'install' = 'update'): Promise<void> {
  const e = entryOf(alias);
  if (e.snap.pending !== null || e.attempt) return;
  const before = getHostStatus(alias), at = serverNow();
  const attempt: Attempt = { mode: kind === 'check' ? 'readiness' : 'connect', before, startedAt: at, checkedAt: checkedAtOf(before), posted: false };
  e.attempt = attempt;
  // A user Retry reads as theirs on every surface (and lets a discovered host take a banner row).
  if (kind === 'retry' && !e.release) e.release = markUserRetry([alias]);
  clearTimeout(e.timers.receipt);
  patch(e, { pending: kind, failed: null, receipt: null, lastTriedAt: at, ...(kind === 'fix' ? { fixStart: { verb, at } } : {}) });
  if (kind === 'fix') holdFix(e, before);
  // A request that never gets an answer frame still ends (the check has its own server deadline).
  else e.timers.cap = setTimeout(() => { if (e.attempt === attempt) endAttempt(e, alias, null); }, kind === 'check' ? CHECK_CAP_MS : CONNECT_CAP_MS);
  try {
    const answer = await (kind === 'check' ? checkHostReadiness(alias) : connectHost(alias));
    attempt.posted = true;
    seedHostStatus(answer);
    settleHostAction(alias);
  } catch (err) {
    log.warn('host-actions', kind === 'check' ? 'readiness check request failed' : 'connect request failed', { host: alias, error: String(err) });
    if (e.attempt === attempt) endAttempt(e, alias, kind === 'check' ? 'check' : 'retry');
  }
}

export function subscribeHostActions(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function subscribeHostActionEvents(cb: (e: HostActionEvent) => void): () => void { eventListeners.add(cb); return () => { eventListeners.delete(cb); }; }
export const getHostActionSnapshot = (alias: string): HostActionSnapshot => entries.get(alias)?.snap ?? EMPTY;

export function useHostActionSnapshot(alias: string): HostActionSnapshot {
  const get = useCallback(() => getHostActionSnapshot(alias), [alias]);
  return useSyncExternalStore(subscribeHostActions, get, get);
}

/** Test hook. */
export function __resetHostActionStoreForTests(): void {
  for (const e of entries.values()) { clearTimeout(e.timers.cap); clearTimeout(e.timers.receipt); clearTimeout(e.timers.fix); e.release?.(); }
  entries.clear(); listeners.clear(); eventListeners.clear();
  unsubStatus?.(); unsubStatus = null;
}
