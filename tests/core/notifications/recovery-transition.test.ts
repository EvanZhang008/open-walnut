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
});
