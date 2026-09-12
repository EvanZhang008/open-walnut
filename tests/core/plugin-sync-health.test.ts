import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSyncSuccess,
  recordSyncFailure,
  getSyncHealth,
  decideSyncFailureNotice,
  decideConnectionNotice,
  REPEATING_THRESHOLD,
  _resetSyncHealthForTesting,
} from '../../src/core/plugin-sync-health.js';

class AuthErr extends Error {
  authKind: 'sign-in-required' | 'unreachable' | 'not-configured';
  authCode?: string;
  constructor(kind: AuthErr['authKind'], message: string, code?: string) {
    super(message);
    this.authKind = kind;
    if (code) this.authCode = code;
  }
}

beforeEach(() => _resetSyncHealthForTesting());

describe('sync health record', () => {
  it('counts a streak, remembers the kind, and a success clears both', () => {
    recordSyncFailure('p', new AuthErr('unreachable', 'ETIMEDOUT', 'network_error'));
    recordSyncFailure('p', new Error('plain'));
    let h = getSyncHealth('p')!;
    expect(h.consecutiveFailures).toBe(2);
    // The kind follows the LATEST failure; a plain error clears it.
    expect(h.lastFailureKind).toBeUndefined();
    expect(h.lastError).toBe('plain');
    expect(h.lastFailureAt).toBeTruthy();

    recordSyncFailure('p', new AuthErr('sign-in-required', 'dead\nsecond line', 'invalid_grant'));
    h = getSyncHealth('p')!;
    expect(h.lastFailureKind).toBe('sign-in-required');
    expect(h.lastError).toBe('dead');

    recordSyncSuccess('p');
    h = getSyncHealth('p')!;
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastFailureKind).toBeUndefined();
    expect(h.lastOkAt).toBeTruthy();
    // The last failure is history worth keeping on the panel.
    expect(h.lastFailureAt).toBeTruthy();
  });

  it('returns a copy, not the live entry', () => {
    recordSyncFailure('p', new Error('x'));
    const a = getSyncHealth('p')!;
    a.consecutiveFailures = 99;
    expect(getSyncHealth('p')!.consecutiveFailures).toBe(1);
  });

  it('is undefined for a plugin that never ticked', () => {
    expect(getSyncHealth('nope')).toBeUndefined();
  });
});

describe('decideSyncFailureNotice', () => {
  it('sign-in-required: a card on the FIRST failure, with a Sign in button and no retry advice', () => {
    const err = new AuthErr('sign-in-required', 'Microsoft To-Do needs you to sign in again', 'invalid_grant');
    const n = decideSyncFailureNotice('Microsoft To-Do', 'ms-todo', err, { consecutiveFailures: 1 });
    expect(n.level).toBe('sign-in');
    expect(n.title).toBe('Microsoft To-Do needs you to sign in again');
    expect(n.body).toContain('invalid_grant');
    expect(n.body).toContain('retrying will not fix this');
    expect(n.action).toEqual({ label: 'Sign in', to: '/settings#plugin-store' });
    expect(n.code).toBe('invalid_grant');
  });

  it('unreachable: quiet below the threshold, then an outage card that says the sign-in is fine', () => {
    const err = new AuthErr('unreachable', 'token endpoint 503', 'service_unavailable');
    for (let i = 1; i < REPEATING_THRESHOLD; i++) {
      expect(decideSyncFailureNotice('Microsoft To-Do', 'ms-todo', err, { consecutiveFailures: i }).level).toBe('none');
    }
    const n = decideSyncFailureNotice('Microsoft To-Do', 'ms-todo', err, { consecutiveFailures: REPEATING_THRESHOLD });
    expect(n.level).toBe('repeating');
    expect(n.title).toBe('Microsoft To-Do sync keeps failing');
    expect(n.body).toContain('Your sign-in is fine');
    expect(n.body).toContain(`${REPEATING_THRESHOLD} attempts`);
    expect(n.body).not.toMatch(/sign in again|auth/i);
    expect(n.action).toBeUndefined();
  });

  it('unclassified: same threshold, the error line as the body, no sign-in advice', () => {
    const err = new Error('Graph API GET /me/todo/lists returned 500: boom\n  at x');
    expect(decideSyncFailureNotice('Acme', 'acme', err, { consecutiveFailures: 2 }).level).toBe('none');
    const n = decideSyncFailureNotice('Acme', 'acme', err, { consecutiveFailures: 7 });
    expect(n.level).toBe('repeating');
    expect(n.body).toBe('7 sync attempts in a row have failed: Graph API GET /me/todo/lists returned 500: boom');
    expect(n.action).toBeUndefined();
  });

  it('not-configured: one card pointing at Settings, immediately', () => {
    const err = new AuthErr('not-configured', 'Microsoft To-Do has no client_id yet.');
    const n = decideSyncFailureNotice('Microsoft To-Do', 'ms-todo', err, { consecutiveFailures: 1 });
    expect(n.level).toBe('not-configured');
    expect(n.title).toBe('Microsoft To-Do is not set up yet');
    expect(n.body).toBe('Microsoft To-Do has no client_id yet.');
    expect(n.action?.label).toBe('Open Settings');
  });

  it('a non-Error throw is still classified (as unclassified) and rendered', () => {
    const n = decideSyncFailureNotice('Acme', 'acme', 'stringy', { consecutiveFailures: REPEATING_THRESHOLD });
    expect(n.level).toBe('repeating');
    expect(n.body).toContain('stringy');
  });
});

describe('decideConnectionNotice', () => {
  it('raises the sign-in card once while the state stays sign-in-required, then recovers when it leaves', () => {
    const watch = { noticed: false };
    const first = decideConnectionNotice('Microsoft To-Do', 'ms-todo', {
      state: 'sign-in-required', detail: 'Microsoft refused to renew the credential (invalid_grant). Sync still works until 14:32; sign in before then.',
    }, watch);
    expect(first.notice?.level).toBe('sign-in');
    expect(first.notice?.title).toBe('Microsoft To-Do needs you to sign in again');
    // The plugin's own sentence is the body: it knows until when sync still works.
    expect(first.notice?.body).toContain('until 14:32');
    expect(first.notice?.action).toEqual({ label: 'Sign in', to: '/settings#plugin-store' });
    expect(watch.noticed).toBe(true);

    // Same state again: nothing new to say.
    const again = decideConnectionNotice('Microsoft To-Do', 'ms-todo', { state: 'sign-in-required' }, watch);
    expect(again.notice).toBeUndefined();
    expect(again.recovered).toBe(false);

    // The human is mid-flow: the card stays up.
    const mid = decideConnectionNotice('Microsoft To-Do', 'ms-todo', { state: 'signing-in' }, watch);
    expect(mid.notice).toBeUndefined();
    expect(mid.recovered).toBe(false);
    expect(watch.noticed).toBe(true);

    // Signed in: retire the card.
    const done = decideConnectionNotice('Microsoft To-Do', 'ms-todo', { state: 'connected' }, watch);
    expect(done.recovered).toBe(true);
    expect(watch.noticed).toBe(false);

    // Healthy and nothing was up: nothing to recover either.
    expect(decideConnectionNotice('Microsoft To-Do', 'ms-todo', { state: 'connected' }, watch).recovered).toBe(false);
  });

  it('falls back to a generic body when the plugin gave no detail, and ignores a missing status', () => {
    const watch = { noticed: false };
    const n = decideConnectionNotice('Acme', 'acme', { state: 'sign-in-required' }, watch);
    expect(n.notice?.body).toBe('Acme could not renew its credential. Sign in again before sync stops.');
    expect(decideConnectionNotice('Acme', 'acme', null, { noticed: true })).toEqual({ recovered: false });
  });
});
