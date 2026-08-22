/**
 * The edge gate behind error-notification recovery.
 *
 * Why it exists at all: every success point that retires an error card is a poll
 * (git 30s, plugin sync 30s per plugin, backup 60s). Signalling recovery on every
 * healthy tick would mean a locked read-modify-write scan of notifications.json
 * forever on a healthy box, to change nothing. These tests pin the three cases
 * that make the difference: the edge fires, a steady healthy run does not, and a
 * never-failed key does not fire on its first healthy observation.
 */
import { describe, it, expect } from 'vitest';
import { createRecoveryTransitionTracker } from '../../../src/core/notifications/recovery-transition.js';

describe('createRecoveryTransitionTracker', () => {
  it('fires on the failing → healthy edge, exactly once', () => {
    const t = createRecoveryTransitionTracker();
    expect(t.observe('git', true)).toBe(false);  // first failure
    expect(t.observe('git', true)).toBe(false);  // still failing
    expect(t.observe('git', false)).toBe(true);  // recovered → fire
    expect(t.observe('git', false)).toBe(false); // steady healthy → silent
    expect(t.observe('git', false)).toBe(false);
  });

  it('does NOT fire on a first-ever healthy observation', () => {
    // The common case by far: a box that has never failed. Firing here would
    // scan the store on every server boot for nothing.
    const t = createRecoveryTransitionTracker();
    expect(t.observe('backup', false)).toBe(false);
  });

  it('tracks keys independently', () => {
    const t = createRecoveryTransitionTracker();
    t.observe('plugin:plugin-a', true);
    // plugin-b was never failing, so its healthy tick is not a recovery…
    expect(t.observe('plugin:plugin-b', false)).toBe(false);
    // …while plugin-a's is.
    expect(t.observe('plugin:plugin-a', false)).toBe(true);
  });

  it('re-arms across repeated failure episodes', () => {
    const t = createRecoveryTransitionTracker();
    for (let episode = 0; episode < 3; episode++) {
      expect(t.observe('disk', true)).toBe(false);
      expect(t.observe('disk', false)).toBe(true);
    }
  });

  it('reset() forgets state, so the next healthy tick is not an edge', () => {
    const t = createRecoveryTransitionTracker();
    t.observe('git', true);
    t.reset();
    expect(t.observe('git', false)).toBe(false);
  });

  /**
   * isFailing/forget exist for the HOT-path callers (the HTTP request logger runs
   * per request, the session-result handler per turn). `observe(key, false)` would
   * insert a healthy entry for every route in the table and every session id the
   * box ever saw, to remember something that can never fire.
   */
  describe('hot-path guards', () => {
    it('isFailing reports the failing side WITHOUT inserting anything', () => {
      const t = createRecoveryTransitionTracker();
      // A key that has never been observed is not failing, and asking must not
      // create it — otherwise the pre-check is the very leak it exists to avoid.
      expect(t.isFailing('route:GET /api/x')).toBe(false);
      // Proof it wasn't inserted: a later healthy observe is still not an edge.
      expect(t.observe('route:GET /api/x', false)).toBe(false);
    });

    it('isFailing flips with observe', () => {
      const t = createRecoveryTransitionTracker();
      t.observe('route:GET /api/x', true);
      expect(t.isFailing('route:GET /api/x')).toBe(true);
      t.observe('route:GET /api/x', false);
      expect(t.isFailing('route:GET /api/x')).toBe(false);
    });

    it('forget drops the key, so nothing is retained for an unbounded key space', () => {
      // The session-id case: after the recovery edge has fired there is nothing
      // left to remember, and one healthy entry per session would leak for the
      // life of the process.
      const t = createRecoveryTransitionTracker();
      t.observe('session:sess-1', true);
      t.forget('session:sess-1');
      expect(t.isFailing('session:sess-1')).toBe(false);
      // Re-arms from scratch on a later failure.
      t.observe('session:sess-1', true);
      expect(t.observe('session:sess-1', false)).toBe(true);
    });

    it('the guarded pattern signals exactly once per failure episode', () => {
      // What the request logger and the session-result handler both do.
      const t = createRecoveryTransitionTracker();
      const signals: string[] = [];
      const onHealthy = (key: string) => {
        if (!t.isFailing(key)) return;   // healthy traffic: one Map.get, no alloc
        t.forget(key);
        signals.push(key);
      };

      for (let i = 0; i < 50; i++) onHealthy('route:GET /api/x'); // never failed
      expect(signals).toEqual([]);

      t.observe('route:GET /api/x', true);
      for (let i = 0; i < 50; i++) onHealthy('route:GET /api/x');
      expect(signals).toEqual(['route:GET /api/x']); // exactly one, not fifty
    });
  });
});
