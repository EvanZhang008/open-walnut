/**
 * N5: the needs-you sort reads each worker's session status (a pending prompt,
 * an error). Right after a reload the store still holds the task list's
 * copy, and the first hydration batch landing ~1s later re-sorted the lanes
 * under the user and flashed a dozen cards as moved. The board lays cards out
 * only once its team's statuses were hydrated in this page: at once when the
 * page's own list hydration already answered for all of them (the usual path,
 * the Board opened after Home), else after one fetch of the missing ones, or
 * after STATUS_READY_CAP_MS so a slow server never blanks the board.
 */
import { useEffect, useState } from 'react';
import { hydrateSessionStatuses, sessionStatusHydrated } from '@/api/sessions';
import { log } from '@/utils/log';

export const STATUS_READY_CAP_MS = 2_500;

/** True once the team's session statuses for `ownerId` are fresh (or the cap passed). */
export function useTeamStatusReady(ownerId: string, sessionIds: readonly string[] | null): boolean {
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const known = sessionIds !== null;
  const fresh = !!sessionIds && sessionIds.every(sessionStatusHydrated);
  useEffect(() => {
    if (readyFor === ownerId || !known) return;
    if (fresh) { setReadyFor(ownerId); return; }
    let live = true;
    const started = Date.now();
    const missing = (sessionIds ?? []).filter((id) => !sessionStatusHydrated(id));
    const finish = (how: string) => {
      if (!live) return;
      live = false;
      log.info('board', 'kanban team statuses ready', { taskId: ownerId, sessions: missing.length, how, ms: Date.now() - started });
      setReadyFor(ownerId);
    };
    const cap = setTimeout(() => finish('cap'), STATUS_READY_CAP_MS);
    void hydrateSessionStatuses(missing).finally(() => finish('fetched'));
    return () => { clearTimeout(cap); live = false; };
  }, [ownerId, known, fresh, readyFor]); // eslint-disable-line react-hooks/exhaustive-deps
  return readyFor === ownerId || (known && fresh);
}
