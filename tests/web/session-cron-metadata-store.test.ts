import { describe, expect, it, vi } from 'vitest';
import type { SessionCronMetadata } from '../../src/core/types';
import {
  SessionStatusStore,
  type SessionStatusSnapshot,
} from '../../web/src/stores/session-status-store';

const SID = 'provider-session-cron-1';
const OTHER_SID = 'provider-session-cron-2';
const NEW_SID = 'provider-session-cron-renamed';
const EPOCH_A = 'server-epoch-a';
const EPOCH_B = 'server-epoch-b';
const EPOCH_C = 'server-epoch-c';

function cron(
  revision: number,
  overrides: Partial<SessionCronMetadata> = {},
): SessionCronMetadata {
  return {
    sessionId: SID,
    epoch: EPOCH_A,
    revision,
    presence: 'active',
    source: 'cron',
    known: true,
    stale: false,
    observedAt: 1_757_000_000_000 + revision,
    validUntil: null,
    ...overrides,
  };
}

function status(
  revision: number,
  overrides: Partial<SessionStatusSnapshot> = {},
): SessionStatusSnapshot {
  return {
    sessionId: SID,
    taskId: 'task-cron-1',
    process_status: 'running',
    activity: null,
    mode: 'default',
    planCompleted: false,
    archived: false,
    errorMessage: null,
    provider: 'cli',
    engine: 'claude',
    pendingPermissionTool: null,
    statusRevision: revision,
    statusUpdatedAt: `2026-09-11T12:00:0${revision}.000Z`,
    ...overrides,
  };
}

describe('SessionStatusStore cron metadata', () => {
  it('serves one stable value to two readers and notifies both', () => {
    const store = new SessionStatusStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribeCron(first);
    store.subscribeCron(second);

    expect(store.applyCron(cron(1))).toBe('accepted');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    const readerA = store.getCron(SID);
    const readerB = store.getCron(SID);
    expect(readerA).toMatchObject({
      sessionId: SID,
      epoch: EPOCH_A,
      revision: 1,
      presence: 'active',
      source: 'cron',
      known: true,
      stale: false,
      validUntil: null,
    });
    expect(readerB).toBe(readerA);

    expect(store.applyCron(cron(1), 'rest:session-list')).toBe('duplicate');
    expect(store.getCron(SID)).toBe(readerA);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps well-formed job details and keeps presence when only the details are malformed', () => {
    const store = new SessionStatusStore();
    const job = {
      id: '41935620', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM', prompt: 'Daily disk inspection', promptTruncated: false,
      recurring: true, durable: false, createdAt: 1000, nextRunAt: 5000, expiresAt: 9000,
    };
    expect(store.applyCron(cron(1, { jobs: [job] }))).toBe('accepted');
    expect(store.getCron(SID)?.jobs).toEqual([job]);
    expect(store.applyCron(cron(2))).toBe('accepted');
    expect(store.getCron(SID)?.jobs).toBeUndefined();
    expect(store.applyCron(cron(3, { jobs: [{ ...job, recurring: 'yes' }] as never }))).toBe('accepted');
    expect(store.getCron(SID)).toMatchObject({ revision: 3, presence: 'active' });
    expect(store.getCron(SID)?.jobs).toBeUndefined();
  });

  it('carries every presence and a null source through unchanged', () => {
    const store = new SessionStatusStore();

    expect(store.applyCron(cron(1, { presence: 'active', source: 'wakeup' }))).toBe('accepted');
    expect(store.getCron(SID)).toMatchObject({ presence: 'active', source: 'wakeup' });

    expect(store.applyCron(cron(2, { presence: 'inactive', known: true }))).toBe('accepted');
    expect(store.getCron(SID)).toMatchObject({ presence: 'inactive', revision: 2 });

    expect(store.applyCron(cron(3, {
      presence: 'unknown',
      source: null,
      known: false,
      validUntil: 1_757_000_100_000,
    }))).toBe('accepted');
    expect(store.getCron(SID)).toMatchObject({
      presence: 'unknown',
      source: null,
      known: false,
      validUntil: 1_757_000_100_000,
    });
  });

  it('rejects an older revision and dedupes a repeated one inside the same epoch', () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribeCron(listener);

    expect(store.applyCron(cron(5, { presence: 'active' }))).toBe('accepted');
    expect(store.applyCron(cron(4, { presence: 'inactive' }), 'rest:session')).toBe('rejected-stale');
    expect(store.applyCron(cron(5, { presence: 'inactive' }), 'rest:session')).toBe('duplicate');
    expect(store.getCron(SID)).toMatchObject({ revision: 5, presence: 'active' });
    expect(listener).toHaveBeenCalledTimes(1);

    expect(store.applyCron(cron(6, { presence: 'inactive' }))).toBe('accepted');
    expect(store.getCron(SID)).toMatchObject({ revision: 6, presence: 'inactive' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('adopts a restarted server epoch only when intake was reset, then retires the old one', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(9))).toBe('accepted');

    expect(store.applyCron(cron(1, { epoch: EPOCH_B, presence: 'inactive' })))
      .toBe('rejected-unauthorized-epoch');
    expect(store.getCron(SID)).toMatchObject({ epoch: EPOCH_A, revision: 9, presence: 'active' });

    store.resetCronEpochIntake();
    expect(store.applyCron(cron(1, { epoch: EPOCH_B, presence: 'inactive' }))).toBe('accepted');
    expect(store.getCron(SID)).toMatchObject({ epoch: EPOCH_B, revision: 1, presence: 'inactive' });

    expect(store.applyCron(cron(10, { presence: 'active' }), 'rest:session'))
      .toBe('rejected-retired-epoch');
    expect(store.getCron(SID)).toMatchObject({ epoch: EPOCH_B, revision: 1, presence: 'inactive' });

    expect(store.applyCron(cron(1, { epoch: EPOCH_C }))).toBe('rejected-unauthorized-epoch');
    expect(store.getCron(SID)).toMatchObject({ epoch: EPOCH_B });
  });

  it('marks sessions the new epoch did not mention as stale, without rewriting them', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(1))).toBe('accepted');
    expect(store.applyCron(cron(2, { sessionId: OTHER_SID }))).toBe('accepted');

    store.resetCronEpochIntake();
    expect(store.applyCron(cron(1, { epoch: EPOCH_B }))).toBe('accepted');

    expect(store.getCron(SID)).toMatchObject({ epoch: EPOCH_B, stale: false });
    expect(store.getCron(OTHER_SID)).toMatchObject({
      epoch: EPOCH_A,
      revision: 2,
      presence: 'active',
      stale: true,
    });
  });

  it('marks every known session stale when the websocket drops, and clears it on re-delivery', () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribeCron(listener);
    expect(store.applyCron(cron(7))).toBe('accepted');
    expect(store.applyCron(cron(8, { sessionId: OTHER_SID }))).toBe('accepted');

    store.markCronStale();
    expect(listener).toHaveBeenCalledTimes(3);
    const offline = store.getCron(SID);
    expect(offline).toMatchObject({ revision: 7, presence: 'active', source: 'cron', stale: true });
    expect(store.getCron(SID)).toBe(offline);
    expect(store.getCron(OTHER_SID)).toMatchObject({ revision: 8, stale: true });

    store.markCronStale();
    expect(listener).toHaveBeenCalledTimes(3);

    expect(store.applyCron(cron(7), 'rest:session-list')).toBe('duplicate');
    expect(store.getCron(SID)).toMatchObject({ revision: 7, stale: false });
    expect(store.getCron(OTHER_SID)).toMatchObject({ stale: true });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('reports a server-sent stale observation without a client overlay', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(1, { stale: true }))).toBe('accepted');
    const base = store.getCron(SID);
    expect(base).toMatchObject({ stale: true });
    store.markCronStale();
    expect(store.getCron(SID)).toBe(base);
  });

  it('leaves plain status alone and survives status traffic', () => {
    const store = new SessionStatusStore();
    const statusListener = vi.fn();
    store.subscribeCron(vi.fn());
    expect(store.applyVersioned(status(1), 'ws')).toBe('accepted');
    store.subscribe(statusListener);
    const beforeStatus = store.getStatus(SID);
    const beforeEpoch = store.getEpoch();

    expect(store.applyCron(cron(1))).toBe('accepted');
    store.markCronStale();

    expect(store.getStatus(SID)).toBe(beforeStatus);
    expect(store.getStatus(SID)).toMatchObject({ process_status: 'running', statusRevision: 1 });
    expect(store.getEpoch()).toBe(beforeEpoch);
    expect(statusListener).not.toHaveBeenCalled();

    expect(store.applyVersioned(status(2, { process_status: 'idle' }), 'ws')).toBe('accepted');
    expect(store.getStatus(SID)).toMatchObject({ process_status: 'idle', statusRevision: 2 });
    expect(store.getCron(SID)).toMatchObject({ revision: 1, presence: 'active' });
  });

  it('rejects incomplete or malformed input and stores nothing', () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribeCron(listener);
    const invalid: unknown[] = [
      null,
      'cron',
      {},
      cron(1, { sessionId: '' as unknown as string }),
      cron(1, { sessionId: 'draft:column-1' }),
      cron(1, { epoch: '' }),
      cron(1, { epoch: 42 as unknown as string }),
      cron(0),
      cron(1.5),
      cron(1, { revision: '2' as unknown as number }),
      cron(1, { presence: 'armed' as unknown as SessionCronMetadata['presence'] }),
      cron(1, { source: 'timer' as unknown as SessionCronMetadata['source'] }),
      cron(1, { known: 'yes' as unknown as boolean }),
      cron(1, { stale: null as unknown as boolean }),
      cron(1, { observedAt: Number.NaN }),
      cron(1, { observedAt: '1757' as unknown as number }),
      cron(1, { validUntil: 'soon' as unknown as number }),
      { ...cron(1), presence: undefined },
    ];

    for (const input of invalid) {
      expect(store.applyCron(input)).toBe('rejected-invalid');
    }
    expect(store.getCron(SID)).toBeNull();
    expect(store.getCronSessionIds()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not copy a confirmed observation onto a renamed session id', () => {
    const store = new SessionStatusStore();
    expect(store.applyVersioned(status(1), 'ws')).toBe('accepted');
    expect(store.applyCron(cron(4))).toBe('accepted');

    expect(store.applyVersioned(status(2, { sessionId: NEW_SID }), 'ws', SID)).toBe('accepted');

    const promoted = store.getCron(NEW_SID);
    expect(promoted).toMatchObject({
      sessionId: NEW_SID,
      presence: 'unknown',
      stale: true,
      source: 'cron',
      revision: 4,
    });
    expect(store.getCron(SID)).toBe(promoted);
    expect(store.getCronSessionIds()).toEqual([NEW_SID]);

    expect(store.applyCron(cron(99), 'rest:session')).toBe('rejected-stale');
    expect(store.getCron(NEW_SID)?.presence).toBe('unknown');
    expect(store.applyCron(cron(5, { sessionId: NEW_SID }))).toBe('accepted');
    expect(store.getCron(NEW_SID)).toMatchObject({ presence: 'active', stale: false, revision: 5 });
  });

  it('invalidates in-flight HTTP reads when the websocket disconnects', () => {
    const store = new SessionStatusStore();
    const before = store.getCronRequestGeneration();
    store.markCronStale();
    store.resetCronEpochIntake();
    expect(store.getCronRequestGeneration()).toBeGreaterThan(before);
  });

  it('clears cron state for tests', () => {
    const store = new SessionStatusStore();
    expect(store.applyCron(cron(3))).toBe('accepted');
    store.markCronStale();

    store.clearForTesting();

    expect(store.getCron(SID)).toBeNull();
    expect(store.getCronSessionIds()).toEqual([]);
    expect(store.applyCron(cron(1, { epoch: EPOCH_C }))).toBe('accepted');
    expect(store.getCron(SID)).toMatchObject({ epoch: EPOCH_C, revision: 1, stale: false });
  });
});
