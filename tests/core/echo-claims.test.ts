/**
 * Echo-claim registry (Phase 1, ACP dialect): binds walnut `qm-…` queue ids
 * to the CLI's canonical user-echo lines so the frontend's optimistic dedup
 * can consume bubbles by EXACT id instead of the fuzzy text window.
 *
 * Rules pinned here:
 *  - FIFO claim order: the FIRST unclaimed matching user message binds.
 *  - A message binds at most one claim (boundMsgIds multiset guard).
 *  - Timestamp guard: never bind to a user message older than the claim
 *    (identical short texts recur across old turns).
 *  - Bindings survive re-parses (history rebuilds messages every read).
 *  - Unmatched claims stay pending (echo may not be flushed yet).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerEchoClaims,
  revokeEchoClaims,
  bindEchoClaims,
  clearEchoClaims,
  _resetEchoClaimsForTest,
  type EchoBindableMessage,
} from '../../src/core/echo-claims.js';

const SID = 'echo-test-session';

function userMsg(text: string, msgId: string, tsOffsetMs = 0): EchoBindableMessage {
  return {
    role: 'user',
    text,
    timestamp: new Date(Date.now() + tsOffsetMs).toISOString(),
    msgId,
  };
}

beforeEach(() => {
  _resetEchoClaimsForTest();
});

describe('echo-claims', () => {
  it('binds a claim to the matching user echo and stamps walnutMessageId', () => {
    registerEchoClaims(SID, ['qm-1'], 'hello world');
    const messages = [userMsg('hello world', 'uuid-a')];
    bindEchoClaims(SID, messages);
    expect(messages[0].walnutMessageId).toBe('qm-1');
  });

  it('is a no-op for sessions with no claims', () => {
    const messages = [userMsg('hello', 'uuid-a')];
    bindEchoClaims(SID, messages);
    expect(messages[0].walnutMessageId).toBeUndefined();
  });

  it('binds claims in FIFO order to distinct echoes of identical text', () => {
    registerEchoClaims(SID, ['qm-1'], 'continue');
    registerEchoClaims(SID, ['qm-2'], 'continue');
    const messages = [
      userMsg('continue', 'uuid-a', 1000),
      userMsg('continue', 'uuid-b', 2000),
    ];
    bindEchoClaims(SID, messages);
    expect(messages[0].walnutMessageId).toBe('qm-1');
    expect(messages[1].walnutMessageId).toBe('qm-2');
  });

  it('never binds to a user message that predates the claim (old identical text)', () => {
    // A message from an OLD turn, well before the claim was registered.
    const old = userMsg('continue', 'uuid-old', -10 * 60 * 1000); // 10 min ago
    registerEchoClaims(SID, ['qm-1'], 'continue');
    bindEchoClaims(SID, [old]);
    expect(old.walnutMessageId).toBeUndefined();
    // The claim stays pending — a fresh echo later still binds.
    const fresh = userMsg('continue', 'uuid-new', 1000);
    bindEchoClaims(SID, [old, fresh]);
    expect(old.walnutMessageId).toBeUndefined();
    expect(fresh.walnutMessageId).toBe('qm-1');
  });

  it('re-stamps bindings on re-parse (history rebuilds message objects each read)', () => {
    registerEchoClaims(SID, ['qm-1'], 'hello');
    const first = [userMsg('hello', 'uuid-a')];
    bindEchoClaims(SID, first);
    expect(first[0].walnutMessageId).toBe('qm-1');
    // Fresh objects, same msgId — as a re-read produces.
    const second = [userMsg('hello', 'uuid-a')];
    bindEchoClaims(SID, second);
    expect(second[0].walnutMessageId).toBe('qm-1');
  });

  it('a bound message never satisfies a second claim', () => {
    registerEchoClaims(SID, ['qm-1'], 'hi');
    const messages = [userMsg('hi', 'uuid-a')];
    bindEchoClaims(SID, messages);
    registerEchoClaims(SID, ['qm-2'], 'hi');
    bindEchoClaims(SID, messages);
    // qm-2 stays pending until a NEW echo appears.
    expect(messages[0].walnutMessageId).toBe('qm-1');
    const later = userMsg('hi', 'uuid-b', 2000);
    const all = [...messages, later];
    bindEchoClaims(SID, all);
    expect(later.walnutMessageId).toBe('qm-2');
  });

  it('uses qmIds[0] for a combined multi-message batch (single echo line)', () => {
    registerEchoClaims(SID, ['qm-1', 'qm-2'], 'first\n\nsecond');
    const messages = [userMsg('first\n\nsecond', 'uuid-a')];
    bindEchoClaims(SID, messages);
    expect(messages[0].walnutMessageId).toBe('qm-1');
  });

  it('skips assistant messages and pre-stamped synthetic user events', () => {
    registerEchoClaims(SID, ['qm-1'], 'hello');
    const synthetic: EchoBindableMessage = {
      role: 'user', text: 'hello',
      timestamp: new Date().toISOString(),
      msgId: 'uuid-synth', walnutMessageId: 'qm-other',
    };
    const assistant: EchoBindableMessage = {
      role: 'assistant', text: 'hello',
      timestamp: new Date().toISOString(), msgId: 'msg_x',
    };
    const real = userMsg('hello', 'uuid-real', 1000);
    bindEchoClaims(SID, [synthetic, assistant, real]);
    expect(synthetic.walnutMessageId).toBe('qm-other');
    expect(assistant.walnutMessageId).toBeUndefined();
    expect(real.walnutMessageId).toBe('qm-1');
  });

  it('clearEchoClaims drops all state for the session', () => {
    registerEchoClaims(SID, ['qm-1'], 'hello');
    clearEchoClaims(SID);
    const messages = [userMsg('hello', 'uuid-a')];
    bindEchoClaims(SID, messages);
    expect(messages[0].walnutMessageId).toBeUndefined();
  });

  it('text must match exactly (after trim) — different text never binds', () => {
    registerEchoClaims(SID, ['qm-1'], 'deploy the fix');
    const messages = [userMsg('deploy the fix please', 'uuid-a', 1000)];
    bindEchoClaims(SID, messages);
    expect(messages[0].walnutMessageId).toBeUndefined();
    const exact = userMsg('  deploy the fix  ', 'uuid-b', 2000);
    bindEchoClaims(SID, [exact]);
    expect(exact.walnutMessageId).toBe('qm-1');
  });

  // ── REGRESSION inc-1785091339102: failed batch's claim stole the Retry's echo ──
  // A failed delivery leaves an unbound claim. The user hits Retry, which re-sends
  // the SAME text under a NEW qm id. FIFO text-match binding handed the retry's
  // echo line to the DEAD claim, so the live bubble never got its walnutMessageId
  // and fell back to text dedup (which an attachment send can't satisfy) — the
  // bubble stayed pinned at the bottom of the timeline until a refresh.
  describe('revokeEchoClaims (failed-delivery cleanup)', () => {
    it('a revoked claim does not steal the retry echo — the retry claim binds', () => {
      registerEchoClaims(SID, ['qm-failed'], 'run the weekly report');
      revokeEchoClaims(SID, ['qm-failed']);
      registerEchoClaims(SID, ['qm-retry'], 'run the weekly report');

      const echo = userMsg('run the weekly report', 'uuid-echo', 1000);
      bindEchoClaims(SID, [echo]);

      // Without the revoke, 'qm-failed' (registered first) would win FIFO order.
      expect(echo.walnutMessageId).toBe('qm-retry');
    });

    it('revokes only the named batch — an unrelated pending claim still binds', () => {
      registerEchoClaims(SID, ['qm-dead'], 'first message');
      registerEchoClaims(SID, ['qm-live'], 'second message');
      revokeEchoClaims(SID, ['qm-dead']);

      const dead = userMsg('first message', 'uuid-1', 1000);
      const live = userMsg('second message', 'uuid-2', 2000);
      bindEchoClaims(SID, [dead, live]);

      expect(dead.walnutMessageId).toBeUndefined();
      expect(live.walnutMessageId).toBe('qm-live');
    });

    it('is safe for unknown sessions / ids that were never registered', () => {
      expect(() => revokeEchoClaims('no-such-session', ['qm-x'])).not.toThrow();
      registerEchoClaims(SID, ['qm-1'], 'hello');
      revokeEchoClaims(SID, []);
      revokeEchoClaims(SID, ['qm-never']);
      const echo = userMsg('hello', 'uuid-a', 1000);
      bindEchoClaims(SID, [echo]);
      expect(echo.walnutMessageId).toBe('qm-1'); // untouched
    });

    it('does not disturb an ALREADY BOUND binding (echo already materialized)', () => {
      registerEchoClaims(SID, ['qm-1'], 'hello');
      const echo = userMsg('hello', 'uuid-a', 1000);
      bindEchoClaims(SID, [echo]);
      expect(echo.walnutMessageId).toBe('qm-1');

      revokeEchoClaims(SID, ['qm-1']);
      // Re-parse must still re-stamp from the surviving binding.
      const reparsed = userMsg('hello', 'uuid-a', 1000);
      bindEchoClaims(SID, [reparsed]);
      expect(reparsed.walnutMessageId).toBe('qm-1');
    });
  });
});
