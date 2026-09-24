import type {
  SessionCronMetadata,
  SessionEffort,
  SessionOutputMode,
  Task,
} from '@open-walnut/core';
import { SESSION_ENGINE_IDS, VALID_SESSION_MODE_IDS, normalizeSessionCronJobs } from '@open-walnut/core';
import type {
  ProcessStatus,
  SessionEngine,
  SessionMode,
  SessionProvider,
  SessionRecord,
} from '@/types/session';
import { log } from '@/utils/log';
import { isPlaceholderColumnId } from '@/utils/column-ids';

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
  /** Pending permission/AskUserQuestion tool name, or null — drives the red
   *  Waiting display on LIST surfaces (pills). Additive; absent on old servers. */
  pendingPermissionTool?: string | null;
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

export type SessionCronApplyResult =
  | 'accepted'
  | 'duplicate'
  | 'rejected-invalid'
  | 'rejected-stale'
  | 'rejected-retired-epoch'
  | 'rejected-unauthorized-epoch';

type UnknownRecord = Record<string, unknown>;
type LegacyStatusPatch = Partial<Omit<
  LegacySessionStatusSnapshot,
  'sessionId' | 'statusRevision'
>>;

/**
 * The session SETTINGS a composer pill writes (permission mode, model, effort,
 * reply style, ACP model). One browser, one session-settings truth: every
 * surface showing a session reads this overlay over its own fetched record, so a
 * click moves the session-column pill, the chat lane pill and the task detail
 * rows in the SAME frame — the REST round-trip and its WS echo only confirm.
 * Same rule as the task store; a private `useState` copy per surface is what
 * made three surfaces disagree for the length of a PATCH.
 *
 * Two authorities, hence two retirement rules (see retireModeOverlay /
 * reconcileSettingsFromRecord):
 *  - `mode` also rides the authoritative status snapshot, so its entry is a
 *    PENDING mark: the first accepted snapshot newer than the mark is the
 *    server's own answer and retires it, agreeing or not.
 *  - model / effort / output_mode / acpModel exist ONLY on the record (no
 *    snapshot carries them), so their entry is the newest value this browser
 *    knows and retires when a fetched record confirms the same value.
 *
 * Key PRESENCE decides, never truthiness: `acpModelName: undefined` means "drop
 * the advertised name, the id changed", which is not "leave it alone".
 */
export interface SessionSettingsPatch {
  mode?: SessionMode;
  model?: string;
  effort?: SessionEffort;
  effectiveEffort?: SessionEffort;
  output_mode?: SessionOutputMode;
  acpModel?: string;
  acpModelName?: string;
}

export type SessionSettingsKey = keyof SessionSettingsPatch;

const SESSION_SETTINGS_KEYS = [
  'mode',
  'model',
  'effort',
  'effectiveEffort',
  'output_mode',
  'acpModel',
  'acpModelName',
] as const satisfies readonly SessionSettingsKey[];

interface SessionSettingsEntry {
  patch: SessionSettingsPatch;
  /** statusRevision the store held when `mode` was written here. The first
   *  ACCEPTED snapshot past this revision is the server's own answer. `null` =
   *  no versioned status existed yet, so any versioned snapshot retires it. */
  modeBaseRevision: number | null;
}

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
  'pendingPermissionTool',
  'statusRevision',
  'statusUpdatedAt',
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProviderSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    // Column placeholders (draft:/pending:) are client-side ids with no server row.
    && !isPlaceholderColumnId(value)
    // ACP runtime IDs are Walnut process identities, never provider session IDs.
    && !/^acp-[0-9a-f]{16}$/.test(value);
}

function isProcessStatus(value: unknown): value is ProcessStatus {
  return value === 'running' || value === 'idle' || value === 'stopped' || value === 'error';
}

/**
 * Derived from the ONE mode registry (core/types.ts) — NOT a hand-listed union.
 *
 * This validator is load-bearing for the mode pill, and a hardcoded list here
 * breaks it in a way that looks like "the button is dead": a status snapshot
 * carrying an unlisted mode fails parse, callers coerce it to 'default'
 * (see the `?? 'default'` fallbacks below), and resolveSessionRecordStatus then
 * overwrites the component's optimistic state on the very next WS status push.
 * The pill visibly snaps back and sticks on "Default" even though the PATCH
 * returned 200.
 */
function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === 'string' && VALID_SESSION_MODE_IDS.has(value);
}

function isSessionProvider(value: unknown): value is SessionProvider {
  return value === 'cli' || value === 'sdk' || value === 'embedded';
}

/**
 * Membership in the ONE engine registry (core/types.ts), same rule as
 * isSessionMode above — and deliberately a STATIC import, never the async
 * /api/engines catalog: this validator runs on every WS status snapshot BEFORE
 * React renders, and a snapshot carrying an engine the list doesn't know is
 * REJECTED whole (normalizeVersionedStatus). Gating it on a fetch would mean
 * every snapshot for a newly added engine gets dropped until the catalog lands.
 */
const KNOWN_ENGINE_IDS: ReadonlySet<string> = new Set(SESSION_ENGINE_IDS);

function isSessionEngine(value: unknown): value is SessionEngine {
  return typeof value === 'string' && KNOWN_ENGINE_IDS.has(value);
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
    // Permission changes can switch Waiting without changing process_status.
    && a.pendingPermissionTool === b.pendingPermissionTool
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
    // Additive: absent on old servers → null (no waiting display).
    pendingPermissionTool: typeof value.pendingPermissionTool === 'string'
      ? value.pendingPermissionTool : null,
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
    // Records carry the full pendingPermission object; snapshots carry the
    // pre-projected tool name. Accept either shape.
    pendingPermissionTool: typeof value.pendingPermissionTool === 'string'
      ? value.pendingPermissionTool
      : isRecord(value.pendingPermission)
        ? String((value.pendingPermission as UnknownRecord).toolName ?? 'unknown')
        : null,
    statusRevision: value.statusRevision as number,
    statusUpdatedAt: value.statusUpdatedAt,
  };
}

function legacyPatchFromRecord(value: UnknownRecord): LegacyStatusPatch {
  const patch: LegacyStatusPatch = {};
  if ('taskId' in value) patch.taskId = nullableString(value.taskId);
  if (isProcessStatus(value.process_status)) patch.process_status = value.process_status;
  // Waiting state rides task-enrichment seeds too (session_status has no
  // statusRevision, so it always lands on this legacy path).
  if ('pendingPermissionTool' in value) {
    patch.pendingPermissionTool = nullableString(value.pendingPermissionTool);
  } else if (isRecord(value.pendingPermission)) {
    patch.pendingPermissionTool = String((value.pendingPermission as UnknownRecord).toolName ?? 'unknown');
  }
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

const MAX_SESSION_ID_LENGTH = 256;
const MAX_CRON_EPOCH_LENGTH = 256;
const MAX_RETIRED_CRON_EPOCHS = 32;
const CRON_PRESENCES: ReadonlySet<string> = new Set(['active', 'inactive', 'unknown']);
const CRON_SOURCES: ReadonlySet<string> = new Set(['cron', 'wakeup']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeCronMetadata(value: unknown): SessionCronMetadata | null {
  if (!isRecord(value)) return null;
  if (!isProviderSessionId(value.sessionId) || value.sessionId.length > MAX_SESSION_ID_LENGTH) return null;
  if (typeof value.epoch !== 'string'
    || value.epoch.length === 0
    || value.epoch.length > MAX_CRON_EPOCH_LENGTH) return null;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return null;
  if (typeof value.presence !== 'string' || !CRON_PRESENCES.has(value.presence)) return null;
  if (value.source !== null && !(typeof value.source === 'string' && CRON_SOURCES.has(value.source))) return null;
  if (typeof value.known !== 'boolean' || typeof value.stale !== 'boolean') return null;
  if (!isFiniteNumber(value.observedAt)) return null;
  if (value.validUntil !== null && !isFiniteNumber(value.validUntil)) return null;
  // Malformed job details are dropped on their own; presence stays authoritative.
  const jobs = normalizeSessionCronJobs(value.jobs);
  if (jobs === null) {
    log.warn('session-cron', 'dropped malformed cron job details', {
      sessionId: value.sessionId, revision: value.revision,
    });
  }

  return {
    sessionId: value.sessionId,
    epoch: value.epoch,
    revision: value.revision as number,
    presence: value.presence as SessionCronMetadata['presence'],
    source: value.source as SessionCronMetadata['source'],
    known: value.known,
    stale: value.stale,
    observedAt: value.observedAt,
    validUntil: value.validUntil as number | null,
    ...(jobs ? { jobs } : {}),
  };
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
  /** Settings every surface must show now — see SessionSettingsPatch. */
  private settings = new Map<string, SessionSettingsEntry>();
  /** Identity-keyed memo for the status+pending-mode merge: getStatus feeds
   *  useSyncExternalStore, which loops forever on a fresh object per call. */
  private mergedStatuses = new Map<string, {
    base: StoredSessionStatus;
    mode: SessionMode;
    value: StoredSessionStatus;
  }>();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private crons = new Map<string, SessionCronMetadata>();
  private cronStale = new Set<string>();
  private cronViews = new Map<string, { base: SessionCronMetadata; value: SessionCronMetadata }>();
  private cronListeners = new Set<() => void>();
  private cronEpoch: string | null = null;
  private cronEpochIntakeOpen = false;
  private cronRequestGeneration = 0;
  private retiredCronEpochs = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getEpoch = (): number => this.epoch;

  subscribeCron = (listener: () => void): (() => void) => {
    this.cronListeners.add(listener);
    return () => this.cronListeners.delete(listener);
  };

  getCron = (sessionId: string | null | undefined): SessionCronMetadata | null => {
    const resolved = this.resolveSessionId(sessionId);
    if (!resolved) return null;
    const base = this.crons.get(resolved) ?? null;
    if (!base || base.stale || !this.cronStale.has(resolved)) return base;
    let view = this.cronViews.get(resolved);
    if (!view || view.base !== base) {
      view = { base, value: { ...base, stale: true } };
      this.cronViews.set(resolved, view);
    }
    return view.value;
  };

  getCronSessionIds = (): string[] => [...this.crons.keys()];
  getCronRequestGeneration = (): number => this.cronRequestGeneration;

  applyCron(input: unknown, source: SessionStatusSource = 'ws'): SessionCronApplyResult {
    const metadata = normalizeCronMetadata(input);
    if (!metadata) {
      log.warn('session-cron', 'rejected invalid cron metadata', {
        sessionId: isRecord(input) && typeof input.sessionId === 'string' ? input.sessionId : null,
        revision: isRecord(input) ? input.revision : null,
        source,
      });
      return 'rejected-invalid';
    }
    if (this.retiredCronEpochs.has(metadata.epoch)) {
      log.warn('session-cron', 'rejected retired epoch', {
        sessionId: metadata.sessionId,
        epoch: metadata.epoch,
        revision: metadata.revision,
        source,
      });
      return 'rejected-retired-epoch';
    }
    // Gate the id before epoch adoption: adoption retires the previous epoch and
    // marks every held session stale, so a message that ends up rejected must
    // not get to do that on its way out.
    const canonicalId = this.resolveSessionId(metadata.sessionId) ?? metadata.sessionId;
    if (canonicalId !== metadata.sessionId) return 'rejected-stale';
    if (this.cronEpoch === null) {
      this.cronEpoch = metadata.epoch;
      this.cronEpochIntakeOpen = false;
    } else if (metadata.epoch !== this.cronEpoch) {
      if (!this.cronEpochIntakeOpen) {
        log.warn('session-cron', 'rejected unauthorized epoch change', {
          sessionId: metadata.sessionId,
          epoch: metadata.epoch,
          currentEpoch: this.cronEpoch,
          revision: metadata.revision,
          source,
        });
        return 'rejected-unauthorized-epoch';
      }
      this.adoptCronEpoch(metadata.epoch, source);
    }

    const normalized = metadata;
    const current = this.crons.get(canonicalId);
    if (current && current.epoch === normalized.epoch) {
      if (normalized.revision < current.revision) {
        log.warn('session-cron', 'rejected stale cron revision', {
          sessionId: canonicalId,
          epoch: normalized.epoch,
          revision: normalized.revision,
          currentRevision: current.revision,
          source,
        });
        return 'rejected-stale';
      }
      if (normalized.revision === current.revision) {
        if (this.clearCronStale(canonicalId)) this.emitCron();
        return 'duplicate';
      }
    }

    this.crons.set(canonicalId, normalized);
    this.cronViews.delete(canonicalId);
    this.cronStale.delete(canonicalId);
    log.info('session-cron', 'metadata accepted', {
      sessionId: canonicalId,
      epoch: normalized.epoch,
      revision: normalized.revision,
      presence: normalized.presence,
      known: normalized.known,
      stale: normalized.stale,
      source,
    });
    this.emitCron();
    return 'accepted';
  }

  markCronStale(sessionId?: string | null): void {
    if (sessionId !== undefined) {
      const canonical = this.resolveSessionId(sessionId);
      if (!canonical) return;
      if (!this.addCronStale(canonical)) return;
      this.emitCron();
      return;
    }
    let changed = false;
    for (const id of this.crons.keys()) {
      if (this.addCronStale(id)) changed = true;
    }
    if (changed) this.emitCron();
  }

  resetCronEpochIntake(): void {
    this.cronEpochIntakeOpen = true;
    this.cronRequestGeneration++;
  }

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
    if (!resolved) return null;
    const base = this.statuses.get(resolved) ?? null;
    const pendingMode = this.settings.get(resolved)?.patch.mode;
    if (!base || pendingMode === undefined || base.mode === pendingMode) return base;
    // Memoized on (base identity, pending mode) so the snapshot stays stable
    // until one of them actually changes.
    let merged = this.mergedStatuses.get(resolved);
    if (!merged || merged.base !== base || merged.mode !== pendingMode) {
      merged = { base, mode: pendingMode, value: { ...base, mode: pendingMode } };
      this.mergedStatuses.set(resolved, merged);
    }
    return merged.value;
  };

  getSettings = (sessionId: string | null | undefined): SessionSettingsPatch | null => {
    const resolved = this.resolveSessionId(sessionId);
    return resolved ? this.settings.get(resolved)?.patch ?? null : null;
  };

  /**
   * Show `patch` on every surface NOW. Callers fire this BEFORE the REST write
   * and call clearSessionSettings on failure, so the two surfaces revert
   * together instead of drifting apart.
   */
  applySessionSettings(sessionId: string, patch: SessionSettingsPatch): void {
    const canonical = this.resolveSessionId(sessionId);
    if (!canonical) return;
    const current = this.settings.get(canonical);
    const next = { ...(current?.patch ?? {}) } as UnknownRecord;
    const incoming = patch as UnknownRecord;
    let changed = false;
    for (const key of SESSION_SETTINGS_KEYS) {
      if (!(key in incoming)) continue;
      if (key in next && next[key] === incoming[key]) continue;
      next[key] = incoming[key];
      changed = true;
    }
    const modeBaseRevision = 'mode' in incoming
      ? this.statuses.get(canonical)?.statusRevision ?? null
      : current?.modeBaseRevision ?? null;
    if (!changed && modeBaseRevision === (current?.modeBaseRevision ?? null)) return;
    this.settings.set(canonical, {
      patch: next as SessionSettingsPatch,
      modeBaseRevision,
    });
    this.epoch++;
    this.emit();
  }

  /** The REST write failed: drop these keys so every surface falls back to the
   *  server's value in the same frame. */
  clearSessionSettings(sessionId: string, keys: readonly SessionSettingsKey[]): void {
    const canonical = this.resolveSessionId(sessionId);
    if (!canonical) return;
    if (!this.dropSettingsKeys(canonical, keys)) return;
    this.epoch++;
    this.emit();
  }

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

    // Retire BEFORE the accept's emit, so no listener ever sees the new
    // snapshot next to a pending mode the server has already answered.
    this.retireModeOverlay(canonicalId, normalized.statusRevision);
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

    // The record is the authority for the settings the status snapshot does not
    // carry (model / effort / output_mode / acpModel) — retire the pins it
    // confirms. Runs whether or not the status half is versioned.
    const canonical = this.resolveSessionId(providerId);
    const settingsChanged = canonical
      ? this.reconcileSettingsFromRecord(canonical, record)
      : false;

    const nestedStatus = isRecord(record.status) ? record.status : null;
    const versioned = nestedStatus
      ? normalizeVersionedStatus(nestedStatus, providerId)
      : normalizeVersionedSessionRecord(record, providerId);
    const applied = versioned
      ? this.applyVersioned(versioned, source)
      : isProcessStatus(record.process_status)
        ? this.applyLegacy(providerId, legacyPatchFromRecord(record), source)
        : null;
    // Only the accepted path emits on its own.
    if (settingsChanged && applied !== 'accepted') {
      this.epoch++;
      this.emit();
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
        const patch = legacyPatchFromRecord(candidate);
        this.applyLegacy(providerId, {
          ...patch,
          // A full snapshot's omission clears Waiting; a partial event's omission must not.
          pendingPermissionTool: patch.pendingPermissionTool ?? null,
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
    this.settings.clear();
    this.mergedStatuses.clear();
    this.crons.clear();
    this.cronStale.clear();
    this.cronViews.clear();
    this.retiredCronEpochs.clear();
    this.cronEpoch = null;
    this.cronEpochIntakeOpen = false;
    this.cronRequestGeneration++;
    this.epoch++;
    this.emit();
    this.emitCron();
  }

  private adoptCronEpoch(epoch: string, source: SessionStatusSource): void {
    const previous = this.cronEpoch;
    if (previous !== null) {
      this.retiredCronEpochs.add(previous);
      while (this.retiredCronEpochs.size > MAX_RETIRED_CRON_EPOCHS) {
        const oldest: string | undefined = this.retiredCronEpochs.values().next().value;
        if (oldest === undefined) break;
        this.retiredCronEpochs.delete(oldest);
      }
    }
    this.cronEpoch = epoch;
    this.cronEpochIntakeOpen = false;
    for (const id of this.crons.keys()) this.addCronStale(id);
    log.info('session-cron', 'epoch adopted', {
      epoch,
      previousEpoch: previous,
      sessions: this.crons.size,
      source,
    });
  }

  private addCronStale(canonical: string): boolean {
    const base = this.crons.get(canonical);
    if (!base || base.stale || this.cronStale.has(canonical)) return false;
    this.cronStale.add(canonical);
    this.cronViews.delete(canonical);
    return true;
  }

  private clearCronStale(canonical: string): boolean {
    if (!this.cronStale.delete(canonical)) return false;
    this.cronViews.delete(canonical);
    return true;
  }

  /** Silent (no emit) settings-key removal — callers own the notification. */
  private dropSettingsKeys(canonical: string, keys: readonly SessionSettingsKey[]): boolean {
    const current = this.settings.get(canonical);
    if (!current) return false;
    const next = { ...current.patch } as UnknownRecord;
    let changed = false;
    for (const key of keys) {
      if (!(key in next)) continue;
      delete next[key];
      changed = true;
    }
    if (!changed) return false;
    // Nothing reads the merge memo once the pending mode is gone (getStatus
    // returns the base snapshot directly) — don't leave it behind.
    if (!('mode' in next)) this.mergedStatuses.delete(canonical);
    if (Object.keys(next).length === 0) this.settings.delete(canonical);
    else {
      this.settings.set(canonical, {
        patch: next as SessionSettingsPatch,
        modeBaseRevision: 'mode' in next ? current.modeBaseRevision : null,
      });
    }
    return true;
  }

  /** An accepted snapshot NEWER than the pending mark is the server's own
   *  answer about `mode` — right or wrong, it retires the pending value. Silent:
   *  the accept that triggered it emits. */
  private retireModeOverlay(canonical: string, revision: number | null): void {
    if (revision == null) return; // legacy re-seed is not an answer
    const current = this.settings.get(canonical);
    if (!current || !('mode' in current.patch)) return;
    if (current.modeBaseRevision != null && revision <= current.modeBaseRevision) return;
    this.dropSettingsKeys(canonical, ['mode']);
  }

  /** A fetched record CONFIRMS a pinned value, so the overlay has nothing left
   *  to add. Without this an out-of-band change (another tab, the CLI's own
   *  /model) would stay invisible behind a pin that already came true. A STALE
   *  record cannot clobber a pending write: only an equal value retires. */
  private reconcileSettingsFromRecord(canonical: string, record: UnknownRecord): boolean {
    const current = this.settings.get(canonical);
    if (!current) return false;
    const held = current.patch as UnknownRecord;
    const confirmed: SessionSettingsKey[] = [];
    for (const key of SESSION_SETTINGS_KEYS) {
      if (!(key in held)) continue;
      if (!(key in record)) continue;
      if (record[key] === held[key]) confirmed.push(key);
    }
    return confirmed.length > 0 && this.dropSettingsKeys(canonical, confirmed);
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
    this.mergedStatuses.delete(previousCanonical);
    if (promoted) this.statuses.set(nextCanonical, promoted);
    // A pending pill write made against the pre-promotion id belongs to the same
    // session — carry it, or the pill snaps back when the id is adopted.
    const previousSettings = this.settings.get(previousCanonical);
    if (previousSettings && !this.settings.has(nextCanonical)) {
      this.settings.set(nextCanonical, previousSettings);
    }
    this.settings.delete(previousCanonical);
    const cronChanged = this.moveCronToAliasTarget(previousCanonical, nextCanonical);
    this.epoch++;
    log.info('session-status', 'provider session alias promoted', {
      sessionId: nextCanonical,
      previousSessionId,
      revision: promoted?.statusRevision ?? null,
      source,
    });
    this.emit();
    if (cronChanged) this.emitCron();
  }

  private moveCronToAliasTarget(previousCanonical: string, nextCanonical: string): boolean {
    const previousCron = this.crons.get(previousCanonical);
    const removed = this.crons.delete(previousCanonical);
    this.cronViews.delete(previousCanonical);
    this.cronStale.delete(previousCanonical);
    if (!previousCron) return removed;
    if (this.crons.has(nextCanonical)) return true;
    this.crons.set(nextCanonical, {
      ...previousCron,
      sessionId: nextCanonical,
      presence: 'unknown',
      stale: true,
    });
    this.cronViews.delete(nextCanonical);
    this.cronStale.delete(nextCanonical);
    return true;
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

  private emitCron(): void {
    for (const listener of this.cronListeners) listener();
  }
}

export const sessionStatusStore = new SessionStatusStore();

export function seedSessionStatus(record: SessionRecord | unknown, source?: SessionStatusSource): void {
  sessionStatusStore.seedSessionRecord(record, source);
}

export function seedTaskSessionStatuses(task: Task | unknown, source?: SessionStatusSource): void {
  sessionStatusStore.seedTaskRecord(task, source);
}

/** Show a settings write on every surface at once (see SessionSettingsPatch).
 *  Pair every call with clearSessionSettings on the REST failure path. */
export function applySessionSettings(sessionId: string, patch: SessionSettingsPatch): void {
  sessionStatusStore.applySessionSettings(sessionId, patch);
}

/** Revert an optimistic settings write — the surfaces fall back together. */
export function clearSessionSettings(
  sessionId: string,
  keys: readonly SessionSettingsKey[],
): void {
  sessionStatusStore.clearSessionSettings(sessionId, keys);
}

export function resolveSessionRecordStatus<T extends SessionRecord>(record: T): T {
  const status = sessionStatusStore.getStatus(record.claudeSessionId);
  // `mode` is already merged into the status snapshot by getStatus; the rest of
  // the settings overlay has no snapshot to ride and lands here.
  const settings = sessionStatusStore.getSettings(record.claudeSessionId);
  if (!status && !settings) return record;
  const resolved = status
    ? {
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
    }
    : { ...record };
  return settings ? Object.assign(resolved, settings) : resolved;
}
