import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { SessionRecord } from '@/types/session';
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
