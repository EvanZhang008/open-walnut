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
  upsertNotification,
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

  it('carries the permission detail fields through a round-trip', async () => {
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash', body: 'ls -la',
      sessionId: 's1', dedupKey: 'perm:r9',
      requestId: 'r9', toolName: 'Bash', input: { command: 'ls -la' },
      reason: 'command not on the allowlist',
      acpOptions: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
      host: 'devbox', sessionTitle: 'Fix the parser', project: 'walnut',
    });

    const { feed } = await listNotifications();
    expect(feed[0]).toMatchObject({
      requestId: 'r9', toolName: 'Bash', input: { command: 'ls -la' },
      reason: 'command not on the allowlist',
      host: 'devbox', sessionTitle: 'Fix the parser', project: 'walnut',
    });
    expect(feed[0].acpOptions?.[0].optionId).toBe('allow');
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

describe('upsertNotification', () => {
  it('inserts on a fresh dedupKey, exactly like addNotification', async () => {
    const { record, outcome } = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Delivery Failed',
      body: 'host unreachable', dedupKey: 'error:session:s1:delivery',
    });

    expect(outcome).toBe('inserted');
    expect(record.id).toMatch(/^notif-/);
    expect(record.read).toBe(false);
    // A first occurrence carries no fold metadata (absent = 1).
    expect(record.count).toBeUndefined();
    expect(record.lastTimestamp).toBeUndefined();

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].body).toBe('host unreachable');
  });

  it('refreshes in place on a dedupKey hit: count grows, latest body wins, id/timestamp stable', async () => {
    const first = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Delivery Failed',
      body: 'attempt 1', timestamp: 1_000, dedupKey: 'error:session:s1:delivery',
    });
    await markRead(); // user opened the panel

    const second = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Delivery Failed',
      body: 'attempt 2', timestamp: 2_000, dedupKey: 'error:session:s1:delivery',
    });

    expect(second.outcome).toBe('refreshed');
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.timestamp).toBe(1_000); // first-seen preserved
    expect(second.record.lastTimestamp).toBe(2_000);
    expect(second.record.count).toBe(2);
    expect(second.record.body).toBe('attempt 2');
    expect(second.record.read).toBe(false); // a fresh occurrence is unread again

    const { feed, unreadCount } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(unreadCount).toBe(1);

    const third = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Delivery Failed',
      body: 'attempt 3', timestamp: 3_000, dedupKey: 'error:session:s1:delivery',
    });
    expect(third.record.count).toBe(3);
  });

  it('copies supplied detail fields onto the refreshed record, leaving unsupplied ones alone', async () => {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Failed',
      dedupKey: 'error:scope', sessionId: 's1', host: 'devbox', project: 'walnut',
    });
    const { record } = await upsertNotification({
      kind: 'operation-error', severity: 'warning', title: 'Failed again',
      dedupKey: 'error:scope', taskId: 't1', host: 'other-box',
    });

    expect(record.title).toBe('Failed again');
    expect(record.severity).toBe('warning');
    expect(record.host).toBe('other-box');
    expect(record.taskId).toBe('t1');
    expect(record.sessionId).toBe('s1'); // not supplied → untouched
    expect(record.project).toBe('walnut');
  });

  it('moves a refreshed record to the tail so the cap cannot evict a live error', async () => {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Recurring',
      dedupKey: 'error:recurring',
    });
    // Fill the store past the cap with newer, unrelated entries.
    for (let i = 0; i < 199; i++) {
      await addNotification({ kind: 'cron', severity: 'info', title: `n${i}`, dedupKey: `k:${i}` });
    }
    // The recurring error fires again — it must survive the next 200 arrivals.
    const refreshed = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Recurring',
      body: 'still failing', dedupKey: 'error:recurring',
    });
    expect(refreshed.outcome).toBe('refreshed');

    let { feed } = await listNotifications();
    expect(feed[feed.length - 1].dedupKey).toBe('error:recurring');

    for (let i = 0; i < 50; i++) {
      await addNotification({ kind: 'cron', severity: 'info', title: `m${i}`, dedupKey: `m:${i}` });
    }
    ({ feed } = await listNotifications());
    expect(feed.some(n => n.dedupKey === 'error:recurring')).toBe(true);
  });

  it('leaves addNotification first-write-wins semantics untouched', async () => {
    const first = await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash',
      body: 'original', timestamp: 1_000, dedupKey: 'perm:r1',
    });
    const again = await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash (re-ask)',
      body: 'changed', timestamp: 2_000, dedupKey: 'perm:r1',
    });

    expect(again.id).toBe(first.id);
    expect(again.timestamp).toBe(1_000);
    expect(again.title).toBe('Bash');
    expect(again.body).toBe('original');
    expect(again.count).toBeUndefined(); // no fold counting on the re-ask path
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
  });

  it('clears a stale resolution stamp on a non-permission refresh', async () => {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Failed',
      dedupKey: 'error:scope', resolved: 'allowed',
    });
    const { record } = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Failed',
      dedupKey: 'error:scope',
    });
    expect(record.resolved).toBeUndefined();
  });

  it('REFUSES kind:"permission" — a re-ask is not a recurrence', async () => {
    // Folding a permission would make count read as "this happened N times" for
    // one pending request. The permission path must stay on addNotification.
    await expect(upsertNotification({
      kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:rz',
    })).rejects.toThrow(/kind:"permission"/);

    const { feed } = await listNotifications();
    expect(feed).toHaveLength(0);
  });

  it('returns a CLONE on refresh, so a later fold cannot mutate a caller payload', async () => {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Failed', dedupKey: 'error:clone',
    });
    const { record: second } = await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Failed', body: 'b2', dedupKey: 'error:clone',
    });
    expect(second.count).toBe(2);

    // Callers broadcast `record` after awaits — a concurrent fold must not
    // change the payload under them.
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Failed', body: 'b3', dedupKey: 'error:clone',
    });
    expect(second.count).toBe(2);
    expect(second.body).toBe('b2');
  });
});
