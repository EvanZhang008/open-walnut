/**
 * Whether an org node keeps a Board (GET /api/v1/tasks/:id/board/owner), so the
 * Org page opens on it when there is one and on the Team columns when not.
 * One small read per node, remembered for the page's life: going back to a lead
 * must not flash its tabs while the answer comes back again. A board the lead
 * writes while the user watches announces itself (`board:changed`).
 */
import { useEffect, useState } from 'react';
import { apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

const known = new Map<string, boolean>();

/** null while the first answer for `taskId` is on its way; no task keeps no Board. */
export function useHasBoard(taskId: string | undefined): boolean | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!taskId) return;
    let live = true;
    apiGet<{ task_id: string; has_board: boolean }>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/board/owner`, undefined, { quietStatuses: [404] },
    ).then((res) => {
      known.set(taskId, !!res.has_board);
      // Always re-render a live caller: an earlier, cancelled read may have filled the cache
      // while this one was on its way (StrictMode runs every effect twice).
      if (live) bump((n) => n + 1);
    }).catch((err) => {
      log.warn('org-page', 'board owner read failed', { taskId, error: err instanceof Error ? err.message : String(err) });
      if (!known.has(taskId)) known.set(taskId, false);
      if (live) bump((n) => n + 1);
    });
    return () => { live = false; };
  }, [taskId]);
  useEvent('board:changed', (data) => {
    const changed = (data as { taskId?: string } | null)?.taskId;
    if (!taskId || changed !== taskId || known.get(taskId) === true) return;
    known.set(taskId, true);
    bump((n) => n + 1);
  });
  return taskId ? known.get(taskId) ?? null : false;
}
