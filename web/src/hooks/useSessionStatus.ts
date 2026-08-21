import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { SessionRecord } from '@/types/session';
import type { Task } from '@open-walnut/core';
import { resolveTaskSessionId, taskCircleClass } from '@/utils/session-status';
import {
  resolveSessionRecordStatus,
  sessionStatusStore,
  type StoredSessionStatus,
} from '@/stores/session-status-store';

export function useSessionStatus(
  sessionId: string | null | undefined,
  fallback?: StoredSessionStatus | null,
): StoredSessionStatus | null {
  const getSnapshot = useCallback(
    () => sessionStatusStore.getStatus(sessionId),
    [sessionId],
  );
  const status = useSyncExternalStore(
    sessionStatusStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
  return status ?? fallback ?? null;
}

export function useCanonicalSessionId(sessionId: string | null | undefined): string | null {
  const getSnapshot = useCallback(
    () => sessionStatusStore.resolveSessionId(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(
    sessionStatusStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
}

export function useSessionStatusEpoch(): number {
  return useSyncExternalStore(
    sessionStatusStore.subscribe,
    sessionStatusStore.getEpoch,
    sessionStatusStore.getEpoch,
  );
}

export function useResolvedSessionRecord<T extends SessionRecord | null>(record: T): T {
  const sessionId = record?.claudeSessionId;
  const status = useSessionStatus(sessionId);
  return useMemo(
    () => record ? resolveSessionRecordStatus(record) as T : record,
    [record, status],
  );
}

/** Live task-circle class: subscribes the circle to the session-status store
 *  so error/waiting/running surface in task lists in real time (2026-08-14:
 *  every unfinished Satellite task rendered the same calm blue). Falls back
 *  to the task's REST enrichment snapshot when the store has nothing yet. */
export function useTaskCircle(task: Task): string {
  const status = useSessionStatus(resolveTaskSessionId(task));
  return taskCircleClass(task, status);
}
