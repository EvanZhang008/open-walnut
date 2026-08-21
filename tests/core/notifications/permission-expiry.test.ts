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
import { addNotification, listNotifications } from '../../../src/core/notifications/store.js';
import { expireOrphanedPermissionNotifications } from '../../../src/core/notifications/permission-expiry.js';
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
