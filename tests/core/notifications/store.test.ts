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
  recoverNotifications,
  expireErrorNotifications,
  expireKeylessErrorNotifications,
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

  it("stamps 'expired' when nobody ever answered — severity info, not a decision", async () => {
    // The phantom-in-Needs-Action bug: a request whose session died stayed
    // resolved:undefined forever, which the panel reads as still pending.
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash',
      sessionId: 's-dead', dedupKey: 'perm:r-expired', requestId: 'r-expired',
    });

    await resolvePermissionNotification('r-expired', 'expired');
    const { feed } = await listNotifications();
    expect(feed[0].resolved).toBe('expired');
    // 'info': an expiry is a neutral fact about a dead session, not an error and
    // not a user decision (which is why it must not read as 'denied' either).
    expect(feed[0].severity).toBe('info');
  });

  it('an expiry does not overwrite a real answer, and is idempotent', async () => {
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash',
      sessionId: 's1', dedupKey: 'perm:r-answered', requestId: 'r-answered',
    });
    await resolvePermissionNotification('r-answered', 'allowed');
    // A later death-path expiry for the same request would be a lie: the user
    // DID answer. The store keeps the last write, so callers must not race —
    // pin the current contract (last write wins) so a change is deliberate.
    await resolvePermissionNotification('r-expired-noop', 'expired');
    let { feed } = await listNotifications();
    expect(feed.find(n => n.dedupKey === 'perm:r-answered')?.resolved).toBe('allowed');

    // Same stamp twice is a no-op (the terminal clear + the startup reconcile
    // can both fire for one request).
    await resolvePermissionNotification('r-answered', 'allowed');
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

/**
 * recoverNotifications — the lifecycle an error notification was missing.
 *
 * An error describes a CONDITION (plugin auth expired, backup failing, disk
 * full). Conditions recover, but the feed was fire-and-forget, so a wall of red
 * survived the fix forever. These pin what a recovery may and may NOT touch.
 */
describe('recoverNotifications', () => {
  /** One unresolved operation-error under `key`. */
  async function seedError(dedupKey: string, recoveryKey?: string): Promise<void> {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: `failed ${dedupKey}`,
      dedupKey, ...(recoveryKey ? { recoveryKey } : {}),
    });
  }

  it('stamps only the matching unresolved operation-errors', async () => {
    await seedError('error:a1', 'plugin:plugin-a');
    await seedError('error:a2', 'plugin:plugin-a');
    await seedError('error:b1', 'plugin:plugin-b'); // other key
    await seedError('error:nokey');                 // no key at all
    // Wrong KIND: a cron receipt under the same key is not an error condition.
    await upsertNotification({
      kind: 'cron', severity: 'info', title: 'ran', dedupKey: 'cron:x', recoveryKey: 'plugin:plugin-a',
    });
    // Already settled: a second recovery must not re-stamp or re-clone it.
    await seedError('error:done', 'plugin:plugin-a');
    await recoverNotifications(['plugin:plugin-a']);

    const { recovered } = await recoverNotifications(['plugin:plugin-a']);
    // error:a1/a2/done were all retired by the FIRST call, so the second finds none.
    expect(recovered).toHaveLength(0);

    const { feed } = await listNotifications();
    const byKey = new Map(feed.map(n => [n.dedupKey, n]));
    expect(byKey.get('error:a1')?.resolved).toBe('recovered');
    expect(byKey.get('error:a2')?.resolved).toBe('recovered');
    expect(byKey.get('error:done')?.resolved).toBe('recovered');
    // Untouched: different key, no key, wrong kind.
    expect(byKey.get('error:b1')?.resolved).toBeUndefined();
    expect(byKey.get('error:nokey')?.resolved).toBeUndefined();
    expect(byKey.get('cron:x')?.resolved).toBeUndefined();
  });

  it('remaps severity to info and returns the changed records', async () => {
    await seedError('error:sev', 'git');
    const { recovered } = await recoverNotifications(['git']);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].dedupKey).toBe('error:sev');
    expect(recovered[0].resolved).toBe('recovered');
    // 'info', same mapping as denied/expired: settled, nothing left to fix. The
    // panel's red severity dot follows this, so a stale 'error' would keep the
    // row screaming while the condition is gone.
    expect(recovered[0].severity).toBe('info');
    const { feed } = await listNotifications();
    expect(feed[0].severity).toBe('info');
  });

  it('NEVER touches read — recovery is good news, not a re-badge', async () => {
    await seedError('error:read', 'backup');
    await markRead();
    let { unreadCount } = await listNotifications();
    expect(unreadCount).toBe(0);

    await recoverNotifications(['backup']);
    ({ unreadCount } = await listNotifications());
    // A re-FIRE legitimately resets read (upsertNotification does). A RECOVERY
    // must not: re-badging the bell to announce "the thing you fixed is fixed"
    // is exactly the noise this feature removes.
    expect(unreadCount).toBe(0);
    const { feed } = await listNotifications();
    expect(feed[0].read).toBe(true);
  });

  it('returns CLONES, so a later fold cannot mutate a broadcast payload', async () => {
    await seedError('error:clone2', 'disk');
    const { recovered } = await recoverNotifications(['disk']);
    expect(recovered[0].severity).toBe('info');

    // The card re-fires after the recovery: the store record goes back to error,
    // but the payload the caller is mid-broadcast with must not change.
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'failed again', dedupKey: 'error:clone2',
    });
    expect(recovered[0].severity).toBe('info');
    expect(recovered[0].resolved).toBe('recovered');
    const { feed } = await listNotifications();
    // upsert clears a non-permission `resolved` — a fresh occurrence means the
    // condition is back, so the card must go red again rather than stay green.
    expect(feed[0].resolved).toBeUndefined();
    expect(feed[0].severity).toBe('error');
  });

  it('no-ops cleanly on empty keys and on no matches', async () => {
    await seedError('error:none', 'git');
    expect((await recoverNotifications([])).recovered).toHaveLength(0);
    expect((await recoverNotifications(['plugin:nobody'])).recovered).toHaveLength(0);
    const { feed } = await listNotifications();
    expect(feed[0].resolved).toBeUndefined();
  });

  it('a fold can SET recoveryKey on a record that had none (refreshable)', async () => {
    // The backlog case: a record written before its producer learned the key.
    await seedError('error:late');
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'failed error:late',
      dedupKey: 'error:late', recoveryKey: 'plugin:plugin-a',
    });
    const { recovered } = await recoverNotifications(['plugin:plugin-a']);
    expect(recovered).toHaveLength(1);
  });
});

/**
 * The OTHER end of an error's lifecycle: conditions that can never recover.
 *
 * Recovery needs a future success to arrive. A session error whose session is
 * dead will never get one, and a keyless record predating recoveryKey has nothing
 * that could ever signal it — both would sit red forever. 'expired' says
 * "settled, nothing to do"; 'recovered' would be a lie (nobody fixed anything).
 */
describe('expireErrorNotifications', () => {
  async function seedError(dedupKey: string, recoveryKey?: string): Promise<void> {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: `failed ${dedupKey}`,
      dedupKey, ...(recoveryKey ? { recoveryKey } : {}),
    });
  }

  it('stamps expired + info on the matching unresolved errors', async () => {
    await seedError('error:s1', 'session:sess-dead');
    await seedError('error:s2', 'session:sess-dead');
    await seedError('error:other', 'session:sess-alive');

    const { expired } = await expireErrorNotifications(['session:sess-dead']);
    expect(expired.map(r => r.dedupKey).sort()).toEqual(['error:s1', 'error:s2']);
    expect(expired.every(r => r.resolved === 'expired')).toBe(true);
    expect(expired.every(r => r.severity === 'info')).toBe(true);

    const byKey = new Map((await listNotifications()).feed.map(n => [n.dedupKey, n]));
    expect(byKey.get('error:other')?.resolved).toBeUndefined();
  });

  it('does NOT overwrite an already-settled record, in either direction', async () => {
    // A card the git tick already RECOVERED must not be downgraded to 'expired'
    // by a later death sweep: recovery is the more informative outcome and it
    // was true when it was stamped.
    await seedError('error:done', 'session:sess-x');
    await recoverNotifications(['session:sess-x']);
    const { expired } = await expireErrorNotifications(['session:sess-x']);
    expect(expired).toHaveLength(0);
    const { feed } = await listNotifications();
    expect(feed[0].resolved).toBe('recovered');
  });

  it('never touches permissions, other kinds, or read state', async () => {
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash',
      dedupKey: 'perm:req-1', requestId: 'req-1', recoveryKey: 'session:sess-dead',
    });
    await upsertNotification({
      kind: 'cron', severity: 'info', title: 'ran',
      dedupKey: 'cron:x', recoveryKey: 'session:sess-dead',
    });
    await seedError('error:read', 'session:sess-dead');
    await markRead();

    const { expired } = await expireErrorNotifications(['session:sess-dead']);
    expect(expired.map(r => r.dedupKey)).toEqual(['error:read']);
    const { feed, unreadCount } = await listNotifications();
    // Expiry is not news — the bell must not re-badge (same rule as recovery).
    expect(unreadCount).toBe(0);
    const byKey = new Map(feed.map(n => [n.dedupKey, n]));
    expect(byKey.get('perm:req-1')?.resolved).toBeUndefined();
    expect(byKey.get('cron:x')?.resolved).toBeUndefined();
  });

  it('no-ops on empty keys and on no matches (the common session death)', async () => {
    await seedError('error:live', 'session:sess-live');
    expect((await expireErrorNotifications([])).expired).toHaveLength(0);
    // The cheap path every ordinary session death takes: a lock-free read finds
    // nothing to do and returns before taking the write lock.
    expect((await expireErrorNotifications(['session:never-failed'])).expired).toHaveLength(0);
    expect((await listNotifications()).feed[0].resolved).toBeUndefined();
  });

  it('a re-fire after expiry goes RED again (the condition came back)', async () => {
    // A remote session flapping: died (expired) then resumed and failed again.
    await seedError('error:flap', 'session:sess-flap');
    await expireErrorNotifications(['session:sess-flap']);
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'failed again',
      dedupKey: 'error:flap', recoveryKey: 'session:sess-flap',
    });
    const { feed } = await listNotifications();
    expect(feed[0].resolved).toBeUndefined();
    expect(feed[0].severity).toBe('error');
  });
});

/**
 * The one-time debris sweep (W7): keyless, old, unresolvable.
 *
 * The live feed had 20 unresolved cards written before recoveryKey existed —
 * nine of them the SAME failing route. No key means no success signal can ever
 * reach them, so they are permanent by construction. One age rule, no
 * per-producer special-casing.
 */
describe('expireKeylessErrorNotifications', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;

  async function seedAt(dedupKey: string, timestamp: number, recoveryKey?: string): Promise<void> {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: `GET /api/ui-prefs → 500 ${dedupKey}`,
      dedupKey, timestamp, ...(recoveryKey ? { recoveryKey } : {}),
    });
  }

  it('expires an OLD KEYLESS error — the pre-lifecycle debris case', async () => {
    await seedAt('error:legacy', NOW - 3 * DAY);
    const { expired } = await expireKeylessErrorNotifications(2 * DAY, NOW);
    expect(expired.map(r => r.dedupKey)).toEqual(['error:legacy']);
    const { feed } = await listNotifications();
    expect(feed[0].resolved).toBe('expired');
    expect(feed[0].severity).toBe('info');
  });

  it('leaves a FRESH keyless error alone (it may be happening right now)', async () => {
    await seedAt('error:fresh', NOW - 60_000);
    const { expired } = await expireKeylessErrorNotifications(2 * DAY, NOW);
    expect(expired).toHaveLength(0);
    expect((await listNotifications()).feed[0].resolved).toBeUndefined();
  });

  it('leaves a KEYED error alone however old — it still has a lifecycle', async () => {
    // A plugin that has been broken for a week must stay red: the moment the user
    // re-authenticates, its own success signal retires it honestly.
    await seedAt('error:keyed', NOW - 30 * DAY, 'plugin:plugin-a');
    const { expired } = await expireKeylessErrorNotifications(2 * DAY, NOW);
    expect(expired).toHaveLength(0);
    expect((await listNotifications()).feed[0].resolved).toBeUndefined();
  });

  it('ages off the LATEST occurrence, not first-seen', async () => {
    // A card first seen a week ago that folded a repeat a minute ago describes
    // something still happening — the first-seen stamp is not its age.
    await seedAt('error:folding', NOW - 7 * DAY);
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'still failing',
      dedupKey: 'error:folding', timestamp: NOW - 60_000,
    });
    const { expired } = await expireKeylessErrorNotifications(2 * DAY, NOW);
    expect(expired).toHaveLength(0);
  });

  it('never touches other kinds or already-settled records', async () => {
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash',
      dedupKey: 'perm:old', requestId: 'old', timestamp: NOW - 30 * DAY,
    });
    await upsertNotification({
      kind: 'cron', severity: 'info', title: 'ran long ago',
      dedupKey: 'cron:old', timestamp: NOW - 30 * DAY,
    });
    await seedAt('error:already', NOW - 30 * DAY);
    await expireKeylessErrorNotifications(2 * DAY, NOW);

    const { expired } = await expireKeylessErrorNotifications(2 * DAY, NOW);
    expect(expired).toHaveLength(0); // idempotent
    const byKey = new Map((await listNotifications()).feed.map(n => [n.dedupKey, n]));
    // A stale unanswered PERMISSION is the permission sweep's business, not ours:
    // it would read "Session ended", and only after checking the session.
    expect(byKey.get('perm:old')?.resolved).toBeUndefined();
    expect(byKey.get('cron:old')?.resolved).toBeUndefined();
    expect(byKey.get('error:already')?.resolved).toBe('expired');
  });
});
