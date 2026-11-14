/**
 * The one area check on every row written into a session's queue (router/delivery-scope.ts
 * assertAreaDelivery), and the parked branch of deliverToSession, which enqueues without going
 * through sendMessageToSession. Fake boundaries only: no CLI, no real permission prompt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-delivery-scope'));

const h = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  enqueueMessage: vi.fn(async (sid: string, message: string, opts?: { id?: string }) => ({ id: opts?.id ?? 'qm-x', sessionId: sid, message })),
  sendMessageToSession: vi.fn(async () => ({ id: 'qm-sent' })),
}));
const { enqueueMessage, sendMessageToSession } = h;
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => h.records.get(sid),
}));
vi.mock('../../src/core/session-message-queue.js', () => ({
  enqueueMessage: h.enqueueMessage, sendMessageToSession: h.sendMessageToSession,
}));
// Module boundary: the real router/wake.ts never loads in this file's graph, so the one wake
// grant of this file's delivery-scope instance is the test's (vitest isolates modules per file).
// Taking it a second time still throws, as router-wake.test.ts pins.
vi.mock('../../src/core/router/wake.js', () => ({}));

import {
  assertAreaDelivery, takeRouterWakeGrant, withRouterDelivery, AREA_DELIVERY_REFUSED, ROUTER_RUNTIME_SOURCE,
} from '../../src/core/router/delivery-scope.js';
import { deliverToSession } from '../../src/core/sessions/session-send-core.js';
import type { SessionRecord } from '../../src/core/types.js';

const withWake = takeRouterWakeGrant();
const work = { profile: { areaId: 'personal', areaRole: 'work' as const } };
const router = { profile: { areaId: 'personal', areaRole: 'router' as const } };
const plain = { profile: undefined };

beforeEach(() => {
  h.records.clear();
  enqueueMessage.mockClear();
  sendMessageToSession.mockClear();
});

describe('assertAreaDelivery', () => {
  it('leaves an ordinary session alone for every source but the router wake', () => {
    for (const source of ['peer', 'walnut-notify', 'trigger', 'ui', undefined]) {
      expect(assertAreaDelivery(plain, 's1', source, undefined)).toBe(false);
    }
    expect(assertAreaDelivery(undefined, 's1', 'peer', undefined)).toBe(false);
    expect(() => assertAreaDelivery(plain, 's1', ROUTER_RUNTIME_SOURCE, undefined)).toThrow(AREA_DELIVERY_REFUSED);
  });

  it('lets a person and the session\'s own recovery into an area session', () => {
    for (const source of ['ui', 'mobile', 'cli', 'web-api', 'api-v1', 'chat', 'auto-recover', 'context-compact', 'context-recovery']) {
      expect(assertAreaDelivery(work, 's1', source, undefined)).toBe(true);
    }
  });

  it('refuses automatic context into an area session without a grant', () => {
    for (const source of ['peer', 'walnut-notify', 'trigger', 'api-agent', undefined]) {
      expect(() => assertAreaDelivery(work, 's1', source, 'qm-route-1')).toThrow(AREA_DELIVERY_REFUSED);
    }
  });

  it('lets a router delivery in only for its own session and message id', async () => {
    await withRouterDelivery('s1', 'qm-route-1', async () => {
      expect(assertAreaDelivery(work, 's1', 'peer', 'qm-route-1')).toBe(true);
      expect(() => assertAreaDelivery(work, 's1', 'peer', 'qm-route-2')).toThrow(AREA_DELIVERY_REFUSED);
      expect(() => assertAreaDelivery(work, 's2', 'peer', 'qm-route-1')).toThrow(AREA_DELIVERY_REFUSED);
    });
  });

  it('lets the router wake into a router session only inside the wake grant', async () => {
    expect(() => assertAreaDelivery(router, 's1', ROUTER_RUNTIME_SOURCE, undefined)).toThrow(AREA_DELIVERY_REFUSED);
    expect(() => takeRouterWakeGrant()).toThrow(/already taken/);
    await withWake('s1', async () => {
      expect(assertAreaDelivery(router, 's1', ROUTER_RUNTIME_SOURCE, undefined)).toBe(true);
      expect(() => assertAreaDelivery(work, 's1', ROUTER_RUNTIME_SOURCE, undefined)).toThrow(AREA_DELIVERY_REFUSED);
      expect(() => assertAreaDelivery(router, 's2', ROUTER_RUNTIME_SOURCE, undefined)).toThrow(AREA_DELIVERY_REFUSED);
    });
  });
});

describe('deliverToSession behind a pending prompt', () => {
  const parked = (sid: string, profile?: SessionRecord['profile']) => ({
    claudeSessionId: sid, profile, pendingPermission: { toolName: 'Bash' },
  }) as unknown as SessionRecord;
  const opts = { busText: 'hello', enqueueText: 'hello', source: 'peer' };

  it('still parks an ordinary session\'s row without dispatching it', async () => {
    h.records.set('s1', { claudeSessionId: 's1' });
    const out = await deliverToSession(parked('s1'), opts);
    expect(out.delivery).toBe('deferred');
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('refuses automatic context into a parked area session, on the record as it is now', async () => {
    h.records.set('s1', { claudeSessionId: 's1', ...work });
    // The caller's snapshot says ordinary; the fresh record is an area session.
    await expect(deliverToSession(parked('s1'), opts)).rejects.toThrow(AREA_DELIVERY_REFUSED);
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('refuses when the session record is gone', async () => {
    await expect(deliverToSession(parked('gone'), opts)).rejects.toMatchObject({ code: 'unknown_target' });
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('parks a granted router delivery into its area session', async () => {
    h.records.set('s1', { claudeSessionId: 's1', ...work });
    const out = await withRouterDelivery('s1', 'qm-route-1', () =>
      deliverToSession(parked('s1', work.profile), { ...opts, messageId: 'qm-route-1' }));
    expect(out).toEqual({ delivery: 'deferred', messageId: 'qm-route-1' });
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });
});
