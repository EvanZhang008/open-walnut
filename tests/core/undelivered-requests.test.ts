/**
 * Which queued row carries which peer ask, and which park reasons prove the
 * message never ran (sessions/undelivered-requests.ts). Pure: no store.
 */
import { describe, it, expect } from 'vitest';
import { buildWalnutMessage } from '../../src/core/peers/walnut-message-tag.js';
import {
  isHeldElsewhereReason, parkByStop, parkMeansNeverRan, peerAskOf, requestIdOf,
} from '../../src/core/sessions/undelivered-requests.js';
import { SessionHeldElsewhereError } from '../../src/providers/delivery-failure.js';

const ask = (request: string) => buildWalnutMessage({
  kind: 'peer-note', attrs: { from: 'Lead [abc]', 'from-task': 'task-lead', request, note: 'n' }, body: 'Go ahead with the plan.',
});
const notice = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'moved', note: 'automated' }, body: 'Your task moved.' });

describe('peerAskOf / requestIdOf', () => {
  it('finds the ask behind Walnut notices riding in front of it in the same row', () => {
    const row = { message: `${notice}\n\n${notice}\n\n${ask('rq-0123456789ab')}` };
    expect(requestIdOf(row)).toBe('rq-0123456789ab');
    expect(peerAskOf(row)).toEqual({ requestId: 'rq-0123456789ab', fromTask: 'task-lead' });
  });
  it('a row with no peer ask, or a malformed id, carries no request', () => {
    expect(requestIdOf({ message: notice })).toBeUndefined();
    expect(requestIdOf({ message: 'plain text from the console' })).toBeUndefined();
    expect(requestIdOf({ message: ask('rq-NOT-HEX') })).toBeUndefined();
  });
});

describe('park reasons', () => {
  it('a refusal, a CLI that died loading the session, a paused budget or a missing directory never ran', () => {
    for (const reason of [
      new SessionHeldElsewhereError('devbox', 'session_live', 4087, 'terminal').message,
      new SessionHeldElsewhereError('devbox', 'session_live', 9, 'walnut').message,
      'Not delivered: Claude Code exited with code 1 while resuming this session, before it read this message.',
      'Not sent: the session budget is paused. Raise or remove the limit, then retry.',
      'working directory no longer exists: /work/gone',
    ]) expect(parkMeansNeverRan(reason), reason).toBe(true);
  });
  it('a Stop is the user\'s choice, and an unknown or empty reason proves nothing', () => {
    expect(parkMeansNeverRan('Session stopped by user; retry explicitly to send')).toBe(false);
    expect(parkByStop('Session stopped by user; retry explicitly to send')).toBe(true);
    expect(parkByStop('The session ended before Claude Code ran this message')).toBe(true);
    expect(parkMeansNeverRan('delivery failed')).toBe(false);
    expect(parkMeansNeverRan(undefined)).toBe(false);
  });
  it('only the held-elsewhere words count as the session being in use', () => {
    expect(isHeldElsewhereReason(new SessionHeldElsewhereError('devbox', 'session_live', 4087, 'terminal').message)).toBe(true);
    expect(isHeldElsewhereReason(new SessionHeldElsewhereError('devbox', 'session_live', undefined, 'walnut').message)).toBe(true);
    expect(isHeldElsewhereReason(new SessionHeldElsewhereError('devbox', 'session_other_walnut').message)).toBe(false);
    expect(isHeldElsewhereReason('Not delivered: Claude Code exited with code 1 while resuming this session')).toBe(false);
    expect(isHeldElsewhereReason(undefined)).toBe(false);
  });
});
