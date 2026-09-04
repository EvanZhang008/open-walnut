/**
 * "The current session" store (web/src/stores/active-session.ts): last panel the
 * user touched wins, the open strip bounds it, drafts never qualify.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getActiveSessionId, setActiveSession, reconcileActiveSession, subscribeActiveSession, __resetActiveSession,
} from '@/stores/active-session';

const A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('active session store', () => {
  beforeEach(() => __resetActiveSession());

  it('starts empty; the leftmost real column stands in once the strip is known', () => {
    expect(getActiveSessionId()).toBeNull();
    reconcileActiveSession(['draft:new-session:x', A, B]);
    expect(getActiveSessionId()).toBe(A);
  });

  it('the panel the user touched wins over the leftmost, and survives reconciles while open', () => {
    reconcileActiveSession([A, B]);
    setActiveSession(B);
    expect(getActiveSessionId()).toBe(B);
    reconcileActiveSession([A, B]);
    expect(getActiveSessionId()).toBe(B);
  });

  it('closing the active column falls back to the leftmost real one; an empty strip → null', () => {
    reconcileActiveSession([A, B]);
    setActiveSession(B);
    reconcileActiveSession([A]);
    expect(getActiveSessionId()).toBe(A);
    reconcileActiveSession(['draft:new-session:x']);
    expect(getActiveSessionId()).toBeNull();
  });

  it('draft / placeholder ids are never the target', () => {
    setActiveSession('draft:new-session:x');
    expect(getActiveSessionId()).toBeNull();
    setActiveSession('pending:abc');
    expect(getActiveSessionId()).toBeNull();
  });

  it('notifies only on change', () => {
    let n = 0;
    const off = subscribeActiveSession(() => { n++; });
    setActiveSession(A);
    setActiveSession(A);
    reconcileActiveSession([A]);
    expect(n).toBe(1);
    off();
  });
});
