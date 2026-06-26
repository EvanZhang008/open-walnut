/**
 * Tests for the two-phase emergencyTrim + shrinkOldToolResults.
 *
 * The user's core insight: when context overflows, you should shrink bulky TOOL
 * RESULTS (which have served their purpose) — NOT delete whole conversation turns
 * (which destroys the intent/decision trail and confuses the model). emergencyTrim
 * now does Stage 1 = soft-trim old tool_results (keep head+tail), and only falls
 * back to Stage 2 = drop oldest whole messages if Stage 1 still overflows.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { emergencyTrim, shrinkOldToolResults } from '../../src/agent/token-budget.js';
import { estimateMessagesTokens } from '../../src/core/daily-log.js';
import type { MessageParam } from '../../src/agent/model.js';

/** Varied word salad — does NOT BPE-compress like 'R'.repeat() does, so it costs a
 *  realistic ~1 token/word and tokenizes fast. */
function tokenHeavy(words: number, seed = 0): string {
  const vocab = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(vocab[(seed + i * 5) % vocab.length] + (i % 7));
  return out.join(' ');
}

/** A user message holding a single tool_result with a big token-heavy payload (≈`words` tokens). */
function toolResultMsg(id: string, words: number): MessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: tokenHeavy(words) }],
  } as MessageParam;
}

/** An assistant message holding a tool_use (pairs with the next tool_result). */
function toolUseMsg(id: string): MessageParam {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'exec', input: {} }],
  } as MessageParam;
}

/** A plain text user message. */
function userText(text: string): MessageParam {
  return { role: 'user', content: text } as MessageParam;
}

describe('shrinkOldToolResults', () => {
  it('shrinks a large OLD tool_result but keeps head + tail', () => {
    const msgs: MessageParam[] = [
      userText('start'),
      toolUseMsg('t1'),
      toolResultMsg('t1', 50_000), // OLD, big → should shrink
      userText('turn2'),
      userText('turn3'),
      userText('turn4'), // 3 recent user turns protect from here back
    ];
    const out = shrinkOldToolResults(msgs);
    const block = (out[2].content as Array<{ content: string }>)[0];
    const origLen = (msgs[2].content as Array<{ content: string }>)[0].content.length;
    expect(block.content.length).toBeLessThan(origLen);
    expect(block.content).toContain('[trimmed');
    // Head + tail preserved (word-salad starts with 'alpha', the head keeps it)
    expect(block.content.startsWith('alpha')).toBe(true);
  });

  it('does NOT shrink tool_results inside the last 3 protected turns', () => {
    const msgs: MessageParam[] = [
      userText('old'),
      toolUseMsg('t1'),
      toolResultMsg('t1', 50_000), // recent (within last 3 user turns) → protected
      userText('q2'),
      userText('q3'),
    ];
    const out = shrinkOldToolResults(msgs);
    // Nothing should change (all within protected window) → same reference
    expect(out).toBe(msgs);
  });

  it('does NOT shrink small tool_results below threshold', () => {
    const msgs: MessageParam[] = [
      userText('start'),
      toolResultMsg('t1', 100), // tiny
      userText('a'),
      userText('b'),
      userText('c'),
    ];
    const out = shrinkOldToolResults(msgs);
    expect(out).toBe(msgs); // unchanged reference
  });

  it('handles array-form tool_result content (text blocks)', () => {
    const msgs: MessageParam[] = [
      userText('start'),
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: 'Z'.repeat(40_000) }],
        }],
      } as MessageParam,
      userText('a'),
      userText('b'),
      userText('c'),
    ];
    const out = shrinkOldToolResults(msgs);
    const inner = (out[1].content as Array<{ content: Array<{ text: string }> }>)[0].content[0];
    expect(inner.text.length).toBeLessThan(40_000);
    expect(inner.text).toContain('[trimmed');
  });

  it('never mutates the input array', () => {
    const original = toolResultMsg('t1', 50_000);
    const origLen = (original.content as Array<{ content: string }>)[0].content.length;
    const msgs = [userText('s'), toolUseMsg('t1'), original, userText('a'), userText('b'), userText('c')];
    shrinkOldToolResults(msgs);
    // original block still full length (we returned a clone)
    expect((original.content as Array<{ content: string }>)[0].content.length).toBe(origLen);
  });
});

describe('emergencyTrim — two-phase', () => {
  it('Stage 1 alone fits budget: shrinks tool results, keeps ALL conversation turns', () => {
    // One giant old tool result dominates; shrinking it should be enough.
    const msgs: MessageParam[] = [
      userText('intent message that must NOT be deleted'),
      toolUseMsg('t1'),
      toolResultMsg('t1', 30_000), // ~30K tokens of bulk, dwarfs everything else
      userText('recent1'),
      userText('recent2'),
      userText('recent3'),
    ];
    const before = estimateMessagesTokens(msgs);
    // Target between shrunk-size and original-size so Stage 1 is sufficient.
    const target = Math.round(before * 0.4);
    const out = emergencyTrim(msgs, target);

    // ALL 6 messages still present (no conversation deleted)
    expect(out.length).toBe(6);
    // The intent message survived verbatim
    expect(out[0].content).toBe('intent message that must NOT be deleted');
    // The big tool result was shrunk
    const block = (out[2].content as Array<{ content: string }>)[0];
    expect(block.content).toContain('[trimmed');
    // And we are within budget
    expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(target);
  });

  it('Stage 2 fallback: when shrinking is not enough, drops oldest whole messages', () => {
    // Many bulky PLAIN messages (no tool results to shrink) → must delete from front.
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(userText(`U${i} ${tokenHeavy(500, i)}`));
      msgs.push({ role: 'assistant', content: `A${i} ${tokenHeavy(500, i + 500)}` } as MessageParam);
    }
    const before = estimateMessagesTokens(msgs);
    const target = Math.round(before * 0.2);
    const out = emergencyTrim(msgs, target);

    // Fewer messages than before (whole-message deletion happened)
    expect(out.length).toBeLessThan(msgs.length);
    // Within budget
    expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(target);
    // Starts on a valid user message (turn boundary preserved, no orphan tool_result)
    expect((out[0] as { role: string }).role).toBe('user');
  });

  it('returns input unchanged when already within budget', () => {
    const msgs = [userText('a'), userText('b'), userText('c'), userText('d'), userText('e')];
    const huge = 10_000_000;
    const out = emergencyTrim(msgs, huge);
    expect(out).toBe(msgs);
  });

  it('never produces an orphan tool_result at the front (valid API shape)', () => {
    // Build history where a naive front-trim could land on a tool_result.
    const msgs: MessageParam[] = [
      userText('q1'),
      toolUseMsg('t1'),
      toolResultMsg('t1', 5_000),
      userText('q2'),
      toolUseMsg('t2'),
      toolResultMsg('t2', 5_000),
      userText('q3 ' + tokenHeavy(8_000, 3)),
      { role: 'assistant', content: 'a3' } as MessageParam,
    ];
    const before = estimateMessagesTokens(msgs);
    const out = emergencyTrim(msgs, Math.round(before * 0.15));
    // First message must be a user message that is NOT a tool_result
    const first = out[0] as { role: string; content: unknown };
    expect(first.role).toBe('user');
    if (Array.isArray(first.content)) {
      const hasToolResult = (first.content as Array<{ type: string }>).some((b) => b.type === 'tool_result');
      expect(hasToolResult).toBe(false);
    }
  });
});
