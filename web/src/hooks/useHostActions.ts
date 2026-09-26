/**
 * The host buttons' one implementation (banner, picker, Settings, error bar):
 * Retry / Connect now / Update go through connectHost (the server's enabled
 * check, autofix reset and readiness refresh), Check again through
 * checkHostReadiness. Every surface gets the same pending text, the same
 * failure text and the same "same result" receipt.
 *
 * `fixing` is held until a readiness answer NEWER than the fix's start lands:
 * the server drops `readiness.fixing` a moment before the re-check returns,
 * and showing the old warning in that gap is the 14s flicker this removes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { checkHostReadiness, connectHost, type HostStatus } from '@/api/hosts';
import { seedHostStatus, serverNow, useHostStatus } from '@/hooks/useHostStatus';
import { isConnectingPhaseWire, sameResultReceipt } from '@open-walnut/host-problem';
import { markUserRetry } from '@/utils/host-user-retrying';
import { log } from '@/utils/log';

export const RETRY_FAILED_TEXT = 'Could not retry right now.';
export const CHECK_FAILED_TEXT = 'Check failed';
export const RECEIPT_MS = 5_000;

export type HostActionPending = 'retry' | 'check' | 'fix' | null;
export type HostActionFailed = 'retry' | 'check' | null;
export interface HostFixingView { verb: 'update' | 'install'; startedAt: number }

export interface HostActions {
  retry: () => Promise<void>;
  connectNow: () => Promise<void>;
  /** The autofix: 'update' (a native build updates itself) or 'install' (npm, missing). */
  update: (verb?: 'update' | 'install') => Promise<void>;
  checkAgain: () => Promise<void>;
  pending: HostActionPending;
  failed: HostActionFailed;
  /** 'Tried again just now: same result' / 'Checked just now: still 2.1.220', for 5s. */
  receipt: string | null;
  fixing: HostFixingView | null;
  /** Server time of the last user-started attempt. */
  lastTriedAt: number | null;
}

const checkedAtOf = (s: HostStatus | undefined): number => s?.readiness?.checkedAt ?? 0;
const verbOf = (action: string): 'update' | 'install' => (action === 'update-claude' ? 'update' : 'install');

interface Attempt { mode: 'connect' | 'readiness'; before: HostStatus | undefined; startedAt: number; checkedAt: number }

export function useHostActions(alias: string): HostActions {
  const status = useHostStatus(alias);
  const [pending, setPending] = useState<HostActionPending>(null);
  const [failed, setFailed] = useState<HostActionFailed>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [fixStart, setFixStart] = useState<{ verb: 'update' | 'install'; at: number } | null>(null);
  const [lastTriedAt, setLastTriedAt] = useState<number | null>(null);
  const attempt = useRef<Attempt | null>(null);

  const begin = (mode: Attempt['mode'], p: HostActionPending) => {
    const at = serverNow();
    attempt.current = { mode, before: status, startedAt: at, checkedAt: checkedAtOf(status) };
    setPending(p); setFailed(null); setReceipt(null); setLastTriedAt(at);
  };

  const runConnect = useCallback(async (p: HostActionPending) => {
    begin('connect', p);
    try {
      seedHostStatus(await connectHost(alias));
    } catch (err) {
      log.warn('host-actions', 'connect request failed', { host: alias, error: String(err) });
      attempt.current = null;
      setPending(null); setFailed('retry');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, status]);

  const retry = useCallback(() => runConnect('retry'), [runConnect]);
  const connectNow = retry;
  const update = useCallback(async (verb: 'update' | 'install' = 'update') => {
    // The progress line names what runs ('Installing Claude Code on X...' for an npm build).
    setFixStart({ verb, at: serverNow() });
    await runConnect('fix');
  }, [runConnect]);

  // A user Retry reads as theirs on every surface (and lets a discovered host take a banner row).
  useEffect(() => (pending === 'retry' ? markUserRetry([alias]) : undefined), [pending, alias]);

  const checkAgain = useCallback(async () => {
    begin('readiness', 'check');
    try {
      seedHostStatus(await checkHostReadiness(alias));
    } catch (err) {
      log.warn('host-actions', 'readiness check request failed', { host: alias, error: String(err) });
      attempt.current = null;
      setPending(null); setFailed('check');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, status]);

  // Settle a user-started attempt when a frame AFTER the request says how it ended.
  const posted = pending !== null && attempt.current !== null;
  useEffect(() => {
    const a = attempt.current;
    if (!a || !posted || !status) return;
    let done = false;
    if (a.mode === 'connect') done = !isConnectingPhaseWire(status.phase) && status.phase !== 'idle' && (status.at ?? 0) >= a.startedAt - 1000;
    else {
      const r = status.readiness;
      if (r?.checkError && checkedAtOf(status) > a.checkedAt) { attempt.current = null; setPending(null); setFailed('check'); return; }
      done = checkedAtOf(status) > a.checkedAt || !status.connected;
    }
    if (!done) return;
    attempt.current = null;
    setPending(null);
    setReceipt(sameResultReceipt(a.before, status, a.mode));
  }, [status, posted]);

  // A request that never gets an answer frame still ends (the check has its own server deadline).
  useEffect(() => {
    if (!pending || pending === 'fix') return;
    const cap = pending === 'check' ? 20_000 : 6 * 60_000;
    const t = setTimeout(() => { attempt.current = null; setPending(null); }, cap);
    return () => clearTimeout(t);
  }, [pending]);

  useEffect(() => {
    if (!receipt) return;
    const t = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(t);
  }, [receipt]);

  // Fix progress: follow the server's fixing, and hold it past the end until a newer answer.
  const serverFixing = status?.readiness?.fixing;
  const fixFailed = !!status?.readiness?.problems?.some((p) => p.fix?.state === 'failed');
  const sawServerFix = useRef(false);
  useEffect(() => {
    if (serverFixing) {
      sawServerFix.current = true;
      // Hold from the FIX's start, not the click: the click's own re-check lands
      // before the fix begins, and letting go on that older answer flashes the warning back.
      const at = serverFixing.startedAt;
      if (!fixStart) setFixStart({ verb: verbOf(serverFixing.action), at: at ?? serverNow() });
      else if (typeof at === 'number' && at > fixStart.at) setFixStart({ verb: verbOf(serverFixing.action), at });
      return;
    }
    if (!fixStart) return;
    if (fixFailed || (sawServerFix.current && checkedAtOf(status) > fixStart.at)) {
      sawServerFix.current = false;
      setFixStart(null);
      return;
    }
    if (sawServerFix.current) return;
    // Update was clicked but the server never started a fix: do not spin forever.
    const t = setTimeout(() => setFixStart(null), 30_000);
    return () => clearTimeout(t);
  }, [serverFixing, fixFailed, fixStart, status]);

  const fixing: HostFixingView | null = fixStart
    ? { verb: serverFixing ? verbOf(serverFixing.action) : fixStart.verb, startedAt: serverFixing?.startedAt ?? fixStart.at }
    : null;
  return {
    retry, connectNow, update, checkAgain,
    pending: pending === 'fix' ? (fixing ? 'fix' : null) : pending ?? (fixing ? 'fix' : null),
    failed, receipt, fixing, lastTriedAt,
  };
}
