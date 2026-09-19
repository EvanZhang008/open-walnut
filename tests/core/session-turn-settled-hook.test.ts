/**
 * `session:turn-settled` reaches the turn-end hooks.
 *
 * A daemon snapshot can end a turn (running → idle) while no live runner
 * reports its `session:result` (the server was restarting or detached when the
 * CLI finished). Hooks derive from `session:result`, so that turn's self-report,
 * auto-title and cwd check used to never run: the recap tip and the task note
 * stayed one turn behind until the next turn (session 145318ca, 2026-09-19).
 * The projection now emits `session:turn-settled`, and the derivation below maps
 * it to the same hook point a real result reaches.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventNames } from '../../src/core/event-bus.js';
import { deriveSessionHookPoints } from '../../src/core/session-hooks/derive/session.js';

const SID = 'settled-session';

describe('deriveSessionHookPoints: session:turn-settled', () => {
  it('maps to onTurnComplete with an empty result (the snapshot carries no text)', () => {
    const states = new Map();
    const points = deriveSessionHookPoints(
      { name: EventNames.SESSION_TURN_SETTLED, data: { sessionId: SID, taskId: 't1', source: 'pull-30s', v: 900 } } as never,
      states, vi.fn(),
    );
    expect(points).toHaveLength(1);
    expect(points[0]!.hookPoint).toBe('onTurnComplete');
    expect(points[0]!.extraPayload).toMatchObject({ result: '', isPlanSession: false });
    expect(points[0]!.extraPayload).toHaveProperty('turnIndex');
  });

  it('a settled turn of a plan-mode session is flagged like a real result would be', () => {
    const states = new Map();
    deriveSessionHookPoints(
      { name: EventNames.SESSION_STATUS_CHANGED, data: { sessionId: SID, mode: 'plan' } } as never,
      states, vi.fn(),
    );
    // The mode is remembered per session; a first status event only seeds it.
    const state = states.get(SID) as { lastMode?: string } | undefined;
    if (state) state.lastMode = 'plan';
    const points = deriveSessionHookPoints(
      { name: EventNames.SESSION_TURN_SETTLED, data: { sessionId: SID, source: 'daemon-push', v: 1 } } as never,
      states, vi.fn(),
    );
    expect(points[0]!.extraPayload).toMatchObject({ isPlanSession: true });
  });
});
