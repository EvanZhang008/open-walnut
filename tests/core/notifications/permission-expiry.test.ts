/**
 * expireOrphanedPermissionNotifications — the startup backlog sweep.
 *
 * The bug it fixes: a permission notification (`perm:<requestId>`) was only ever
 * stamped when the USER answered. When the session died, errored, or the CLI
 * withdrew the ask, the session RECORD's pendingPermission was cleared but the
 * notification stayed `resolved: undefined` — which sectionOf() reads as still
 * pending, i.e. a permanent phantom in Needs Action offering Approve/Deny buttons
 * that 404. The live prod instance was a request on a session that had been dead
 * with status Error for days.
 *
 * Contract under test:
 *   - expires when the session is missing, terminal, or has moved to a different
 *     (or no) pending request;
 *   - leaves a GENUINELY pending request alone (that's the whole rail);
 *   - honors the remote_unreachable carve-out (tunnel drop ≠ dead CLI, so the
 *     remote process may still be waiting on this very question);
 *   - never touches non-permission kinds or already-resolved records.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { process_status?: string; pid?: number | null }) => {
    if (s.process_status === 'stopped' || s.process_status === 'error') return false;
    return s.pid != null;
  },
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  addNotification, upsertNotification, listNotifications, markRead, recoverNotifications,
} from '../../../src/core/notifications/store.js';
import {
  expireOrphanedPermissionNotifications, expireStaleErrorNotifications,
  KEYLESS_ERROR_DEBRIS_MS,
} from '../../../src/core/notifications/permission-expiry.js';
import {
  createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js';
import { closeDb } from '../../../src/core/session-db.js';

const PP = {
  requestId: 'x',
  toolName: 'ExitPlanMode',
  subtype: 'can_use_tool',
  receivedAt: '2026-08-01T00:00:00.000Z',
};

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

async function seedPerm(requestId: string, sessionId?: string): Promise<void> {
  await addNotification({
    kind: 'permission', severity: 'warning', title: 'ExitPlanMode',
    dedupKey: `perm:${requestId}`, requestId,
    ...(sessionId ? { sessionId } : {}),
  });
}

async function resolvedOf(requestId: string): Promise<string | undefined> {
  const { feed } = await listNotifications();
  return feed.find(n => n.dedupKey === `perm:${requestId}`)?.resolved;
}

describe('expireOrphanedPermissionNotifications', () => {
  it('INCIDENT SHAPE: unresolved request on a long-dead Error session → expired', async () => {
    await seedPerm('req-dead', 'sess-dead');
    await createSessionRecord('sess-dead', 'task-1', 'walnut');
    await updateSessionRecord('sess-dead', {
      process_status: 'error', status_reason: 'process_died', status_changed_by: 'health-monitor',
    } as never);

    expect(await expireOrphanedPermissionNotifications()).toBe(1);
    expect(await resolvedOf('req-dead')).toBe('expired');
  });

  it('expires when the session record is gone entirely', async () => {
    await seedPerm('req-ghost', 'sess-never-existed');
    expect(await expireOrphanedPermissionNotifications()).toBe(1);
    expect(await resolvedOf('req-ghost')).toBe('expired');
  });

  it('expires a record with no sessionId at all (nothing to answer against)', async () => {
    await seedPerm('req-orphan');
    expect(await expireOrphanedPermissionNotifications()).toBe(1);
    expect(await resolvedOf('req-orphan')).toBe('expired');
  });

  it('leaves a genuinely pending request on a LIVE session alone', async () => {
    await seedPerm('req-live', 'sess-live');
    await createSessionRecord('sess-live', 'task-2', 'walnut', undefined, { pid: 4242 });
    await updateSessionRecord('sess-live', { pendingPermission: { ...PP, requestId: 'req-live' } });

    expect(await expireOrphanedPermissionNotifications()).toBe(0);
    expect(await resolvedOf('req-live')).toBeUndefined();
  });

  it('expires a SUPERSEDED ask: session live, but now waiting on a different request', async () => {
    await seedPerm('req-old', 'sess-moved-on');
    await createSessionRecord('sess-moved-on', 'task-3', 'walnut', undefined, { pid: 4243 });
    await updateSessionRecord('sess-moved-on', { pendingPermission: { ...PP, requestId: 'req-new' } });

    expect(await expireOrphanedPermissionNotifications()).toBe(1);
    expect(await resolvedOf('req-old')).toBe('expired');
  });

  it('honors the remote_unreachable carve-out (tunnel drop, CLI may still be asking)', async () => {
    await seedPerm('req-flap', 'sess-flap');
    await createSessionRecord('sess-flap', 'task-4', 'walnut', undefined, { pid: 4244 });
    await updateSessionRecord('sess-flap', { pendingPermission: { ...PP, requestId: 'req-flap' } });
    await updateSessionRecord('sess-flap', {
      process_status: 'error', status_reason: 'remote_unreachable', status_changed_by: 'health-monitor',
    } as never);

    expect(await expireOrphanedPermissionNotifications()).toBe(0);
    expect(await resolvedOf('req-flap')).toBeUndefined();
  });

  it('ignores already-resolved permissions and other kinds', async () => {
    await addNotification({
      kind: 'permission', severity: 'success', title: 'Bash',
      sessionId: 'sess-gone', dedupKey: 'perm:req-answered', requestId: 'req-answered',
      resolved: 'allowed',
    });
    await addNotification({
      kind: 'operation-error', severity: 'error', title: 'Session Error',
      sessionId: 'sess-gone', dedupKey: 'error:session:sess-gone:runtime',
    });

    expect(await expireOrphanedPermissionNotifications()).toBe(0);
    expect(await resolvedOf('req-answered')).toBe('allowed');
  });

  it('falls back to the dedupKey for a legacy record with no requestId field', async () => {
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'ExitPlanMode',
      sessionId: 'sess-legacy-dead', dedupKey: 'perm:req-legacy',
    });
    expect(await expireOrphanedPermissionNotifications()).toBe(1);
    expect(await resolvedOf('req-legacy')).toBe('expired');
  });

  it('is idempotent — a second sweep expires nothing', async () => {
    await seedPerm('req-idem', 'sess-missing');
    expect(await expireOrphanedPermissionNotifications()).toBe(1);
    expect(await expireOrphanedPermissionNotifications()).toBe(0);
  });
});

/**
 * expireStaleErrorNotifications — the ERROR half of the same lifecycle problem.
 *
 * A session error card is keyed `session:<sid>` and recovers when that session's
 * next turn completes cleanly. Two cases make that signal unreachable forever, and
 * both were sitting in the live feed: the session is dead (runtime/delivery/
 * transport cards on sessions that ended days ago), and the record predates
 * recoveryKey entirely (nine `GET/PUT /api/ui-prefs → 500` cards with no key).
 * Neither is 'recovered' — nobody fixed anything — so both read 'expired'.
 */
describe('expireStaleErrorNotifications', () => {
  /** An unresolved operation-error under `recoveryKey`, first seen `ageMs` ago. */
  async function seedError(
    dedupKey: string, opts: { recoveryKey?: string; ageMs?: number; sessionId?: string } = {},
  ): Promise<void> {
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: `failed ${dedupKey}`,
      dedupKey,
      timestamp: Date.now() - (opts.ageMs ?? 0),
      ...(opts.recoveryKey ? { recoveryKey: opts.recoveryKey } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
  }

  async function resolvedOfKey(dedupKey: string): Promise<string | undefined> {
    const { feed } = await listNotifications();
    return feed.find(n => n.dedupKey === dedupKey)?.resolved;
  }

  it('INCIDENT SHAPE: session errors on an ALREADY-dead session → expired', async () => {
    // The backlog shape this sweep exists for: the session was terminal before the
    // records were written (or before the live death path shipped), so no death
    // transition will ever fire for it again. Seeded AFTER the transition so only
    // the sweep can settle them.
    //
    // The three live cards: runtime error, delivery failed, and a bridge-written
    // one from the session subsystem — all under one key, all retired together.
    await createSessionRecord('sess-dead', 'task-e1', 'walnut');
    await updateSessionRecord('sess-dead', {
      process_status: 'error', status_reason: 'process_died', status_changed_by: 'health-monitor',
    } as never);
    await seedError('error:session:sess-dead:runtime', { recoveryKey: 'session:sess-dead' });
    await seedError('error:session:sess-dead:delivery', { recoveryKey: 'session:sess-dead' });
    await seedError('logerr:session:abc', { recoveryKey: 'session:sess-dead' });

    const out = await expireStaleErrorNotifications();
    expect(out.deadSession).toBe(3);
    expect(await resolvedOfKey('error:session:sess-dead:runtime')).toBe('expired');
    expect(await resolvedOfKey('logerr:session:abc')).toBe('expired');
  });

  it('LIVE PATH: the death TRANSITION itself expires them, before any sweep runs', async () => {
    // The sweep above is only the backlog. The enforcement point is the terminal
    // transition in session-tracker: a session dying MID-FLIGHT must retire its own
    // cards immediately, or the user watches a red row until the next restart.
    await seedError('error:session:sess-dying:runtime', { recoveryKey: 'session:sess-dying' });
    await createSessionRecord('sess-dying', 'task-e0', 'walnut', undefined, { pid: 6161 });
    await updateSessionRecord('sess-dying', {
      process_status: 'error', status_reason: 'process_died', status_changed_by: 'health-monitor',
    } as never);

    // Fire-and-forget (the caller is an in-transaction mutator) → poll.
    for (let i = 0; i < 40; i++) {
      if (await resolvedOfKey('error:session:sess-dying:runtime')) break;
      await new Promise(r => setTimeout(r, 25));
    }
    expect(await resolvedOfKey('error:session:sess-dying:runtime')).toBe('expired');
    // …and the sweep then finds nothing left to do.
    expect((await expireStaleErrorNotifications()).deadSession).toBe(0);
  });

  it('expires when the session record is gone entirely', async () => {
    await seedError('error:ghost', { recoveryKey: 'session:sess-never-existed' });
    expect((await expireStaleErrorNotifications()).deadSession).toBe(1);
    expect(await resolvedOfKey('error:ghost')).toBe('expired');
  });

  it('leaves a LIVE session\'s error alone — its next clean turn will recover it', async () => {
    await seedError('error:live', { recoveryKey: 'session:sess-live' });
    await createSessionRecord('sess-live', 'task-e2', 'walnut', undefined, { pid: 5252 });

    expect((await expireStaleErrorNotifications()).deadSession).toBe(0);
    expect(await resolvedOfKey('error:live')).toBeUndefined();
  });

  it('honors the remote_unreachable carve-out (the tunnel dropped, the CLI may be fine)', async () => {
    // Same carve-out as the permission sweep and the terminal-transition clear: a
    // dropped tunnel is not death, and the remote CLI can still produce the clean
    // result that legitimately recovers this card.
    await seedError('error:flap', { recoveryKey: 'session:sess-flap' });
    await createSessionRecord('sess-flap', 'task-e3', 'walnut', undefined, { pid: 5253 });
    await updateSessionRecord('sess-flap', {
      process_status: 'error', status_reason: 'remote_unreachable', status_changed_by: 'health-monitor',
    } as never);

    expect((await expireStaleErrorNotifications()).deadSession).toBe(0);
    expect(await resolvedOfKey('error:flap')).toBeUndefined();
  });

  it('ignores non-session keys — a plugin/git condition has its own success point', async () => {
    // 'plugin:plugin-a' recovers when that plugin's next sync succeeds, whether or
    // not any session is alive. Sweeping it here would retire it on the wrong
    // signal (the round-1 compaction bug).
    await seedError('error:plugin', { recoveryKey: 'plugin:plugin-a' });
    await seedError('error:git', { recoveryKey: 'git' });
    await seedError('error:route', { recoveryKey: 'route:GET /api/x' });
    const out = await expireStaleErrorNotifications();
    expect(out.deadSession).toBe(0);
    expect(await resolvedOfKey('error:plugin')).toBeUndefined();
    expect(await resolvedOfKey('error:route')).toBeUndefined();
  });

  it('does not overwrite a card the real success point already RECOVERED', async () => {
    await seedError('error:won', { recoveryKey: 'session:sess-gone' });
    await recoverNotifications(['session:sess-gone']);
    const out = await expireStaleErrorNotifications();
    expect(out.deadSession).toBe(0);
    expect(await resolvedOfKey('error:won')).toBe('recovered');
  });

  it('DEBRIS: an old KEYLESS error is expired; a fresh one and a keyed one are not', async () => {
    const OLD = KEYLESS_ERROR_DEBRIS_MS + 60_000;
    // The nine-cards shape, keyless because it predates recoveryKey.
    await seedError('logerr:web:oldhash1', { ageMs: OLD });
    await seedError('logerr:web:oldhash2', { ageMs: OLD });
    // Fresh keyless: may be describing something happening right now.
    await seedError('logerr:web:freshhash', { ageMs: 60_000 });
    // Keyed and ancient: still has a lifecycle, so it must stay red until its own
    // success signal (a week-old plugin outage retires the moment auth is fixed).
    await seedError('logerr:web:keyed', { ageMs: 30 * 24 * 3600_000, recoveryKey: 'plugin:plugin-a' });

    const out = await expireStaleErrorNotifications();
    expect(out.keylessDebris).toBe(2);
    expect(await resolvedOfKey('logerr:web:oldhash1')).toBe('expired');
    expect(await resolvedOfKey('logerr:web:oldhash2')).toBe('expired');
    expect(await resolvedOfKey('logerr:web:freshhash')).toBeUndefined();
    expect(await resolvedOfKey('logerr:web:keyed')).toBeUndefined();
  });

  it('never re-badges the bell — a settle is not news', async () => {
    await seedError('error:read', { recoveryKey: 'session:sess-missing' });
    await seedError('logerr:web:olddebris', { ageMs: KEYLESS_ERROR_DEBRIS_MS + 1000 });
    await markRead();
    await expireStaleErrorNotifications();
    expect((await listNotifications()).unreadCount).toBe(0);
  });

  it('is idempotent — a second sweep expires nothing', async () => {
    await seedError('error:idem', { recoveryKey: 'session:sess-missing' });
    await seedError('logerr:web:idem-debris', { ageMs: KEYLESS_ERROR_DEBRIS_MS + 1000 });
    const first = await expireStaleErrorNotifications();
    expect(first.deadSession + first.keylessDebris).toBe(2);
    const second = await expireStaleErrorNotifications();
    expect(second).toEqual({ deadSession: 0, keylessDebris: 0 });
  });

  it('does not touch permissions at all (that is the other sweep)', async () => {
    await seedPerm('req-untouched', 'sess-missing');
    const out = await expireStaleErrorNotifications();
    expect(out).toEqual({ deadSession: 0, keylessDebris: 0 });
    expect(await resolvedOf('req-untouched')).toBeUndefined();
  });
});
