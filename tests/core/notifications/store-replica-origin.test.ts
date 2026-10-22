/**
 * The notification store on the CLOUD COMPANION (CLOUD_MODE true).
 *
 * What the companion writes reaches the Mac (since stage 4d over the
 * `server.notifications.cards` relay, companion-cards.test.ts; before it, the
 * data sync carried notifications.json). 2026-10-03: the companion ran a build
 * older than the Slack plugin the sync handed it, failed to load it, and its two
 * cards appeared on the Mac as "Plugin activation failed" with nothing saying
 * where. Three rules pinned:
 * the companion stamps `origin: 'replica'` on its error cards, its success
 * signals retire only its own cards, and its card sentences say where it happened.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notif-replica', { CLOUD_MODE: true }));

import {
  addNotification,
  upsertNotification,
  listNotifications,
  recoverNotifications,
  writtenHere,
  NOTIFICATIONS_STORE_FILE,
} from '../../../src/core/notifications/store.js';
import { ORIGIN_NOTE, WRITER_ORIGIN, withOriginNote } from '../../../src/core/notifications/origin.js';
import { unresolvedErrorRecoveryKeys } from '../../../src/core/notifications/permission-expiry.js';

// The box's own store (cache/companion-notifications.json since stage 4d).
const NOTIFICATIONS_FILE = NOTIFICATIONS_STORE_FILE;

beforeEach(() => {
  try { fs.rmSync(NOTIFICATIONS_FILE, { force: true }); } catch { /* noop */ }
});

describe('on the cloud companion', () => {
  it('error cards it writes carry origin "replica"; other kinds are untouched', async () => {
    expect(WRITER_ORIGIN).toBe('replica');
    const { record } = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Plugin activation failed',
      dedupKey: 'logerr:plugin-loader:1', recoveryKey: 'plugin:chat',
    });
    expect(record.origin).toBe('replica');
    const added = await addNotification({
      kind: 'operation-error', severity: 'error', title: 'Backup failing', dedupKey: 'error:backup',
    });
    expect(added.origin).toBe('replica');
    const perm = await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:r1', sessionId: 's1',
    });
    expect(perm.origin).toBeUndefined();
    // Persisted, not just returned: the box's store is what it sends the Mac.
    const raw = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
    expect(raw.notifications.map((n: { origin?: string }) => n.origin)).toEqual(['replica', 'replica', undefined]);
  });

  it('its recovery retires its own cards and leaves the primary\'s alone', async () => {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Plugin activation failed',
      dedupKey: 'logerr:plugin-loader:here', recoveryKey: 'plugin:chat',
    });
    // A card with no origin (one the Mac wrote, kept from before stage 4d).
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify({
      version: 1,
      notifications: [
        ...JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8')).notifications,
        {
          id: 'n-mac', kind: 'operation-error', severity: 'error', title: 'Plugin activation failed',
          dedupKey: 'logerr:plugin-loader:mac', recoveryKey: 'plugin:chat', timestamp: Date.now(), read: false,
        },
      ],
    }));

    const { recovered } = await recoverNotifications(['plugin:chat']);
    expect(recovered.map(r => r.dedupKey)).toEqual(['logerr:plugin-loader:here']);
    const { feed } = await listNotifications();
    expect(feed.find(n => n.dedupKey === 'logerr:plugin-loader:mac')?.resolved).toBeUndefined();
    expect(writtenHere({ origin: 'replica' })).toBe(true);
    expect(writtenHere({})).toBe(false);
  });

  it('boot seeding re-arms only the companion\'s own cards', async () => {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'route failed',
      dedupKey: 'logerr:web:here', recoveryKey: 'route:GET /api/here',
    });
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify({
      version: 1,
      notifications: [
        ...JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8')).notifications,
        {
          id: 'n-mac', kind: 'operation-error', severity: 'error', title: 'route failed',
          dedupKey: 'logerr:web:mac', recoveryKey: 'route:GET /api/mac', timestamp: Date.now(), read: false,
        },
      ],
    }));
    expect(await unresolvedErrorRecoveryKeys()).toEqual(['route:GET /api/here']);
  });

  it('the card sentence says where it happened', () => {
    expect(ORIGIN_NOTE).toBe('This happened on the cloud companion.');
    expect(withOriginNote('The plugin needs a newer Walnut.')).toBe(
      'The plugin needs a newer Walnut. This happened on the cloud companion.',
    );
    expect(withOriginNote('')).toBe('This happened on the cloud companion.');
  });
});
