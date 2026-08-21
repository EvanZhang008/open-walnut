import { describe, expect, it, vi } from 'vitest';
import {
  SessionStatusStore,
  type SessionStatusSnapshot,
} from '../../web/src/stores/session-status-store';

function status(
  revision: number,
  overrides: Partial<SessionStatusSnapshot> = {},
): SessionStatusSnapshot {
  return {
    sessionId: 'provider-session-1',
    taskId: 'task-1',
    process_status: 'idle',
    activity: null,
    mode: 'bypass',
    planCompleted: false,
    archived: false,
    errorMessage: null,
    provider: 'cli',
    engine: 'codex',
    // Canonicalized by every normalize path (2026-08-14): absent on old servers
    // → null, so a versioned snapshot always carries the key. Drives the red
    // Waiting display on list surfaces.
    pendingPermissionTool: null,
    statusRevision: revision,
    statusUpdatedAt: `2026-07-19T12:00:0${revision}.000Z`,
    ...overrides,
  };
}

describe('SessionStatusStore', () => {
  it('keeps WS N+1 when delayed REST N arrives', () => {
    const store = new SessionStatusStore();
    expect(store.applyVersioned(status(11, {
      process_status: 'running',
      activity: 'Long tool',
    }), 'ws')).toBe('accepted');

    expect(store.applyVersioned(status(10), 'rest:session')).toBe('rejected-stale');
    expect(store.getStatus('provider-session-1')).toMatchObject({
      process_status: 'running',
      activity: 'Long tool',
      statusRevision: 11,
    });
  });

  it('deduplicates equal revisions and rejects equal-revision conflicts', () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const current = status(4);

    expect(store.applyVersioned(current, 'ws')).toBe('accepted');
    expect(store.applyVersioned({ ...current }, 'rest:session')).toBe('duplicate');
    expect(store.applyVersioned({
      ...current,
      process_status: 'running',
    }, 'rest:session')).toBe('rejected-conflict');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getStatus(current.sessionId)?.process_status).toBe('idle');
  });

  it('uses full snapshots so explicit null and false values clear prior state', () => {
    const store = new SessionStatusStore();
    store.applyVersioned(status(1, {
      activity: 'Running tests',
      mode: 'plan',
      planCompleted: true,
      archived: true,
      errorMessage: 'old error',
      provider: 'embedded',
      engine: 'claude',
    }), 'ws');

    store.applyVersioned(status(2, {
      activity: null,
      mode: 'default',
      planCompleted: false,
      archived: false,
      errorMessage: null,
      provider: 'cli',
      engine: 'claude',
    }), 'ws');

    expect(store.getStatus('provider-session-1')).toEqual(status(2, {
      activity: null,
      mode: 'default',
      planCompleted: false,
      archived: false,
      errorMessage: null,
      provider: 'cli',
      engine: 'claude',
    }));
  });

  it('rejects revision zero and nullable default fields', () => {
    const store = new SessionStatusStore();
    expect(store.applyVersioned(status(0), 'ws')).toBe('rejected-invalid');
    expect(store.applyVersioned({
      ...status(1),
      mode: null,
    }, 'ws')).toBe('rejected-invalid');
    expect(store.applyVersioned({
      ...status(1),
      provider: null,
    }, 'ws')).toBe('rejected-invalid');
    expect(store.applyVersioned({
      ...status(1),
      engine: null,
    }, 'ws')).toBe('rejected-invalid');
    expect(store.getStatus('provider-session-1')).toBeNull();
  });

  it('rejects incomplete versioned snapshots instead of treating omissions as clears', () => {
    const store = new SessionStatusStore();
    const { activity: _activity, ...incomplete } = status(1);

    expect(store.applyVersioned(incomplete, 'ws')).toBe('rejected-invalid');
    expect(store.getStatus('provider-session-1')).toBeNull();
  });

  it('canonicalizes optional fields when seeding a versioned REST session record', () => {
    const store = new SessionStatusStore();
    store.seedSessionRecord({
      claudeSessionId: 'provider-session-1',
      taskId: 'task-1',
      process_status: 'idle',
      statusRevision: 3,
      statusUpdatedAt: '2026-07-19T12:00:03.000Z',
    });

    expect(store.getStatus('provider-session-1')).toEqual(status(3, {
      mode: 'default',
      provider: 'cli',
      engine: 'claude',
    }));
  });

  it('deduplicates taskless REST records and canonical snapshots', () => {
    const store = new SessionStatusStore();
    store.seedSessionRecord({
      claudeSessionId: 'provider-session-1',
      process_status: 'idle',
      statusRevision: 3,
      statusUpdatedAt: '2026-07-19T12:00:03.000Z',
    });

    expect(store.applyVersioned(status(3, {
      taskId: null,
      mode: 'default',
      provider: 'cli',
      engine: 'claude',
    }), 'rest:session')).toBe('duplicate');
  });

  it('supports legacy partial updates until a versioned snapshot is accepted', () => {
    const store = new SessionStatusStore();
    expect(store.applyLegacy('provider-session-1', {
      taskId: 'task-1',
      process_status: 'running',
      activity: 'Legacy tool',
      errorMessage: 'legacy error',
    }, 'ws')).toBe('accepted');
    expect(store.applyLegacy('provider-session-1', {
      activity: null,
      errorMessage: null,
    }, 'rest:session')).toBe('accepted');
    expect(store.getStatus('provider-session-1')).toMatchObject({
      process_status: 'running',
      activity: null,
      errorMessage: null,
      statusRevision: null,
    });

    expect(store.applyVersioned(status(1), 'ws')).toBe('accepted');
    expect(store.applyLegacy('provider-session-1', {
      process_status: 'stopped',
    }, 'rest:session')).toBe('rejected-legacy');
    expect(store.getStatus('provider-session-1')?.process_status).toBe('idle');
  });

  it('promotes previous provider IDs without losing a newer status', () => {
    const store = new SessionStatusStore();
    store.applyVersioned(status(8, {
      sessionId: 'provider-session-old',
      process_status: 'running',
    }), 'ws');

    expect(store.applyVersioned(status(9, {
      sessionId: 'provider-session-new',
      process_status: 'idle',
    }), 'ws', 'provider-session-old')).toBe('accepted');
    expect(store.resolveSessionId('provider-session-old')).toBe('provider-session-new');
    expect(store.getStatus('provider-session-old')).toEqual(
      store.getStatus('provider-session-new'),
    );
    expect(store.getStatus('provider-session-new')).toMatchObject({
      sessionId: 'provider-session-new',
      statusRevision: 9,
    });
  });

  it('replaces a hydrated archived redirect with the newer provider identity', () => {
    const store = new SessionStatusStore();
    store.applyVersioned(status(8, {
      sessionId: 'provider-session-old',
      archived: true,
    }), 'rest:session');

    expect(store.applyVersioned(status(9, {
      sessionId: 'provider-session-new',
      archived: false,
    }), 'ws', 'provider-session-old')).toBe('accepted');
    expect(store.getStatus('provider-session-old')).toMatchObject({
      sessionId: 'provider-session-new',
      archived: false,
      statusRevision: 9,
    });
  });

  it('rejects a stale alias event without mutating the accepted alias graph', () => {
    const store = new SessionStatusStore();
    expect(store.applyVersioned(status(5, {
      sessionId: 'provider-session-new',
      process_status: 'running',
    }), 'ws', 'provider-session-old')).toBe('accepted');

    expect(store.applyVersioned(status(4, {
      sessionId: 'provider-session-other',
      process_status: 'idle',
    }), 'ws', 'provider-session-old')).toBe('rejected-stale');
    expect(store.resolveSessionId('provider-session-old')).toBe('provider-session-new');
    expect(store.getStatus('provider-session-old')).toMatchObject({
      sessionId: 'provider-session-new',
      process_status: 'running',
      statusRevision: 5,
    });
    expect(store.getStatus('provider-session-other')).toBeNull();
  });

  it('rejects a stale migration against its target before creating an alias', () => {
    const store = new SessionStatusStore();
    expect(store.applyVersioned(status(8, {
      sessionId: 'provider-session-new',
      process_status: 'running',
    }), 'ws')).toBe('accepted');

    expect(store.applyVersioned(status(7, {
      sessionId: 'provider-session-new',
      process_status: 'idle',
    }), 'ws', 'provider-session-old')).toBe('rejected-stale');
    expect(store.resolveSessionId('provider-session-old')).toBe('provider-session-old');
    expect(store.getStatus('provider-session-old')).toBeNull();
    expect(store.getStatus('provider-session-new')).toMatchObject({
      process_status: 'running',
      statusRevision: 8,
    });
  });

  it('deduplicates a replayed migration after its alias is accepted', () => {
    const store = new SessionStatusStore();
    const migrated = status(5, {
      sessionId: 'provider-session-new',
      process_status: 'running',
    });

    expect(store.applyVersioned(migrated, 'ws', 'provider-session-old')).toBe('accepted');
    expect(store.applyVersioned(migrated, 'ws', 'provider-session-old')).toBe('duplicate');
    expect(store.resolveSessionId('provider-session-old')).toBe('provider-session-new');
    expect(store.getStatus('provider-session-old')).toEqual(migrated);
  });

  it('ingests the nested event contract and promotes its previous provider ID', () => {
    const store = new SessionStatusStore();
    store.applyVersioned(status(3, {
      sessionId: 'provider-session-old',
      process_status: 'running',
    }), 'ws');

    expect(store.ingestStatusEvent({
      sessionId: 'legacy-top-level-id',
      process_status: 'stopped',
      previousSessionId: 'provider-session-old',
      status: status(4, {
        sessionId: 'provider-session-new',
        process_status: 'idle',
      }),
    })).toBe('accepted');
    expect(store.resolveSessionId('provider-session-old')).toBe('provider-session-new');
    expect(store.getStatus('provider-session-new')).toMatchObject({
      process_status: 'idle',
      statusRevision: 4,
    });
    expect(store.getStatus('legacy-top-level-id')).toBeNull();
  });

  it('rejects a malformed canonical nested snapshot instead of trusting mirrors', () => {
    const store = new SessionStatusStore();
    expect(store.ingestStatusEvent({
      ...status(2),
      status: { ...status(2), activity: undefined },
    })).toBe('rejected-invalid');
    expect(store.getStatus('provider-session-1')).toBeNull();
  });

  it('does not admit pending UI or ACP runtime identities', () => {
    const store = new SessionStatusStore();
    expect(store.applyVersioned(status(1, {
      sessionId: 'pending:task-1',
    }), 'ws')).toBe('rejected-invalid');
    expect(store.applyVersioned(status(1, {
      sessionId: 'acp-0123456789abcdef',
    }), 'ws')).toBe('rejected-invalid');
    expect(store.getStatus('pending:task-1')).toBeNull();
    expect(store.getStatus('acp-0123456789abcdef')).toBeNull();
  });
});
