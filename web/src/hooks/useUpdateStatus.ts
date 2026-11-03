/**
 * The "is a newer Open Walnut published, and where is this server's own update?"
 * answer, for the update notice (StaleBuildPill), the notification panel's
 * System zone, and Settings.
 *
 * One module-level copy, live: the first consumer to mount starts it (the update
 * notice is always mounted, so that is app start, not the panel's first open:
 * a panel opened before the answer came used to show nothing), the server pushes
 * every check and every live-update step as WS `system:update`, and a reconnect
 * (the server restarted into a new version, the socket dropped) reads it again.
 * The panel's open still refetches, free within FRESH_MS. `checkNow` is the
 * card's button: the server asks the registry at once and everyone sees it.
 *
 * An older server sends no `system:update` and no `live`: then this is the
 * fetch-on-open copy it always was.
 */
import { useCallback, useEffect, useState } from 'react';
import { checkForUpdateNow, fetchUpdateStatus, type UpdateStatus } from '@/api/update';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';

let shared: UpdateStatus | null = null;
let fetchedAt = 0;
let inflight: Promise<UpdateStatus | null> | null = null;
/** A forced read asked while another was out: it runs once that one ends (that one may predate a restart). */
let forcedNext: Promise<UpdateStatus | null> | null = null;
/** Bumped by every publish: a fetch that started before a pushed status must not undo it. */
let generation = 0;
let started = false;
const listeners = new Set<(s: UpdateStatus | null) => void>();
/** The panel's open and its System tab both ask; within this window the second read is free. */
const FRESH_MS = 30_000;

function publish(next: UpdateStatus | null): void {
  shared = next;
  fetchedAt = Date.now();
  generation++;
  for (const fn of listeners) fn(next);
}

/** A status pushed or answered by the server (WS frame, the install/restart reply). */
export function applyUpdateStatus(next: unknown): void {
  const status = asStatus(next);
  if (status) publish(status);
}

/** The WS frame carries the status itself; tolerate a `{ status }` envelope too. */
function asStatus(data: unknown): UpdateStatus | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<UpdateStatus> & { status?: unknown };
  if (typeof d.current === 'string' && d.install && typeof d.enabled === 'boolean') return d as UpdateStatus;
  if (d.status && typeof d.status === 'object') return asStatus(d.status);
  return null;
}

/** Read the server's cached answer. `force` skips the freshness window (a reconnect, a poll). */
export function refreshUpdateStatus(force = false): Promise<UpdateStatus | null> {
  if (inflight) {
    if (!force) return inflight;
    // The read out now may have left before the server went away: read once more after it.
    forcedNext ??= inflight.then(() => { forcedNext = null; return refreshUpdateStatus(true); });
    return forcedNext;
  }
  if (!force && shared && Date.now() - fetchedAt < FRESH_MS) return Promise.resolve(shared);
  return read();
}

function read(): Promise<UpdateStatus | null> {
  const startedAt = generation;
  inflight = fetchUpdateStatus()
    .then((s) => {
      // A push landed while this read was out: it is newer than what the read saw.
      if (generation === startedAt) publish(s);
      return shared;
    })
    .catch((err) => {
      log.warn('notifications', 'update status fetch failed', { error: String(err) });
      return shared;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

function onPushed(data: unknown): void { applyUpdateStatus(data); }
function onReconnected(): void { void refreshUpdateStatus(true); }

/** Starts the live copy once per page: WS pushes, a refetch per reconnect, the first read. */
export function startUpdateStatusStore(): void {
  if (started) return;
  started = true;
  wsClient.onEvent('system:update', onPushed);
  wsClient.onEvent('_ws:reconnected', onReconnected);
  void refreshUpdateStatus();
}

/** The page's current copy (null before the first answer). */
export function peekUpdateStatus(): UpdateStatus | null {
  return shared;
}

/** Test seam: forget the module copy and its subscriptions. */
export function resetUpdateStatusForTests(): void {
  if (started) {
    wsClient.offEvent('system:update', onPushed);
    wsClient.offEvent('_ws:reconnected', onReconnected);
  }
  shared = null;
  fetchedAt = 0;
  inflight = null;
  forcedNext = null;
  generation = 0;
  started = false;
  listeners.clear();
}

/** `enabled`: read again now (within the freshness window) — the panel passes its open state. */
export function useUpdateStatus(enabled: boolean): {
  status: UpdateStatus | null;
  checking: boolean;
  checkNow: () => Promise<void>;
} {
  const [status, setStatus] = useState<UpdateStatus | null>(shared);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    listeners.add(setStatus);
    startUpdateStatusStore();
    setStatus(shared);
    return () => { listeners.delete(setStatus); };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refreshUpdateStatus();
  }, [enabled]);

  const checkNow = useCallback(async () => {
    setChecking(true);
    const startedAt = generation;
    try {
      const answer = await checkForUpdateNow();
      // A check that finds a release starts the install at once and pushes it: keep the push.
      if (generation === startedAt) publish(answer);
    } catch (err) {
      log.warn('notifications', 'update check failed', { error: String(err) });
    } finally {
      setChecking(false);
    }
  }, []);

  return { status, checking, checkNow };
}

/** Whether the System rail should carry its (quiet, accent) dot for an update. */
export function updateAvailable(status: UpdateStatus | null): boolean {
  return !!status && status.enabled && status.available;
}
