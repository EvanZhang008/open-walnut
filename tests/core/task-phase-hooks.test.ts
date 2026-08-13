/**
 * Unit tests for the human-verified-auto-push hook — rewritten against the
 * unified hook system (the standalone task-phase-hooks module was folded in).
 *
 * Asserts the same four facts the old registry tests locked:
 *  1. the hook exists and targets HUMAN_VERIFIED
 *  2. its action is a send-message with the "User has verified" text
 *  3. it requires an active session
 *  4. priority 100, no fromPhases constraint
 */
import { describe, it, expect } from 'vitest';
import { builtinTaskHooks } from '../../src/core/session-hooks/builtins-task.js';
import { describeAction, type HookAction } from '../../src/core/hooks/actions.js';

const hook = builtinTaskHooks.find(h => h.id === 'human-verified-auto-push');

describe('human-verified-auto-push (unified hook system)', () => {
  it('exists and triggers on onTaskPhaseChanged into HUMAN_VERIFIED', () => {
    expect(hook).toBeDefined();
    expect(hook!.hooks).toEqual(['onTaskPhaseChanged']);
    expect(hook!.filter?.phases).toEqual(['HUMAN_VERIFIED']);
  });

  it('sends the code-review + commit instruction to the session', () => {
    expect(hook!.action?.type).toBe('send_message_to_session');
    const detail = describeAction(hook!.action as HookAction);
    expect(detail).toMatch(/^Send message: "/);
    expect(detail).toContain('User has verified');
  });

  it('requires an active session and only fires for human sources', () => {
    expect(hook!.filter?.requiresSession).toBe(true);
    // 'agent' deliberately absent: an agent marking its own task HUMAN_VERIFIED
    // must not receive synthetic user approval to auto-commit.
    expect(hook!.filter?.sources).toEqual(['api', 'user']);
  });

  it('priority 100, no fromPhases constraint', () => {
    expect(hook!.priority).toBe(100);
    expect(hook!.filter?.fromPhases).toBeUndefined();
  });
});
