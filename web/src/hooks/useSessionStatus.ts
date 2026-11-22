import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SessionRecord } from '@/types/session';
import type { SessionCronMetadata, Task } from '@open-walnut/core';
import { resolveTaskSessionId } from '@/utils/session-status';
import { taskIconState, type TaskIconState } from '@/utils/task-icon-state';
import { onPageVisible } from '@/utils/page-visibility';
import { useIdleCompactingSession } from '@/stores/idle-compacting-store';
import {
  resolveSessionRecordStatus,
  sessionStatusStore,
  type SessionSettingsPatch,
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

/** The session's cron/wakeup observation, or null when nothing is known. Own
 *  listener set: a cron delivery never re-renders plain status consumers. */
export function useSessionCron(
  sessionId: string | null | undefined,
): SessionCronMetadata | null {
  const getSnapshot = useCallback(
    () => sessionStatusStore.getCron(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(
    sessionStatusStore.subscribeCron,
    getSnapshot,
    getSnapshot,
  );
}

export function useActiveSessionCron(sessionId: string | null | undefined): SessionCronMetadata | null {
  const cron = useSessionCron(sessionId);
  const status = useSessionStatus(sessionId);
  const validUntil = cron?.validUntil ?? null;
  const [, setExpiryTick] = useState(0);

  useEffect(() => {
    if (validUntil === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      clearTimeout(timer);
      const remaining = validUntil - Date.now();
      if (remaining > 0) timer = setTimeout(check, Math.min(remaining + 1, 2_147_483_647));
      else {
        off();
        setExpiryTick((tick) => tick + 1);
      }
    };
    const off = onPageVisible(check);
    check();
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [validUntil]);

  if (!cron || cron.presence !== 'active' || cron.source !== 'cron' || !cron.known || cron.stale
    || !status || status.archived || status.process_status === 'stopped'
    || (validUntil !== null && validUntil <= Date.now())) return null;
  return cron;
}

/** The session's shared settings overlay (mode / model / effort / output_mode /
 *  ACP model) — one browser, one truth for what the composer pills show. */
export function useSessionSettings(
  sessionId: string | null | undefined,
): SessionSettingsPatch | null {
  const getSnapshot = useCallback(
    () => sessionStatusStore.getSettings(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(
    sessionStatusStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
}

export function useResolvedSessionRecord<T extends SessionRecord | null>(record: T): T {
  const sessionId = record?.claudeSessionId;
  const status = useSessionStatus(sessionId);
  // Settings has its own dep: a model/effort write changes no status snapshot,
  // so `status` identity alone would leave the pill on the old value.
  const settings = useSessionSettings(sessionId);
  return useMemo(
    () => record ? resolveSessionRecordStatus(record) as T : record,
    [record, status, settings],
  );
}

/** A task's live status icon state (utils/task-icon-state.ts): subscribes the icon to the
 *  session-status store, so a turn that starts or a prompt that waits on the user shows at once
 *  (2026-08-14: every unfinished Satellite task rendered the same calm blue). Falls back to the
 *  task's REST enrichment snapshot (`session_status`) while the store has nothing yet. */
export function useTaskIconState(task: Task, snoozed = false): TaskIconState {
  const sessionId = resolveTaskSessionId(task);
  const status = useSessionStatus(sessionId);
  // Re-read when Walnut's idle compaction starts or ends (taskIconState reads it).
  useIdleCompactingSession(sessionId);
  return taskIconState(task, status, snoozed, sessionId);
}
