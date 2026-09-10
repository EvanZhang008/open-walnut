/**
 * The repair pointer on an error notification (`fix`) — store side.
 *
 * Contract under test:
 *   - attachNotificationFix records the repair on an existing record and returns
 *     a clone for the caller's `notification:updated` broadcast; an unknown
 *     dedupKey is a no-op (the card may have been dismissed mid-flight).
 *   - findNotification hands out a CLONE — a caller mutating it must not edit
 *     the store.
 *   - a fold (upsertNotification) of the same error KEEPS the fix: a re-fire is
 *     the same problem, and the session working on it is still where to go.
 *
 * WALNUT_HOME is an isolated tmpdir via createMockConstants.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-notif-fix'));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  addNotification,
  upsertNotification,
  findNotification,
  attachNotificationFix,
} from '../../../src/core/notifications/store.js';

const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');

const DEDUP_KEY = 'error:git:repo-size';

function errorInput(over: Record<string, unknown> = {}) {
  return {
    kind: 'operation-error' as const,
    severity: 'error' as const,
    title: 'Data Repo Growing Too Large',
    body: 'The data repo is 3.4 GB.',
    detail: '[git] {"sizeGb":3.4}',
    category: 'Data & Sync',
    recoveryKey: 'git',
    dedupKey: DEDUP_KEY,
    ...over,
  };
}

beforeEach(() => {
  fs.rmSync(NOTIFICATIONS_FILE, { force: true });
  fs.rmSync(NOTIFICATIONS_FILE.replace(/\.json$/, '.backup.json'), { force: true });
});

describe('attachNotificationFix', () => {
  it('records the repair and returns the updated record', async () => {
    await upsertNotification(errorInput());
    const fix = { taskId: 't-1', sessionId: 's-1', startedAt: 1_700_000_000_000 };

    const updated = await attachNotificationFix(DEDUP_KEY, fix);

    expect(updated).not.toBeNull();
    expect(updated!.fix).toEqual(fix);
    expect(updated!.dedupKey).toBe(DEDUP_KEY);
    // Persisted, not just returned.
    const raw = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
    expect(raw.notifications[0].fix).toEqual(fix);
  });

  it('returns a clone — mutating it does not edit the store', async () => {
    await upsertNotification(errorInput());
    const updated = await attachNotificationFix(DEDUP_KEY, { taskId: 't-1', startedAt: 1 });
    updated!.title = 'rewritten by the caller';
    updated!.fix!.taskId = 't-hijacked';

    const fresh = await findNotification(DEDUP_KEY);
    expect(fresh!.title).toBe('Data Repo Growing Too Large');
    expect(fresh!.fix!.taskId).toBe('t-1');
  });

  it('is a no-op for an unknown dedupKey', async () => {
    await upsertNotification(errorInput());
    expect(await attachNotificationFix('error:nope', { taskId: 't-2', startedAt: 1 })).toBeNull();
    expect((await findNotification(DEDUP_KEY))!.fix).toBeUndefined();
  });

  it('replaces an earlier repair (the restart path)', async () => {
    await upsertNotification(errorInput());
    await attachNotificationFix(DEDUP_KEY, { taskId: 't-1', sessionId: 's-1', startedAt: 1 });
    const second = await attachNotificationFix(DEDUP_KEY, { taskId: 't-2', sessionId: 's-2', startedAt: 2 });
    expect(second!.fix).toEqual({ taskId: 't-2', sessionId: 's-2', startedAt: 2 });
  });
});

describe('findNotification', () => {
  it('finds by dedupKey and hands out a clone', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'Backup', dedupKey: 'cron:backup:1' });
    const found = await findNotification('cron:backup:1');
    expect(found!.title).toBe('Backup');
    found!.title = 'mutated';
    expect((await findNotification('cron:backup:1'))!.title).toBe('Backup');
  });

  it('is null for an unknown key', async () => {
    expect(await findNotification('error:absent')).toBeNull();
  });
});

describe('a fold keeps the repair pointer', () => {
  it('survives upsertNotification: same problem, same session to go to', async () => {
    await upsertNotification(errorInput());
    await attachNotificationFix(DEDUP_KEY, { taskId: 't-1', sessionId: 's-1', startedAt: 7 });

    const { record, outcome } = await upsertNotification(errorInput({
      body: 'The data repo is 4.1 GB.',
      severity: 'warning',
    }));

    expect(outcome).toBe('refreshed');
    expect(record.count).toBe(2);
    expect(record.body).toBe('The data repo is 4.1 GB.');
    expect(record.fix).toEqual({ taskId: 't-1', sessionId: 's-1', startedAt: 7 });
    expect((await findNotification(DEDUP_KEY))!.fix!.taskId).toBe('t-1');
  });

  it('keeps the pointer through a recover → re-fire round trip', async () => {
    await upsertNotification(errorInput());
    await attachNotificationFix(DEDUP_KEY, { taskId: 't-1', startedAt: 7 });
    // A fold clears `resolved` (it is happening again) but must not clear `fix`.
    const { record } = await upsertNotification(errorInput());
    expect(record.resolved).toBeUndefined();
    expect(record.fix!.taskId).toBe('t-1');
  });
});
