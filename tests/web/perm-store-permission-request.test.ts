/**
 * One browser, one permission request — the store every surface reads.
 *
 * The three surfaces that show a pending ask (session timeline card, notification
 * rail card, toast) used to hold private copies and each POST the route itself, so
 * answering in one left the others armed: clicking Approve there 404'd and the
 * card stamped "Denied" on a request the user had just APPROVED. What is pinned
 * here is the state machine that replaced them:
 *
 *   - the optimistic flip happens BEFORE the round-trip (that is what makes the
 *     other surfaces settle in the same frame rather than after the WS echo);
 *   - 404/409 settles as `stale`, never `denied` — an outcome nobody witnessed is
 *     never claimed as the user's;
 *   - a transient failure rolls back to `pending` so the decision is retryable;
 *   - a settled request is never re-armed, by a re-ask or by a second click;
 *   - a withdrawal (cancelled/expired) beats the `allowed: false` it rides on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const respondToPermission = vi.hoisted(() => vi.fn());

vi.mock('@/api/sessions', () => ({ respondToPermission }));

import {
  getPermissionRequest, isSettledPermission, resetPermissionRequestStore,
  resolvedStatusOf, respondToPermissionRequest, seedPermissionRequest,
  settlePermissionRequest,
} from '../../web/src/stores/permission-request-store';

const SESSION = 'sess-perm-store';
const REQUEST = 'req-perm-store';

/** A rejection shaped like the api client's (`status` on the error). */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Never resolves until told — stands in for a held request. */
function held(): { promise: Promise<unknown>; settle: () => void } {
  let settle = (): void => {};
  const promise = new Promise((resolve) => { settle = () => resolve(undefined); });
  return { promise, settle };
}

beforeEach(() => {
  resetPermissionRequestStore();
  respondToPermission.mockReset();
  respondToPermission.mockResolvedValue({ status: 'resolved' });
});

describe('the optimistic flip', () => {
  it('settles every reader BEFORE the route answers', async () => {
    const { promise, settle } = held();
    respondToPermission.mockReturnValue(promise);

    const inFlight = respondToPermissionRequest(SESSION, REQUEST, true);

    // This is the whole point: a second surface reading the store right now
    // already sees the answer, with the request still on the wire.
    expect(getPermissionRequest(REQUEST)).toMatchObject({ status: 'allowed', inFlight: true });
    expect(isSettledPermission('allowed')).toBe(true);

    settle();
    await inFlight;
    expect(getPermissionRequest(REQUEST)).toMatchObject({ status: 'allowed', inFlight: false });
  });

  it('remembers what was answered, so a settled card can show it', async () => {
    const answers = { 'Which deployment?': 'Staging' };
    await respondToPermissionRequest(SESSION, REQUEST, true, { answers, optionId: 'allow_once' });

    expect(getPermissionRequest(REQUEST)).toMatchObject({
      status: 'allowed', answers, optionId: 'allow_once',
    });
    expect(respondToPermission).toHaveBeenCalledWith(
      SESSION, REQUEST, true, undefined, 'allow_once', answers,
    );
  });

  it('denies as denied, with the message that rode along', async () => {
    await respondToPermissionRequest(SESSION, REQUEST, false, { message: 'User dismissed the questions' });
    expect(getPermissionRequest(REQUEST)).toMatchObject({
      status: 'denied', message: 'User dismissed the questions',
    });
  });
});

describe('what a failure means', () => {
  for (const status of [404, 409]) {
    it(`${status} settles as stale — never as the user's Deny`, async () => {
      respondToPermission.mockRejectedValue(httpError(status));

      const outcome = await respondToPermissionRequest(SESSION, REQUEST, true);

      expect(outcome).toBe('stale');
      // The exact regression: the timeline card used to write 'denied' here, so a
      // request approved from the rail read "Denied" in the session.
      expect(getPermissionRequest(REQUEST)).toMatchObject({
        status: 'stale', inFlight: false, failed: false,
      });
    });
  }

  it('a transient failure rolls back to pending and flags it, so the user can retry', async () => {
    respondToPermission.mockRejectedValueOnce(httpError(503));

    expect(await respondToPermissionRequest(SESSION, REQUEST, true)).toBe('failed');
    expect(getPermissionRequest(REQUEST)).toMatchObject({
      status: 'pending', inFlight: false, failed: true,
    });

    // …and the retry is accepted (a zombie state would refuse it).
    respondToPermission.mockResolvedValueOnce({ status: 'resolved' });
    expect(await respondToPermissionRequest(SESSION, REQUEST, true)).toBe('allowed');
    expect(getPermissionRequest(REQUEST)).toMatchObject({ status: 'allowed', failed: false });
  });

  it('refuses a second click while one is in flight', async () => {
    const { promise, settle } = held();
    respondToPermission.mockReturnValue(promise);

    const first = respondToPermissionRequest(SESSION, REQUEST, true);
    expect(await respondToPermissionRequest(SESSION, REQUEST, false)).toBe('failed');
    expect(respondToPermission).toHaveBeenCalledTimes(1);

    settle();
    await first;
    expect(getPermissionRequest(REQUEST)?.status).toBe('allowed');
  });

  it('refuses to re-answer a settled request (whatever surface clicks)', async () => {
    await respondToPermissionRequest(SESSION, REQUEST, true);
    expect(await respondToPermissionRequest(SESSION, REQUEST, false)).toBe('allowed');
    expect(respondToPermission).toHaveBeenCalledTimes(1);
  });

  it('needs both ids — a legacy record with no requestId can never post', async () => {
    expect(await respondToPermissionRequest(SESSION, '', true)).toBe('failed');
    expect(await respondToPermissionRequest('', REQUEST, true)).toBe('failed');
    expect(respondToPermission).not.toHaveBeenCalled();
  });
});

describe('the server event lane', () => {
  it('reads a withdrawal from the flags, not from `allowed`', () => {
    // cancelled/expired also carry allowed:false, so reading the boolean first
    // labels the server's withdrawal as the user's Deny.
    expect(resolvedStatusOf({ allowed: false, cancelled: true })).toBe('expired');
    expect(resolvedStatusOf({ allowed: false, expired: true })).toBe('expired');
    expect(resolvedStatusOf({ allowed: false })).toBe('denied');
    expect(resolvedStatusOf({ allowed: true })).toBe('allowed');
    // No outcome at all is never stamped — it would block the later correct one.
    expect(resolvedStatusOf({})).toBeNull();
  });

  it('settles a request this browser never answered (another tab, the phone)', () => {
    seedPermissionRequest(REQUEST);
    expect(getPermissionRequest(REQUEST)).toMatchObject({ status: 'pending' });

    settlePermissionRequest(REQUEST, 'allowed');
    expect(getPermissionRequest(REQUEST)?.status).toBe('allowed');
  });

  it('never re-arms: a settled request cannot go back to pending', () => {
    settlePermissionRequest(REQUEST, 'denied');
    settlePermissionRequest(REQUEST, 'pending');
    expect(getPermissionRequest(REQUEST)?.status).toBe('denied');
  });

  it('keeps the answers when the event confirms our own optimistic stamp', async () => {
    const answers = { Question: 'Yes' };
    await respondToPermissionRequest(SESSION, REQUEST, true, { answers });
    settlePermissionRequest(REQUEST, 'allowed');
    expect(getPermissionRequest(REQUEST)).toMatchObject({ status: 'allowed', answers });
  });

  it('a re-ask of an UNRESOLVED request does not disturb an answer in flight', async () => {
    const { promise, settle } = held();
    respondToPermission.mockReturnValue(promise);
    const inFlight = respondToPermissionRequest(SESSION, REQUEST, true);

    // The CLI re-emits an unresolved ask every 60s; re-seeding it would re-arm the
    // buttons under the user while their answer was still on the wire.
    seedPermissionRequest(REQUEST);
    expect(getPermissionRequest(REQUEST)).toMatchObject({ status: 'allowed', inFlight: true });

    settle();
    await inFlight;
  });

  it('notifies subscribers on every transition', async () => {
    const { permissionRequestStore } = await import('../../web/src/stores/permission-request-store');
    const seen: string[] = [];
    const off = permissionRequestStore.subscribe(() => {
      seen.push(permissionRequestStore.get(REQUEST)?.status ?? 'gone');
    });

    seedPermissionRequest(REQUEST);
    await respondToPermissionRequest(SESSION, REQUEST, false);
    off();
    settlePermissionRequest(REQUEST, 'expired');

    expect(seen).toContain('pending');
    expect(seen).toContain('denied');
    // Unsubscribed: the last transition must not reach this listener.
    expect(seen.filter(s => s === 'expired')).toHaveLength(0);
  });
});
