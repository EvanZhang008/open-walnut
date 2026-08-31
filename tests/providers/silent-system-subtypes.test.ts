/**
 * Which stream-json `system` subtypes are allowed to become a UI card.
 *
 * The catch-all that forwards every unknown subtype is deliberate (it is how a new
 * CLI event type gets noticed instead of vanishing), but it was forwarding pure
 * bookkeeping too. `commands_changed` fires whenever the model edits
 * `.claude/commands/**` or a skill, and a card interrupts the model's text where it
 * lands: one arriving mid-attribute split a sentence into an empty coloured pill
 * plus `px">…` as prose (inc-1788209680147, reported with a screenshot).
 *
 * Two things are pinned here, both cheap and both real:
 *   · the reported subtype is silenced, and the list stays SHORT (an unknown
 *     subtype must still surface, or the catch-all loses its whole purpose);
 *   · every silenced subtype also reads as bookkeeping to the RECONCILER, which
 *     classifies the same lines for a different decision (does this prove a live
 *     turn). Two lists, one judgement — if they drift, one of the two is wrong.
 */
import { describe, it, expect } from 'vitest';
import { SILENT_SYSTEM_SUBTYPES } from '../../src/providers/claude-code-session.js';
import { isPostTurnBookkeeping } from '../../src/core/session-reconcile.js';

describe('SILENT_SYSTEM_SUBTYPES', () => {
  it('silences the reported subtype', () => {
    expect(SILENT_SYSTEM_SUBTYPES.has('commands_changed')).toBe(true);
  });

  it('does NOT silence subtypes that carry meaning for a reader', () => {
    // compact_boundary and errors are handled before the catch-all; these are the
    // ones a reader (or a future debugging session) genuinely wants to see.
    for (const subtype of ['compact_boundary', 'post_turn_summary', 'task_summary', 'api_retry', 'some_new_2027_subtype']) {
      expect(SILENT_SYSTEM_SUBTYPES.has(subtype), `${subtype} must still surface`).toBe(false);
    }
  });

  it('stays short — the catch-all is the point', () => {
    expect(SILENT_SYSTEM_SUBTYPES.size).toBeLessThanOrEqual(4);
  });

  it('every silenced subtype also reads as bookkeeping to the reconciler', () => {
    for (const subtype of SILENT_SYSTEM_SUBTYPES) {
      expect(isPostTurnBookkeeping({ subtype }, 'system'), `${subtype} disagrees with the reconciler`).toBe(true);
    }
  });

  it('the reconciler still treats real activity as activity (control case)', () => {
    // Guards the assertion above from passing because isPostTurnBookkeeping says
    // "true" to everything.
    expect(isPostTurnBookkeeping({ subtype: 'init' }, 'system')).toBe(false);
    expect(isPostTurnBookkeeping({ subtype: 'thinking_tokens' }, 'system')).toBe(false);
  });
});
