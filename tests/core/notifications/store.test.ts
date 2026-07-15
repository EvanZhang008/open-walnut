/**
 * Unit tests for the unified notification store (durable feed behind the bell).
 *
 * Contract under test:
 *   - addNotification persists to WALNUT_HOME/notifications.json; listNotifications reads it back.
 *   - dedupKey makes addNotification idempotent (re-emit timers must not double the feed).
 *   - unreadCount reflects unread entries; markRead(ids?) marks some / all read.
 *   - The store is bounded to MAX_NOTIFICATIONS (oldest drop off the tail).
 *
 * WALNUT_HOME is redirected to an isolated tmpdir via createMockConstants, so the
 * store file never touches real data. We clean notifications.json between tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  addNotification,
  listNotifications,
  markRead,
  dismissNotifications,
  resolvePermissionNotification,
} from '../../../src/core/notifications/store.js';

const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');

beforeEach(() => {
  // Start each test from an empty store.
  try { fs.rmSync(NOTIFICATIONS_FILE, { force: true }); } catch { /* noop */ }
  try { fs.rmSync(NOTIFICATIONS_FILE.replace(/\.json$/, '.backup.json'), { force: true }); } catch { /* noop */ }
});

describe('notification store', () => {
  it('adds and lists notifications, reading back from disk', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'Backup', body: 'done', dedupKey: 'cron:Backup:1' });
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', body: 'approve?', sessionId: 's1', dedupKey: 'perm:r1' });

    const { feed, unreadCount } = await listNotifications();
    expect(feed).toHaveLength(2);
    expect(unreadCount).toBe(2);
    // newest-last insertion order
    expect(feed[0].dedupKey).toBe('cron:Backup:1');
    expect(feed[1].sessionId).toBe('s1');

    // persisted to disk in the versioned envelope
    const raw = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.notifications).toHaveLength(2);
  });

  it('de-dupes by dedupKey — same key returns the existing record, no duplicate', async () => {
    const first = await addNotification({ kind: 'cron', severity: 'info', title: 'Backup', dedupKey: 'cron:Backup:1' });
    const again = await addNotification({ kind: 'cron', severity: 'info', title: 'Backup (re-emit)', dedupKey: 'cron:Backup:1' });

    expect(again.id).toBe(first.id);
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    // The original title is preserved (re-emit does not mutate).
    expect(feed[0].title).toBe('Backup');
  });

  it('marks specific ids read, then all read', async () => {
    const a = await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    let res = await markRead([a.id]);
    expect(res.unreadCount).toBe(1);

    res = await markRead(); // no ids → all read
    expect(res.unreadCount).toBe(0);

    const { feed, unreadCount } = await listNotifications();
    expect(unreadCount).toBe(0);
    expect(feed.every(n => n.read)).toBe(true);
  });

  it('stamps id/timestamp/read defaults when not supplied', async () => {
    const rec = await addNotification({ kind: 'operation-error', severity: 'error', title: 'oops', dedupKey: 'operr:oops' });
    expect(rec.id).toMatch(/^notif-/);
    expect(typeof rec.timestamp).toBe('number');
    expect(rec.read).toBe(false);
  });

  it('dismisses specific entries by id or dedupKey', async () => {
    const a = await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'C', dedupKey: 'k:c' });

    let res = await dismissNotifications({ ids: [a.id] });
    expect(res.removed).toBe(1);

    res = await dismissNotifications({ dedupKeys: ['k:b'] });
    expect(res.removed).toBe(1);

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].dedupKey).toBe('k:c');
  });

  it('treats explicitly empty filter arrays as a no-op, NOT clear-all', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    // The frontend's optimistic dismissFeed([]) deletes nothing locally, so the
    // server must not interpret [] as an unfiltered wipe (UI/disk desync).
    for (const filter of [{ ids: [] }, { dedupKeys: [] }, { ids: [], dedupKeys: [] }]) {
      const res = await dismissNotifications(filter);
      expect(res.removed).toBe(0);
    }
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(2);
  });

  it('clears the whole feed with no filter, writing a .backup first', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    const res = await dismissNotifications();
    expect(res.removed).toBe(2);
    expect(res.unreadCount).toBe(0);

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(0);

    // Non-empty → empty transition snapshots the previous store.
    const backup = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE.replace(/\.json$/, '.backup.json'), 'utf-8'));
    expect(backup.notifications).toHaveLength(2);
  });

  it('dismissed pending permissions can be re-added under the same dedupKey (60s re-ask)', async () => {
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', sessionId: 's1', dedupKey: 'perm:r1' });
    await dismissNotifications({ dedupKeys: ['perm:r1'] });

    const again = await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', sessionId: 's1', dedupKey: 'perm:r1' });
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe(again.id);
  });

  it('stamps a permission notification with its resolution', async () => {
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', sessionId: 's1', dedupKey: 'perm:r1' });

    await resolvePermissionNotification('r1', 'allowed');
    let { feed } = await listNotifications();
    expect(feed[0].resolved).toBe('allowed');
    expect(feed[0].severity).toBe('success');

    // No-op for an unknown / already-dismissed request.
    await resolvePermissionNotification('nope', 'denied');
    ({ feed } = await listNotifications());
    expect(feed).toHaveLength(1);
  });

  it('bounds the store to the most-recent MAX_NOTIFICATIONS', async () => {
    // Add 210 distinct notifications; the oldest 10 should drop off the tail.
    for (let i = 0; i < 210; i++) {
      await addNotification({ kind: 'cron', severity: 'info', title: `n${i}`, dedupKey: `k:${i}` });
    }
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(200);
    // Oldest survivor is n10 (n0..n9 dropped).
    expect(feed[0].dedupKey).toBe('k:10');
    expect(feed[feed.length - 1].dedupKey).toBe('k:209');
  });
});
