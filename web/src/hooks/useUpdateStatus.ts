/**
 * The "is a newer Open Walnut published?" answer, for the notification panel's
 * System zone and the Settings build line.
 *
 * One module-level copy: the panel fetches when it OPENS (the System rail's dot
 * needs the answer before the user looks at System) and every consumer reads the
 * same value, so a Settings page and an open panel never disagree. The server
 * answers from its own cache (it asks the registry daily), so a refetch per open
 * is one cheap local GET. `checkNow` is the card's button: the server asks the
 * registry at once and everyone sharing the hook sees the result.
 */
import { useCallback, useEffect, useState } from 'react';
import { checkForUpdateNow, fetchUpdateStatus, type UpdateStatus } from '@/api/update';
import { log } from '@/utils/log';

let shared: UpdateStatus | null = null;
let fetchedAt = 0;
let inflight: Promise<UpdateStatus | null> | null = null;
const listeners = new Set<(s: UpdateStatus | null) => void>();
/** The panel's open and its System tab both ask; within this window the second read is free. */
const FRESH_MS = 30_000;

function publish(next: UpdateStatus | null): void {
  shared = next;
  fetchedAt = Date.now();
  for (const fn of listeners) fn(next);
}

function load(): Promise<UpdateStatus | null> {
  if (inflight) return inflight;
  if (shared && Date.now() - fetchedAt < FRESH_MS) return Promise.resolve(shared);
  inflight = fetchUpdateStatus()
    .then((s) => { publish(s); return s; })
    .catch((err) => {
      log.warn('notifications', 'update status fetch failed', { error: String(err) });
      return shared;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useUpdateStatus(enabled: boolean): {
  status: UpdateStatus | null;
  checking: boolean;
  checkNow: () => Promise<void>;
} {
  const [status, setStatus] = useState<UpdateStatus | null>(shared);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    listeners.add(setStatus);
    return () => { listeners.delete(setStatus); };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled]);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      publish(await checkForUpdateNow());
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
