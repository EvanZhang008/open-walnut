import { describe, it, expect, beforeEach } from 'vitest';
import { recordCrash, clearPersistedUiState, SKIP_PREFS_MERGE_FLAG } from '../../web/src/utils/crash-recovery';

class FakeStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

describe('crash-recovery', () => {
  let session: FakeStorage;
  let local: FakeStorage;
  let now: number;

  beforeEach(() => {
    session = new FakeStorage();
    local = new FakeStorage();
    now = 1000000;
  });

  function deps() {
    return { session: session as unknown as Storage, local: local as unknown as Storage, now: () => now };
  }

  it('first crash → none', () => {
    expect(recordCrash(deps())).toBe('none');
  });

  it('second crash within window → soft', () => {
    recordCrash(deps());
    now += 5000;
    expect(recordCrash(deps())).toBe('soft');
  });

  it('third crash within window → hard', () => {
    recordCrash(deps());
    now += 5000;
    recordCrash(deps());
    now += 5000;
    expect(recordCrash(deps())).toBe('hard');
  });

  it('fourth crash → give-up', () => {
    recordCrash(deps());
    now += 3000;
    recordCrash(deps());
    now += 3000;
    recordCrash(deps());
    now += 3000;
    expect(recordCrash(deps())).toBe('give-up');
  });

  it('crash outside window resets count', () => {
    recordCrash(deps());
    now += 5000;
    recordCrash(deps()); // soft
    now += 120000; // well past 60s window
    expect(recordCrash(deps())).toBe('none');
  });

  describe('clearPersistedUiState', () => {
    it('soft: clears session, preserves crash log', () => {
      session.setItem('open-walnut-home-focused-task', 'task123');
      session.setItem('open-walnut-crash-log', '[1000]');
      clearPersistedUiState(false, deps());
      expect(session.getItem('open-walnut-home-focused-task')).toBeNull();
      expect(session.getItem('open-walnut-crash-log')).toBe('[1000]');
    });

    it('hard: also clears walnut localStorage keys and sets skip flag', () => {
      local.setItem('open-walnut-col-split', '50');
      local.setItem('walnut-todo-sortBy', 'priority');
      local.setItem('walnut.deviceToken', 'tok_123');
      session.setItem('some-session-thing', 'x');
      clearPersistedUiState(true, deps());
      expect(local.getItem('open-walnut-col-split')).toBeNull();
      expect(local.getItem('walnut-todo-sortBy')).toBeNull();
      expect(local.getItem('walnut.deviceToken')).toBe('tok_123');
      expect(session.getItem(SKIP_PREFS_MERGE_FLAG)).toBe('1');
    });
  });
});
