/**
 * recoverNotifications({ asOf }): a recovery applied after the moment it was seen.
 *
 * The server retries a recovery whose store write failed (publishRecovery in
 * server.ts; 2026-10-08 a boot's 'web-assets' recovery lost the notifications
 * lock to the server it replaced). By the time the retry runs, the condition may
 * have failed again and re-raised its card; the retry must leave that one up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notif-recover-as-of'));

import { WALNUT_HOME } from '../../../src/constants.js';
import { upsertNotification, recoverNotifications, listNotifications } from '../../../src/core/notifications/store.js';

const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');

beforeEach(() => {
  try { fs.rmSync(NOTIFICATIONS_FILE, { force: true }); } catch { /* noop */ }
});

async function raise(dedupKey: string, timestamp: number) {
  return upsertNotification({
    kind: 'operation-error', severity: 'error', title: 'Web assets VANISHED from under the running server',
    dedupKey, recoveryKey: 'web-assets', timestamp,
  });
}

describe('recoverNotifications asOf', () => {
  it('retires cards raised before asOf and keeps a card raised (or raised again) after it', async () => {
    const signal = 1_800_000_000_000;
    await raise('logerr:web:before', signal - 60_000);
    await raise('logerr:web:after', signal + 5_000);
    // Raised first before the signal, then again after it: the latest raise counts.
    await raise('logerr:web:again', signal - 60_000);
    await raise('logerr:web:again', signal + 5_000);

    const { recovered } = await recoverNotifications(['web-assets'], { asOf: signal });
    expect(recovered.map(r => r.dedupKey)).toEqual(['logerr:web:before']);

    const feed = (await listNotifications()).feed;
    const state = (k: string) => feed.find(n => n.dedupKey === k)?.resolved;
    expect(state('logerr:web:before')).toBe('recovered');
    expect(state('logerr:web:after')).toBeUndefined();
    expect(state('logerr:web:again')).toBeUndefined();
  });

  it('without asOf every matching card is retired, as before', async () => {
    await raise('logerr:web:old', Date.now() - 60_000);
    await raise('logerr:web:future', Date.now() + 60_000);
    const { recovered } = await recoverNotifications(['web-assets']);
    expect(recovered.map(r => r.dedupKey).sort()).toEqual(['logerr:web:future', 'logerr:web:old']);
  });
});
