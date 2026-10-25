/**
 * An error card is one cause's lifecycle, not a tally of polls.
 *
 * 2026-10-25: three sync cards read x29 each for one standing cause, because
 * every 60 s window (and every restart) counted as an occurrence and re-badged
 * the bell; a dismissed card came back a minute later. The rules under test:
 *   - a standing failure refreshes its card (latest body, lastTimestamp) and
 *     neither counts nor re-badges;
 *   - the same failure after a recovery reopens the card: it counts and is unread;
 *   - a card dismissed while failing stays dismissed until its own condition
 *     recovers, and an unrelated recovery does not end that;
 *   - a dismissal nothing can recover lapses, so a real problem is never hidden for good;
 *   - permission cards and resolved cards leave no dismissal behind.
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
  recoverNotifications,
  dismissedConditionKeys,
} from '../../../src/core/notifications/store.js';
import { DISMISS_HOLD_KEYED_MS, DISMISS_HOLD_KEYLESS_MS } from '../../../src/core/notifications/dismissed-conditions.js';

const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');

beforeEach(() => {
  try { fs.rmSync(NOTIFICATIONS_FILE, { force: true }); } catch { /* noop */ }
  try { fs.rmSync(NOTIFICATIONS_FILE.replace(/\.json$/, '.backup.json'), { force: true }); } catch { /* noop */ }
});

const err = (over: Record<string, unknown> = {}) => ({
  kind: 'operation-error' as const, severity: 'error' as const,
  title: 'Cannot connect to box', dedupKey: 'logerr:cause:host:box', recoveryKey: 'host:box',
  ...over,
});

function storeOnDisk(): { notifications: unknown[]; dismissed?: Array<{ dedupKey: string }> } {
  return JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
}

describe('repeated polling of one standing cause', () => {
  it('fifty refreshes are still one card, count 1, read once the user read it', async () => {
    await upsertNotification(err({ timestamp: 1_000 }));
    await markRead();
    for (let i = 1; i <= 50; i++) {
      const { outcome } = await upsertNotification(err({ body: `poll ${i}`, timestamp: 1_000 + i * 60_000 }));
      expect(outcome).toBe('refreshed');
    }
    const { feed, unreadCount } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].count).toBeUndefined();
    expect(feed[0].body).toBe('poll 50');
    expect(feed[0].lastTimestamp).toBe(1_000 + 50 * 60_000);
    expect(unreadCount).toBe(0);
  });
});

describe('a failure, its recovery, and a failure again', () => {
  it('the cause coming back after a recovery reopens the card: count 2, unread', async () => {
    await upsertNotification(err());
    await markRead();
    const { recovered } = await recoverNotifications(['host:box']);
    expect(recovered).toHaveLength(1);

    const again = await upsertNotification(err({ body: 'down again' }));
    expect(again.outcome).toBe('reopened');
    expect(again.record.resolved).toBeUndefined();
    expect(again.record.count).toBe(2);
    expect(again.record.read).toBe(false);
  });

  it('a recovery of another condition leaves this card failing', async () => {
    await upsertNotification(err());
    await upsertNotification(err({ title: 'Cannot connect to other', dedupKey: 'logerr:cause:host:other', recoveryKey: 'host:other' }));
    await recoverNotifications(['host:other']);
    const { feed } = await listNotifications();
    expect(feed.find(n => n.dedupKey === 'logerr:cause:host:box')?.resolved).toBeUndefined();
    expect(feed.find(n => n.dedupKey === 'logerr:cause:host:other')?.resolved).toBe('recovered');
  });
});

describe('a card the user dismissed while its cause stood', () => {
  it('the same cause is absorbed silently until the condition recovers', async () => {
    await upsertNotification(err());
    await dismissNotifications({ dedupKeys: ['logerr:cause:host:box'] });

    for (let i = 0; i < 3; i++) {
      const { outcome } = await upsertNotification(err());
      expect(outcome).toBe('suppressed');
    }
    expect((await listNotifications()).feed).toHaveLength(0);

    // An unrelated condition recovering does not end the dismissal.
    await recoverNotifications(['host:other', 'plugin:acme']);
    expect((await upsertNotification(err())).outcome).toBe('suppressed');

    // Its own recovery does: the next failure is news.
    await recoverNotifications(['host:box']);
    expect(storeOnDisk().dismissed ?? []).toHaveLength(0);
    const fresh = await upsertNotification(err({ body: 'down again' }));
    expect(fresh.outcome).toBe('inserted');
    expect(fresh.record.read).toBe(false);
  });

  it('a dismissal ends on the card\'s cause key too', async () => {
    await upsertNotification(err({ dedupKey: 'logerr:session:abc', recoveryKey: 'session:s1', causeKey: 'host:box' }));
    await dismissNotifications({ dedupKeys: ['logerr:session:abc'] });
    expect((await upsertNotification(err({ dedupKey: 'logerr:session:abc', recoveryKey: 'session:s1', causeKey: 'host:box' }))).outcome).toBe('suppressed');
    await recoverNotifications(['host:box']);
    expect((await upsertNotification(err({ dedupKey: 'logerr:session:abc', recoveryKey: 'session:s1', causeKey: 'host:box' }))).outcome).toBe('inserted');
  });

  it('other cards are unaffected by one dismissal', async () => {
    await upsertNotification(err());
    await dismissNotifications({ dedupKeys: ['logerr:cause:host:box'] });
    const other = await upsertNotification(err({ dedupKey: 'logerr:cause:host:other', recoveryKey: 'host:other' }));
    expect(other.outcome).toBe('inserted');
  });

  it('a keyless dismissal lapses after its hold, a keyed one after its longer hold', async () => {
    const now = Date.now();
    await upsertNotification(err({ dedupKey: 'logerr:keyless', recoveryKey: undefined }));
    await upsertNotification(err());
    await dismissNotifications();

    const soon = now + DISMISS_HOLD_KEYLESS_MS - 60_000;
    expect((await upsertNotification(err({ dedupKey: 'logerr:keyless', recoveryKey: undefined, timestamp: soon }))).outcome).toBe('suppressed');
    const later = now + DISMISS_HOLD_KEYLESS_MS + 60_000;
    expect((await upsertNotification(err({ dedupKey: 'logerr:keyless', recoveryKey: undefined, timestamp: later }))).outcome).toBe('inserted');
    expect((await upsertNotification(err({ timestamp: later }))).outcome).toBe('suppressed');
    const muchLater = now + DISMISS_HOLD_KEYED_MS + 60_000;
    expect((await upsertNotification(err({ timestamp: muchLater }))).outcome).toBe('inserted');
  });

  it('dismissing a card that already recovered leaves nothing behind', async () => {
    await upsertNotification(err());
    await recoverNotifications(['host:box']);
    await dismissNotifications();
    expect(storeOnDisk().dismissed ?? []).toHaveLength(0);
    expect((await upsertNotification(err())).outcome).toBe('inserted');
  });

  it('a permission card is never a dismissal: a new request still shows', async () => {
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:r1', sessionId: 's1' });
    await upsertNotification(err());
    await dismissNotifications();
    expect((storeOnDisk().dismissed ?? []).map(d => d.dedupKey)).toEqual(['logerr:cause:host:box']);
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', dedupKey: 'perm:r1', sessionId: 's1' });
    const { feed } = await listNotifications();
    expect(feed.map(n => n.dedupKey)).toEqual(['perm:r1']);
  });

  it('dismissing twice keeps one dismissal per card', async () => {
    await upsertNotification(err());
    await dismissNotifications();
    await upsertNotification(err({ dedupKey: 'logerr:cause:host:other', recoveryKey: 'host:other' }));
    await dismissNotifications();
    expect((storeOnDisk().dismissed ?? []).map(d => d.dedupKey).sort()).toEqual([
      'logerr:cause:host:box', 'logerr:cause:host:other',
    ]);
  });
});

describe('a dismissal across a restart', () => {
  it('its keys are handed to the boot seeding, so the recovery that ends it is armed', async () => {
    await upsertNotification(err({ dedupKey: 'logerr:route', recoveryKey: 'route:GET /api/x', causeKey: 'host:box' }));
    await dismissNotifications();
    expect((await dismissedConditionKeys()).sort()).toEqual(['host:box', 'route:GET /api/x']);
    await recoverNotifications(['route:GET /api/x']);
    expect(await dismissedConditionKeys()).toEqual([]);
  });

  it('a recovery observed BEFORE the dismissal does not end it', async () => {
    await upsertNotification(err());
    await dismissNotifications();
    await recoverNotifications(['host:box'], { asOf: Date.now() - 60_000 });
    expect((await upsertNotification(err())).outcome).toBe('suppressed');
    await recoverNotifications(['host:box'], { asOf: Date.now() + 1_000 });
    expect((await upsertNotification(err())).outcome).toBe('inserted');
  });
});

describe('a standing warning that becomes an error', () => {
  it('is unread again, without counting a new occurrence', async () => {
    await upsertNotification(err({ severity: 'warning' }));
    await markRead();
    const up = await upsertNotification(err({ severity: 'error' }));
    expect(up.record.read).toBe(false);
    expect(up.record.count).toBeUndefined();
    await markRead();
    expect((await upsertNotification(err({ severity: 'error' }))).record.read).toBe(true);
  });
});

describe('a store an older build wrote', () => {
  it('reads without the dismissed field and keeps working', async () => {
    fs.mkdirSync(WALNUT_HOME, { recursive: true });
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify({
      version: 1,
      notifications: [{ ...err(), id: 'n1', timestamp: 1_000, read: true, count: 29 }],
    }));
    const refreshed = await upsertNotification(err({ timestamp: 2_000 }));
    expect(refreshed.outcome).toBe('refreshed');
    // The old tally is not grown any further.
    expect(refreshed.record.count).toBe(29);
    expect(refreshed.record.read).toBe(true);
  });
});
