/**
 * What each team task's own threads say (experiment brief_off): a Board card's status chip reads
 * its task's thread state (needs > read > working > waiting > done, core/org/thread-view.ts
 * threadStateOf) instead of its separate status. One read of `GET /api/v1/thread-states` for the
 * whole team, again a beat after any thread of one of them changes (`org-threads:changed`). Off,
 * nothing is read and the map stays empty, so every card keeps today's status.
 */
import { useEffect, useState } from 'react';
import type { TaskThreadState } from '@open-walnut/thread-groups';
import { apiGet } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

const DEBOUNCE_MS = 400;
const NONE: ReadonlyMap<string, TaskThreadState> = new Map();

export function useTeamThreadStates(ownerId: string, ids: readonly string[], enabled: boolean): ReadonlyMap<string, TaskThreadState> {
  const [map, setMap] = useState<ReadonlyMap<string, TaskThreadState>>(NONE);
  const [tick, setTick] = useState(0);
  const key = enabled ? ids.join(',') : '';
  useEvent('org-threads:changed', (data) => {
    const taskId = (data as { taskId?: unknown } | undefined)?.taskId;
    if (enabled && (typeof taskId !== 'string' || key.split(',').includes(taskId))) setTick((n) => n + 1);
  });
  useEffect(() => {
    if (!key) { setMap(NONE); return; }
    let alive = true;
    const timer = setTimeout(() => {
      apiGet<{ on: boolean; states: Record<string, TaskThreadState> }>('/api/v1/thread-states', { ids: key }, { priority: 'low' })
        .then((r) => { if (alive) setMap(r.on ? new Map(Object.entries(r.states)) : NONE); })
        .catch((err: unknown) => log.warn('board', 'kanban thread states not read', { taskId: ownerId, error: err instanceof Error ? err.message : String(err) }));
    }, tick ? DEBOUNCE_MS : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [key, tick, ownerId]);
  return map;
}
