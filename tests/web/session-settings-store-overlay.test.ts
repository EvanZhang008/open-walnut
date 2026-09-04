/**
 * One browser, one session-settings truth — the store half.
 *
 * Regression guarded: the session composer's mode pill wrote
 * `setSession({ ...session, mode })` into its OWN state, which was dead code
 * (resolveSessionRecordStatus overwrites `mode` from this store on every read),
 * so the pill sat still until the PATCH round-trip — which also reaches the live
 * CLI — came back. Meanwhile the chat lane composer flipped instantly from its
 * private copy and the task detail rows never learned at all.
 *
 * The overlay's LIFETIME rules are what make it safe, and they are what this
 * file pins:
 *  - a newer ACCEPTED snapshot is the server's own answer and retires `mode`;
 *  - an equal or older snapshot must NOT clobber a pending pick;
 *  - a failed write reverts to the stored value on every surface at once;
 *  - settings no snapshot carries (model / effort / output_mode / ACP model)
 *    retire when a fetched record CONFIRMS them, and a stale record cannot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySessionSettings,
  clearSessionSettings,
  resolveSessionRecordStatus,
  sessionStatusStore,
} from '../../web/src/stores/session-status-store';

const SID = '00000000-0000-4000-8000-0000000000aa';

const snapshot = (mode: string, rev: number, extra: Record<string, unknown> = {}) => ({
  sessionId: SID,
  taskId: 'task-1',
  process_status: 'running',
  activity: null,
  mode,
  planCompleted: false,
  archived: false,
  errorMessage: null,
  provider: 'cli',
  engine: 'claude',
  statusRevision: rev,
  statusUpdatedAt: '2026-09-03T00:00:00.000Z',
  ...extra,
});

const record = (overrides: Record<string, unknown> = {}) => ({
  claudeSessionId: SID,
  taskId: 'task-1',
  project: '',
  process_status: 'running',
  mode: 'bypass',
  startedAt: 'x',
  lastActiveAt: 'x',
  messageCount: 0,
  ...overrides,
}) as never;

const resolvedMode = () => resolveSessionRecordStatus(record()).mode;

beforeEach(() => {
  sessionStatusStore.clearForTesting();
});

describe('pending mode overlay', () => {
  it('shows a pending mode on every reader before the server has answered', () => {
    sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'ws');
    expect(sessionStatusStore.getStatus(SID)?.mode).toBe('bypass');

    applySessionSettings(SID, { mode: 'plan' });

    // The status readers (session pill, detail rows) and the record resolver
    // (session panel, lane composer) must agree in the same frame.
    expect(sessionStatusStore.getStatus(SID)?.mode).toBe('plan');
    expect(resolvedMode()).toBe('plan');
  });

  it('keeps the snapshot object identity stable while nothing changes', () => {
    sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'ws');
    applySessionSettings(SID, { mode: 'plan' });
    // useSyncExternalStore re-renders forever on a fresh object per read.
    expect(sessionStatusStore.getStatus(SID)).toBe(sessionStatusStore.getStatus(SID));
  });

  it('retires on the first accepted snapshot newer than the mark', () => {
    sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'ws');
    applySessionSettings(SID, { mode: 'plan' });

    expect(sessionStatusStore.applyVersioned(snapshot('plan', 5), 'rest:session')).toBe('accepted');
    expect(sessionStatusStore.getSettings(SID)).toBeNull();
    expect(resolvedMode()).toBe('plan');
  });

  it('lets a newer snapshot that DISAGREES win — the server is the authority', () => {
    sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'ws');
    applySessionSettings(SID, { mode: 'plan' });

    // Out-of-band change (another surface, the CLI's own switch).
    sessionStatusStore.applyVersioned(snapshot('auto', 5), 'ws');
    expect(resolvedMode()).toBe('auto');
  });

  it('survives an EQUAL-revision snapshot (the pill must not snap back)', () => {
    sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'ws');
    applySessionSettings(SID, { mode: 'plan' });

    // A duplicate re-seed (task-list poll, status hydration) is not an answer.
    expect(sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'rest:task-list'))
      .toBe('duplicate');
    expect(resolvedMode()).toBe('plan');
  });

  it('survives an OLDER snapshot', () => {
    sessionStatusStore.applyVersioned(snapshot('bypass', 7), 'ws');
    applySessionSettings(SID, { mode: 'plan' });

    expect(sessionStatusStore.applyVersioned(snapshot('bypass', 6), 'rest:session-list'))
      .toBe('rejected-stale');
    expect(resolvedMode()).toBe('plan');
  });

  it('survives a legacy (unversioned) re-seed', () => {
    sessionStatusStore.applyLegacy(SID, { mode: 'bypass', process_status: 'idle' }, 'rest:task');
    applySessionSettings(SID, { mode: 'plan' });

    sessionStatusStore.applyLegacy(SID, { mode: 'bypass' }, 'rest:task-list');
    expect(resolvedMode()).toBe('plan');
  });

  it('retires a mark made before any versioned snapshot existed', () => {
    sessionStatusStore.applyLegacy(SID, { mode: 'bypass', process_status: 'idle' }, 'rest:task');
    applySessionSettings(SID, { mode: 'plan' });

    expect(sessionStatusStore.applyVersioned(snapshot('plan', 1), 'rest:session')).toBe('accepted');
    expect(sessionStatusStore.getSettings(SID)).toBeNull();
  });

  it('reverts to the stored mode when the write failed', () => {
    sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'ws');
    applySessionSettings(SID, { mode: 'plan' });

    clearSessionSettings(SID, ['mode']);
    expect(sessionStatusStore.getStatus(SID)?.mode).toBe('bypass');
    expect(resolvedMode()).toBe('bypass');
  });

  it('notifies subscribers on apply and on revert', () => {
    let notifications = 0;
    const unsubscribe = sessionStatusStore.subscribe(() => { notifications++; });
    try {
      sessionStatusStore.applyVersioned(snapshot('bypass', 4), 'ws');
      const afterSnapshot = notifications;
      applySessionSettings(SID, { mode: 'plan' });
      expect(notifications).toBe(afterSnapshot + 1);
      clearSessionSettings(SID, ['mode']);
      expect(notifications).toBe(afterSnapshot + 2);
      // A no-op write must not emit — an emit per render is a render loop.
      applySessionSettings(SID, { mode: 'bypass' });
      applySessionSettings(SID, { mode: 'bypass' });
      expect(notifications).toBe(afterSnapshot + 3);
    } finally {
      unsubscribe();
    }
  });
});

describe('settings no status snapshot carries', () => {
  it('overlays model / effort / output_mode / ACP model onto a fetched record', () => {
    applySessionSettings(SID, {
      model: 'opus-1m',
      effort: 'max',
      output_mode: 'rich',
      acpModel: 'gpt-5.6',
    });
    const resolved = resolveSessionRecordStatus(record({
      model: 'sonnet', effort: 'high', output_mode: 'markdown', acpModel: 'gpt-5.1',
    }));
    expect(resolved.model).toBe('opus-1m');
    expect(resolved.effort).toBe('max');
    expect(resolved.output_mode).toBe('rich');
    expect(resolved.acpModel).toBe('gpt-5.6');
  });

  it('treats an explicitly undefined value as "clear this field"', () => {
    // The advertised name describes the OLD model, so switching the id must drop
    // it — key PRESENCE decides, not truthiness.
    applySessionSettings(SID, { acpModel: 'gpt-5.6', acpModelName: undefined });
    const resolved = resolveSessionRecordStatus(record({
      acpModel: 'gpt-5.1', acpModelName: 'OpenAI GPT-5.1',
    }));
    expect(resolved.acpModel).toBe('gpt-5.6');
    expect(resolved.acpModelName).toBeUndefined();
  });

  it('retires a value a fetched record confirms', () => {
    applySessionSettings(SID, { model: 'opus-1m' });
    sessionStatusStore.seedSessionRecord(record({ model: 'opus-1m', statusRevision: 2, statusUpdatedAt: '2026-09-03T00:01:00.000Z' }));
    expect(sessionStatusStore.getSettings(SID)).toBeNull();
  });

  it('is NOT retired by a stale record that predates the write', () => {
    applySessionSettings(SID, { model: 'opus-1m' });
    sessionStatusStore.seedSessionRecord(record({ model: 'sonnet', statusRevision: 2, statusUpdatedAt: '2026-09-03T00:01:00.000Z' }));
    expect(sessionStatusStore.getSettings(SID)?.model).toBe('opus-1m');
    expect(resolveSessionRecordStatus(record({ model: 'sonnet' })).model).toBe('opus-1m');
  });

  it('drops only the confirmed keys', () => {
    applySessionSettings(SID, { model: 'opus-1m', effort: 'max' });
    sessionStatusStore.seedSessionRecord(record({ model: 'opus-1m', effort: 'high', statusRevision: 2, statusUpdatedAt: '2026-09-03T00:01:00.000Z' }));
    expect(sessionStatusStore.getSettings(SID)).toEqual({ effort: 'max' });
  });

  it('leaves a record untouched when the store knows nothing', () => {
    const base = record({ model: 'sonnet' });
    expect(resolveSessionRecordStatus(base)).toBe(base);
  });
});
