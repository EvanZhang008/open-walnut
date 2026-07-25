import type { Task } from '@open-walnut/core';
import type {
  ProcessStatus,
  SessionEngine,
  SessionMode,
  SessionProvider,
  SessionRecord,
} from '@/types/session';
import { log } from '@/utils/log';

export interface SessionStatusSnapshot {
  sessionId: string;
  taskId: string | null;
  process_status: ProcessStatus;
  activity: string | null;
  mode: SessionMode;
  planCompleted: boolean;
  archived: boolean;
  errorMessage: string | null;
  provider: SessionProvider;
  engine: SessionEngine;
  statusRevision: number;
  statusUpdatedAt: string;
}

export interface LegacySessionStatusSnapshot
  extends Omit<SessionStatusSnapshot, 'statusRevision' | 'statusUpdatedAt'> {
  statusRevision: null;
  statusUpdatedAt: string | null;
}

export type StoredSessionStatus = SessionStatusSnapshot | LegacySessionStatusSnapshot;
export type SessionStatusSource =
  | 'ws'
  | 'ws:error'
  | 'rest:session'
  | 'rest:session-list'
  | 'rest:task'
  | 'rest:task-list'
  | 'rest:dashboard'
  | 'test';

export type SessionStatusApplyResult =
  | 'accepted'
  | 'duplicate'
  | 'rejected-conflict'
  | 'rejected-invalid'
  | 'rejected-legacy'
  | 'rejected-stale';

type UnknownRecord = Record<string, unknown>;
type LegacyStatusPatch = Partial<Omit<
  LegacySessionStatusSnapshot,
  'sessionId' | 'statusRevision'
>>;

const STATUS_FIELDS = [
  'taskId',
  'process_status',
  'activity',
  'mode',
  'planCompleted',
  'archived',
  'errorMessage',
  'provider',
  'engine',
  'statusRevision',
  'statusUpdatedAt',
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProviderSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('pending:')
    // ACP runtime IDs are Walnut process identities, never provider session IDs.
    && !/^acp-[0-9a-f]{16}$/.test(value);
}

function isProcessStatus(value: unknown): value is ProcessStatus {
  return value === 'running' || value === 'idle' || value === 'stopped' || value === 'error';
}

function isSessionMode(value: unknown): value is SessionMode {
  return value === 'bypass' || value === 'accept' || value === 'default' || value === 'plan';
}

function isSessionProvider(value: unknown): value is SessionProvider {
  return value === 'cli' || value === 'sdk' || value === 'embedded';
}

function isSessionEngine(value: unknown): value is SessionEngine {
  return value === 'claude' || value === 'codex';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function snapshotsEqual(a: SessionStatusSnapshot, b: SessionStatusSnapshot): boolean {
  return a.sessionId === b.sessionId
    && a.taskId === b.taskId
    && a.process_status === b.process_status
    && a.activity === b.activity
    && a.mode === b.mode
    && a.planCompleted === b.planCompleted
    && a.archived === b.archived
    && a.errorMessage === b.errorMessage
    && a.provider === b.provider
    && a.engine === b.engine
    && a.statusRevision === b.statusRevision
    && a.statusUpdatedAt === b.statusUpdatedAt;
}

function normalizeVersionedStatus(value: unknown, fallbackSessionId?: string): SessionStatusSnapshot | null {
  if (!isRecord(value)) return null;
  const sessionId = isProviderSessionId(value.sessionId)
    ? value.sessionId
    : fallbackSessionId;
  if (!isProviderSessionId(sessionId)
    || !isProcessStatus(value.process_status)
    || !('taskId' in value) || !isNullableString(value.taskId)
    || !('activity' in value) || !isNullableString(value.activity)
    || !isSessionMode(value.mode)
    || typeof value.planCompleted !== 'boolean'
    || typeof value.archived !== 'boolean'
    || !('errorMessage' in value) || !isNullableString(value.errorMessage)
    || !isSessionProvider(value.provider)
    || !isSessionEngine(value.engine)
    || !Number.isSafeInteger(value.statusRevision)
    || (value.statusRevision as number) < 1
    || typeof value.statusUpdatedAt !== 'string') {
    return null;
  }

  return {
    sessionId,
    taskId: nullableString(value.taskId),
    process_status: value.process_status,
    activity: nullableString(value.activity),
    mode: value.mode,
    planCompleted: value.planCompleted,
    archived: value.archived,
    errorMessage: value.errorMessage,
    provider: value.provider,
    engine: value.engine,
    statusRevision: value.statusRevision as number,
    statusUpdatedAt: value.statusUpdatedAt,
  };
}

function normalizeVersionedSessionRecord(
  value: UnknownRecord,
  sessionId: string,
): SessionStatusSnapshot | null {
  if (!isProcessStatus(value.process_status)
    || !Number.isSafeInteger(value.statusRevision)
    || (value.statusRevision as number) < 1
    || typeof value.statusUpdatedAt !== 'string') {
    return null;
  }

  return {
    sessionId,
    taskId: nullableString(value.taskId),
    process_status: value.process_status,
    activity: nullableString(value.activity),
    mode: isSessionMode(value.mode) ? value.mode : 'default',
    planCompleted: value.planCompleted === true,
    archived: value.archived === true,
    errorMessage: nullableString(
      'errorMessage' in value ? value.errorMessage : value.error,
    ),
    provider: isSessionProvider(value.provider) ? value.provider : 'cli',
    engine: isSessionEngine(value.engine) ? value.engine : 'claude',
    statusRevision: value.statusRevision as number,
    statusUpdatedAt: value.statusUpdatedAt,
  };
}

function legacyPatchFromRecord(value: UnknownRecord): LegacyStatusPatch {
  const patch: LegacyStatusPatch = {};
  if ('taskId' in value) patch.taskId = nullableString(value.taskId);
  if (isProcessStatus(value.process_status)) patch.process_status = value.process_status;
  if ('activity' in value) patch.activity = nullableString(value.activity);
  if ('mode' in value) patch.mode = isSessionMode(value.mode) ? value.mode : 'default';
  if ('planCompleted' in value) patch.planCompleted = value.planCompleted === true;
  if ('archived' in value) patch.archived = value.archived === true;
  if ('errorMessage' in value || 'error' in value) {
    patch.errorMessage = nullableString(
      'errorMessage' in value ? value.errorMessage : value.error,
    );
  }
  if ('provider' in value) patch.provider = isSessionProvider(value.provider) ? value.provider : 'cli';
  if ('engine' in value) patch.engine = isSessionEngine(value.engine) ? value.engine : 'claude';
  if ('statusUpdatedAt' in value) patch.statusUpdatedAt = nullableString(value.statusUpdatedAt);
  else if ('last_status_change' in value) patch.statusUpdatedAt = nullableString(value.last_status_change);
  return patch;
}

function defaultLegacyStatus(sessionId: string): LegacySessionStatusSnapshot {
  return {
    sessionId,
    taskId: null,
    process_status: 'stopped',
    activity: null,
    mode: 'default',
    planCompleted: false,
    archived: false,
    errorMessage: null,
    provider: 'cli',
    engine: 'claude',
    statusRevision: null,
    statusUpdatedAt: null,
  };
}

export class SessionStatusStore {
  private statuses = new Map<string, StoredSessionStatus>();
  /** session+source pairs whose legacy-input rejection was already logged. */
  private legacyRejectWarned = new Set<string>();
  private aliases = new Map<string, string>();
  private listeners = new Set<() => void>();
  private epoch = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getEpoch = (): number => this.epoch;

  resolveSessionId(sessionId: string | null | undefined): string | null {
    if (!isProviderSessionId(sessionId)) return null;
    let current = sessionId;
    const seen = new Set<string>();
    while (this.aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.aliases.get(current)!;
    }
    return current;
  }

  getStatus = (sessionId: string | null | undefined): StoredSessionStatus | null => {
    const resolved = this.resolveSessionId(sessionId);
    return resolved ? this.statuses.get(resolved) ?? null : null;
  };

  applyVersioned(
    input: unknown,
    source: SessionStatusSource,
    previousSessionId?: string,
  ): SessionStatusApplyResult {
    const fallbackSessionId = isRecord(input) && isProviderSessionId(input.sessionId)
      ? input.sessionId
      : undefined;
    const snapshot = normalizeVersionedStatus(input, fallbackSessionId);
    if (!snapshot) {
      log.warn('session-status', 'rejected invalid versioned snapshot', {
        sessionId: fallbackSessionId ?? null,
        revision: isRecord(input) ? input.statusRevision : null,
        source,
      });
      return 'rejected-invalid';
    }

    if (isProviderSessionId(previousSessionId) && previousSessionId !== snapshot.sessionId) {
      const previousCanonical = this.resolveSessionId(previousSessionId) ?? previousSessionId;
      const nextCanonical = this.resolveSessionId(snapshot.sessionId) ?? snapshot.sessionId;
      if (previousCanonical !== nextCanonical) {
        const previous = this.statuses.get(previousCanonical);
        if (previous?.statusRevision != null) {
          if (snapshot.statusRevision < previous.statusRevision) {
            this.logRejected('stale alias', snapshot, previous, source);
            return 'rejected-stale';
          }
          if (snapshot.statusRevision === previous.statusRevision) {
            this.logRejected('equal revision alias conflict', snapshot, previous, source);
            return 'rejected-conflict';
          }
        }

        const next = this.statuses.get(nextCanonical);
        const normalizedNext = nextCanonical === snapshot.sessionId
          ? snapshot
          : { ...snapshot, sessionId: nextCanonical };
        if (next?.statusRevision != null) {
          if (snapshot.statusRevision < next.statusRevision) {
            this.logRejected('stale alias target', normalizedNext, next, source);
            return 'rejected-stale';
          }
          if (snapshot.statusRevision === next.statusRevision
            && !snapshotsEqual(normalizedNext, next)) {
            this.logRejected('equal revision alias target conflict', normalizedNext, next, source);
            return 'rejected-conflict';
          }
        }

        this.promoteAlias(previousSessionId, snapshot.sessionId, source);
      }
    }

    const canonicalId = this.resolveSessionId(snapshot.sessionId) ?? snapshot.sessionId;
    const normalized = canonicalId === snapshot.sessionId
      ? snapshot
      : { ...snapshot, sessionId: canonicalId };
    const current = this.statuses.get(canonicalId);
    if (current?.statusRevision != null) {
      if (normalized.statusRevision < current.statusRevision) {
        this.logRejected('stale', normalized, current, source);
        return 'rejected-stale';
      }
      if (normalized.statusRevision === current.statusRevision) {
        if (snapshotsEqual(normalized, current)) return 'duplicate';
        this.logRejected('equal revision conflict', normalized, current, source);
        return 'rejected-conflict';
      }
    }

    this.statuses.set(canonicalId, normalized);
    this.acceptTransition(current, normalized, source);
    return 'accepted';
  }

  applyLegacy(
    sessionId: string,
    patch: LegacyStatusPatch,
    source: SessionStatusSource,
  ): SessionStatusApplyResult {
    const canonicalId = this.resolveSessionId(sessionId);
    if (!canonicalId) return 'rejected-invalid';
    const current = this.statuses.get(canonicalId);
    if (current?.statusRevision != null) {
      // Expected steady-state: every task/task-list poll re-seeds legacy
      // fields for sessions that already hold a versioned WS snapshot. Warn
      // once per session+source; repeating it turned page load into hundreds
      // of console lines (each forwarded to the server log — real overhead).
      const warnKey = `${canonicalId}:${source}`;
      if (!this.legacyRejectWarned.has(warnKey)) {
        this.legacyRejectWarned.add(warnKey);
        log.warn('session-status', 'rejected unversioned input after versioned snapshot (once per session+source)', {
          sessionId: canonicalId,
          revision: current.statusRevision,
          source,
        });
      }
      return 'rejected-legacy';
    }

    const next: LegacySessionStatusSnapshot = {
      ...(current ?? defaultLegacyStatus(canonicalId)),
      ...patch,
      sessionId: canonicalId,
      statusRevision: null,
    };
    if (current && STATUS_FIELDS.every((field) => current[field] === next[field])) {
      return 'duplicate';
    }
    this.statuses.set(canonicalId, next);
    this.acceptTransition(current, next, source);
    return 'accepted';
  }

  seedSessionRecord(record: unknown, source: SessionStatusSource = 'rest:session'): void {
    if (!isRecord(record)) return;
    const providerId = isProviderSessionId(record.claudeSessionId)
      ? record.claudeSessionId
      : isProviderSessionId(record.sessionId)
        ? record.sessionId
        : null;
    if (!providerId) return;

    const nestedStatus = isRecord(record.status) ? record.status : null;
    const versioned = nestedStatus
      ? normalizeVersionedStatus(nestedStatus, providerId)
      : normalizeVersionedSessionRecord(record, providerId);
    if (versioned) {
      this.applyVersioned(versioned, source);
      return;
    }
    if (isProcessStatus(record.process_status)) {
      this.applyLegacy(providerId, legacyPatchFromRecord(record), source);
    }
  }

  seedTaskRecord(task: unknown, source: SessionStatusSource = 'rest:task'): void {
    if (!isRecord(task)) return;
    const taskId = typeof task.id === 'string' ? task.id : null;
    const slots = [
      ['session_id', 'session_status'],
      ['plan_session_id', 'plan_session_status'],
      ['exec_session_id', 'exec_session_status'],
    ] as const;

    for (const [idField, statusField] of slots) {
      const providerId = task[idField];
      const rawStatus = task[statusField];
      if (!isProviderSessionId(providerId) || !isRecord(rawStatus)) continue;
      const candidate: UnknownRecord = {
        ...rawStatus,
        sessionId: rawStatus.sessionId ?? providerId,
      };
      if (!('taskId' in candidate)) candidate.taskId = taskId;
      const versioned = normalizeVersionedStatus(candidate, providerId);
      if (versioned) this.applyVersioned(versioned, source);
      else if (isProcessStatus(rawStatus.process_status)) {
        this.applyLegacy(providerId, {
          ...legacyPatchFromRecord(candidate),
          taskId,
        }, source);
      }
    }
  }

  seedTaskList(tasks: unknown, source: SessionStatusSource = 'rest:task-list'): void {
    if (!Array.isArray(tasks)) return;
    for (const task of tasks) this.seedTaskRecord(task, source);
  }

  ingestStatusEvent(data: unknown): SessionStatusApplyResult {
    if (!isRecord(data)) return 'rejected-invalid';
    if ('status' in data) {
      return this.applyVersioned(data.status, 'ws',
        isProviderSessionId(data.previousSessionId) ? data.previousSessionId : undefined);
    }
    // Compatibility with servers that shipped the complete snapshot at the top
    // level before the event gained its nested `status` property.
    if (Number.isSafeInteger(data.statusRevision)) {
      return this.applyVersioned(data, 'ws',
        isProviderSessionId(data.previousSessionId) ? data.previousSessionId : undefined);
    }

    if (!isProviderSessionId(data.sessionId)) return 'rejected-invalid';
    return this.applyLegacy(data.sessionId, legacyPatchFromRecord(data), 'ws');
  }

  ingestErrorEvent(data: unknown): SessionStatusApplyResult {
    if (!isRecord(data) || !isProviderSessionId(data.sessionId) || typeof data.error !== 'string') {
      return 'rejected-invalid';
    }
    return this.applyLegacy(data.sessionId, {
      process_status: 'error',
      errorMessage: data.error.slice(0, 500),
    }, 'ws:error');
  }

  clearForTesting(): void {
    this.statuses.clear();
    this.aliases.clear();
    this.epoch++;
    this.emit();
  }

  private promoteAlias(previousSessionId: string, nextSessionId: string, source: SessionStatusSource): void {
    const previousCanonical = this.resolveSessionId(previousSessionId) ?? previousSessionId;
    const nextCanonical = this.resolveSessionId(nextSessionId) ?? nextSessionId;
    if (previousCanonical === nextCanonical) return;

    const previous = this.statuses.get(previousCanonical);
    const next = this.statuses.get(nextCanonical);
    let promoted = next;
    if (previous && (!next
      || (previous.statusRevision != null
        && (next.statusRevision == null || previous.statusRevision > next.statusRevision)))) {
      promoted = { ...previous, sessionId: nextCanonical };
    }

    this.aliases.set(previousSessionId, nextCanonical);
    this.aliases.set(previousCanonical, nextCanonical);
    for (const [alias, target] of this.aliases) {
      if (target === previousCanonical) this.aliases.set(alias, nextCanonical);
    }
    this.statuses.delete(previousCanonical);
    if (promoted) this.statuses.set(nextCanonical, promoted);
    this.epoch++;
    log.info('session-status', 'provider session alias promoted', {
      sessionId: nextCanonical,
      previousSessionId,
      revision: promoted?.statusRevision ?? null,
      source,
    });
    this.emit();
  }

  private acceptTransition(
    previous: StoredSessionStatus | undefined,
    next: StoredSessionStatus,
    source: SessionStatusSource,
  ): void {
    this.epoch++;
    log.info('session-status', 'transition accepted', {
      sessionId: next.sessionId,
      taskId: next.taskId,
      revision: next.statusRevision,
      source,
      previousProcessStatus: previous?.process_status ?? null,
      processStatus: next.process_status,
    });
    this.emit();
  }

  private logRejected(
    reason: string,
    incoming: SessionStatusSnapshot,
    current: StoredSessionStatus,
    source: SessionStatusSource,
  ): void {
    log.warn('session-status', `rejected ${reason}`, {
      sessionId: incoming.sessionId,
      taskId: incoming.taskId,
      revision: incoming.statusRevision,
      currentRevision: current.statusRevision,
      source,
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const sessionStatusStore = new SessionStatusStore();

export function seedSessionStatus(record: SessionRecord | unknown, source?: SessionStatusSource): void {
  sessionStatusStore.seedSessionRecord(record, source);
}

export function seedTaskSessionStatuses(task: Task | unknown, source?: SessionStatusSource): void {
  sessionStatusStore.seedTaskRecord(task, source);
}

export function resolveSessionRecordStatus<T extends SessionRecord>(record: T): T {
  const status = sessionStatusStore.getStatus(record.claudeSessionId);
  if (!status) return record;
  return {
    ...record,
    taskId: status.taskId ?? '',
    process_status: status.process_status,
    activity: status.activity ?? undefined,
    mode: status.mode ?? 'default',
    planCompleted: status.planCompleted,
    archived: status.archived,
    errorMessage: status.errorMessage ?? undefined,
    provider: status.provider ?? undefined,
    engine: status.engine ?? undefined,
    statusRevision: status.statusRevision ?? undefined,
    statusUpdatedAt: status.statusUpdatedAt ?? undefined,
  };
}
