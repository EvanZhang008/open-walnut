/**
 * Server half of "show the launch prompt at once": the registry that
 * session:get-queue reads (src/core/sessions/launch-prompts.ts), driven through
 * the real event bus.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bus, EventNames } from '../../src/core/event-bus';
import {
  clearLaunchPrompts, forgetLaunchPrompt, launchPromptFor, launchPromptOfStart,
  noteLaunchPrompt, startLaunchPromptRegistry,
} from '../../src/core/sessions/launch-prompts';

const SID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => { clearLaunchPrompts(); });
afterEach(() => { bus.unsubscribe('launch-prompts'); clearLaunchPrompts(); });

describe('launch prompt registry', () => {
  it('holds the prompt under a stable id and forgets it on demand', () => {
    noteLaunchPrompt(SID, 'who owns the VM?', 1_000);
    const p = launchPromptFor(SID, 2_000);
    expect(p).toEqual({ id: `launch-${SID}`, text: 'who owns the VM?', at: new Date(1_000).toISOString() });
    expect(launchPromptFor(SID, 3_000)).toEqual(p);
    forgetLaunchPrompt(SID);
    expect(launchPromptFor(SID)).toBeUndefined();
  });

  it('expires after its TTL', () => {
    noteLaunchPrompt(SID, 'x', 0);
    expect(launchPromptFor(SID, 29 * 60_000)).toBeDefined();
    expect(launchPromptFor(SID, 31 * 60_000)).toBeUndefined();
  });

  it('keeps nothing for an empty or oversized prompt', () => {
    noteLaunchPrompt(SID, '   ');
    expect(launchPromptFor(SID)).toBeUndefined();
    noteLaunchPrompt(SID, 'x'.repeat(100_001));
    expect(launchPromptFor(SID)).toBeUndefined();
  });

  it('is capped, evicting the oldest launch', () => {
    for (let i = 0; i < 205; i++) noteLaunchPrompt(`sid-${i}`, `m${i}`);
    expect(launchPromptFor('sid-0')).toBeUndefined();
    expect(launchPromptFor('sid-4')).toBeUndefined();
    expect(launchPromptFor('sid-5')?.text).toBe('m5');
    expect(launchPromptFor('sid-204')?.text).toBe('m204');
  });
});

describe('which starts are recorded', () => {
  it('a native start with a pre-assigned id, named by the human words', () => {
    expect(launchPromptOfStart({ message: '[persona]\n\nhello', namingMessage: 'hello', preassignedSessionId: SID }))
      .toEqual({ sessionId: SID, text: 'hello' });
    expect(launchPromptOfStart({ message: 'plain', preassignedSessionId: SID })).toEqual({ sessionId: SID, text: 'plain' });
  });

  it('not an ACP start (no id yet), a fork, a side-thread lane, or an init-only spawn', () => {
    expect(launchPromptOfStart({ message: 'hi' })).toBeNull();
    expect(launchPromptOfStart({ message: 'hi', preassignedSessionId: SID, forkedFromSessionId: 'parent' })).toBeNull();
    expect(launchPromptOfStart({ message: 'hi', preassignedSessionId: SID, lane: 'side:parent:q1' })).toBeNull();
    expect(launchPromptOfStart({ message: '', preassignedSessionId: SID })).toBeNull();
  });
});

describe('bus wiring', () => {
  it('records on session:start synchronously and forgets on the first result', () => {
    startLaunchPromptRegistry();
    bus.emit(EventNames.SESSION_START, { taskId: 't1', message: 'first words', preassignedSessionId: SID }, ['session-runner']);
    // Synchronous: the launch's HTTP answer (and the panel it opens) comes after emit returns.
    expect(launchPromptFor(SID)?.text).toBe('first words');

    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'someone-else', result: 'x' }, ['web-ui']);
    expect(launchPromptFor(SID)).toBeDefined();
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'done' }, ['web-ui']);
    expect(launchPromptFor(SID)).toBeUndefined();
  });

  it('forgets on session:ended and session:deleted', () => {
    startLaunchPromptRegistry();
    bus.emit(EventNames.SESSION_START, { taskId: 't1', message: 'a', preassignedSessionId: SID }, ['session-runner']);
    bus.emit(EventNames.SESSION_ENDED, { sessionId: SID }, ['web-ui']);
    expect(launchPromptFor(SID)).toBeUndefined();

    bus.emit(EventNames.SESSION_START, { taskId: 't1', message: 'b', preassignedSessionId: SID }, ['session-runner']);
    bus.emit(EventNames.SESSION_DELETED, { sessionIds: [SID] }, ['web-ui']);
    expect(launchPromptFor(SID)).toBeUndefined();
  });

  it('a second registration replaces the first (one entry per start)', () => {
    startLaunchPromptRegistry();
    startLaunchPromptRegistry();
    bus.emit(EventNames.SESSION_START, { taskId: 't1', message: 'once', preassignedSessionId: SID }, ['session-runner']);
    expect(launchPromptFor(SID)?.text).toBe('once');
  });
});
