/**
 * Regression tests for the `newMessages` return contract (root-cause fix for the
 * duplicate-task / orphaned-message batch bug).
 *
 * THE BUG: callers extracted "this turn's new messages" via
 *   result.messages.slice(history.length)
 * When a 400 "prompt too long" emergencyTrim shortened result.messages from the
 * FRONT, history.length pointed PAST the end → empty slice → the assistant reply
 * was silently dropped, leaving the user message a permanent orphan. After N such
 * turns, N orphaned user messages accumulated and were replayed as a batch.
 *
 * THE FIX: runAgentLoop now returns `newMessages` — an accumulator that only ever
 * grows with this-turn messages and is NEVER touched by trim (trim mutates the
 * front of the working `messages` array). These tests prove that contract holds
 * even when the working array is aggressively trimmed mid-turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(),
  sendMessageStream: vi.fn(),
  resetClient: vi.fn(),
  DEFAULT_MODEL: 'global.anthropic.claude-opus-4-6-v1',
  getContextWindowSize: (model?: string) => (model?.includes('[1m]') ? 1_000_000 : 200_000),
  getContextThreshold: (model: string | undefined, percent: number) =>
    Math.round((model?.includes('[1m]') ? 1_000_000 : 200_000) * percent),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { sendMessageStream } from '../../src/agent/model.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import { cacheTTLTracker } from '../../src/agent/cache.js';
import type { MessageParam } from '../../src/agent/model.js';

const mockSendMessage = vi.mocked(sendMessageStream);

/** Varied word salad — does NOT BPE-compress like 'x'.repeat() does, so it costs
 *  a realistic number of tokens. `words` ≈ tokens. */
function tokenHeavy(words: number, seed: number): string {
  const vocab = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo'];
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(vocab[(seed + i * 7) % vocab.length] + (i % 5));
  }
  return out.join(' ');
}

/** Build a long history of alternating user/assistant messages with bulky text. */
function makeBigHistory(pairs: number, wordsPerMsg: number): MessageParam[] {
  const out: MessageParam[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ role: 'user', content: `Q${i} ${tokenHeavy(wordsPerMsg, i)}` });
    out.push({ role: 'assistant', content: `A${i} ${tokenHeavy(wordsPerMsg, i + 1000)}` });
  }
  return out;
}

/** A 400-too-long Error shaped like the Bedrock/Anthropic SDK error. */
function tooLongError(reported: number, max = 200_000): Error {
  const err = new Error(`400 prompt is too long: ${reported} tokens > ${max} maximum`);
  (err as { status?: number }).status = 400;
  return err;
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  cacheTTLTracker.reset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('newMessages contract — basic', () => {
  it('newMessages = [userPrompt, assistant] for a text-only turn', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello!' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('Hi', []);
    expect(result.newMessages).toHaveLength(2);
    expect((result.newMessages[0] as { role: string }).role).toBe('user');
    expect((result.newMessages[1] as { role: string }).role).toBe('assistant');
    // newMessages.slice(1) (what chat.ts persists) is exactly the assistant reply
    expect(result.newMessages.slice(1)).toHaveLength(1);
  });

  it('newMessages captures tool_use → tool_result → assistant', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'task_query', input: {} }],
      stopReason: 'tool_use',
    });
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('go', []);
    // user, assistant(tool_use), user(tool_result), assistant(text)
    expect(result.newMessages).toHaveLength(4);
    expect((result.newMessages[0] as { role: string }).role).toBe('user');
    expect((result.newMessages[3] as { role: string }).role).toBe('assistant');
  });

  it('with prior history, newMessages excludes the history (slice(history.length) equivalent when NO trim)', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'reply' }],
      stopReason: 'end_turn',
    });
    const history = makeBigHistory(3, 10); // 6 small messages
    const result = await runAgentLoop('follow-up', history);

    // newMessages should be exactly [userPrompt, assistant] — NOT include history
    expect(result.newMessages).toHaveLength(2);
    // And in the no-trim case it must equal the OLD slice(history.length) result
    const oldStyle = result.messages.slice(history.length);
    expect(result.newMessages).toEqual(oldStyle);
  });
});

describe('newMessages contract — survives emergency trim (THE BUG)', () => {
  it('assistant reply is preserved in newMessages even when 400-trim shortens result.messages below history.length', async () => {
    // Huge history → first call throws 400, second call (after trim) succeeds.
    // 300 pairs × 400 words ≈ 240K tokens > the 180K post-400 trim target (200K model),
    // so emergencyTrim genuinely deletes from the front and shortens the array.
    const history = makeBigHistory(300, 400); // 600 messages

    // First model call: 400 too long. Loop will emergencyTrim then retry.
    mockSendMessage.mockRejectedValueOnce(tooLongError(1_010_000, 200_000));
    // Retry after trim: model produces a real text reply.
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'RECOVERED REPLY' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 150_000, output_tokens: 10 },
    });

    const result = await runAgentLoop('important question', history, undefined, {
      modelConfig: { model: 'global.anthropic.claude-opus-4-6-v1' }, // 200K window → trim target 180K
    });

    // The working array WAS trimmed (shorter than history + 2).
    expect(result.messages.length).toBeLessThan(history.length + 2);

    // THE OLD BUG: slice(history.length) would now be empty (overshoot).
    const buggyOldExtraction = result.messages.slice(history.length);
    expect(buggyOldExtraction.length).toBe(0); // proves the old approach drops the reply

    // THE FIX: newMessages still has the user prompt + the recovered assistant reply.
    expect(result.newMessages.length).toBeGreaterThanOrEqual(2);
    expect((result.newMessages[0] as { role: string }).role).toBe('user');
    const lastNew = result.newMessages[result.newMessages.length - 1] as { role: string; content: unknown };
    expect(lastNew.role).toBe('assistant');
    // The assistant reply text must be present (not dropped)
    const txt = (lastNew.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text;
    expect(txt).toBe('RECOVERED REPLY');

    // And response string is non-empty (the user actually got an answer)
    expect(result.response).toContain('RECOVERED REPLY');

    // What chat.ts persists = newMessages.slice(1) = the assistant reply (msgs > 0)
    expect(result.newMessages.slice(1).length).toBeGreaterThanOrEqual(1);
  });

  it('multi-round turn with a mid-turn trim still accumulates every new message', async () => {
    const history = makeBigHistory(300, 400);

    // Round 1: tool_use (succeeds)
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'task_query', input: {} }],
      stopReason: 'tool_use',
      usage: { input_tokens: 150_000, output_tokens: 10 },
    });
    // Round 2: 400 too long → trim → retry text
    mockSendMessage.mockRejectedValueOnce(tooLongError(1_010_000, 200_000));
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'FINAL' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 150_000, output_tokens: 5 },
    });

    const result = await runAgentLoop('q', history, undefined, {
      modelConfig: { model: 'global.anthropic.claude-opus-4-6-v1' },
    });

    // newMessages must contain: userPrompt, assistant(tool_use), user(tool_result), assistant(FINAL)
    const roles = result.newMessages.map((m) => (m as { role: string }).role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(result.response).toContain('FINAL');
  });
});

describe('newMessages contract — aborted turns', () => {
  it('aborted-before-round-1 still returns newMessages with the user prompt', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runAgentLoop('hi', [], undefined, { signal: ac.signal });
    expect(result.aborted).toBe(true);
    expect(result.newMessages.length).toBeGreaterThanOrEqual(1);
    expect((result.newMessages[0] as { role: string }).role).toBe('user');
  });
});

describe('newMessages contract — Stage-1 shrink does not corrupt persisted (newMessages) content', () => {
  it('a same-turn tool_result shrunk in the working array stays FULL-SIZE in newMessages (disk fidelity)', async () => {
    // Contract (per adversarial review nit #2): emergencyTrim Stage-1 shrinkOldToolResults
    // shrinks tool_result CONTENT in the in-memory `messages` array to fit the API budget,
    // but it builds NEW block objects rather than mutating the originals. newMessages holds
    // the ORIGINAL references, so what we persist to disk keeps full fidelity even when the
    // API call this turn saw a shrunk copy. This test locks that contract.
    const BIG = tokenHeavy(8_000, 7); // a large tool_result payload (~8K tokens, > shrink threshold)

    // 4 tool rounds so round-1's tool_result falls OUTSIDE the "last 3 user turns" protection
    // window by the time the round-5 400-trim runs. (tool_result messages are role:'user'.)
    for (let r = 1; r <= 4; r++) {
      mockSendMessage.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: `t${r}`, name: 'exec', input: { i: r } }],
        stopReason: 'tool_use',
        usage: { input_tokens: 50_000, output_tokens: 5 },
      });
    }
    // Round 5: 400 too long → emergencyTrim (Stage-1 shrink fires on the old big tool_result) → retry text
    mockSendMessage.mockRejectedValueOnce(tooLongError(1_010_000, 200_000));
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'DONE' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 50_000, output_tokens: 3 },
    });

    // Tool execution returns the BIG payload for the first tool_use; we inject it via a
    // custom tool so the tool_result content is large and shrink-eligible.
    const bigTool = {
      name: 'exec',
      description: 'returns a big payload',
      input_schema: { type: 'object', properties: {} },
      execute: async () => BIG,
    };

    const result = await runAgentLoop('do work', [], undefined, {
      modelConfig: { model: 'global.anthropic.claude-opus-4-6-v1' },
      tools: [bigTool as unknown as import('../../src/agent/tools.js').ToolDefinition],
    });

    expect(result.response).toContain('DONE');

    // Find the first tool_result in newMessages — it must still carry the FULL BIG payload.
    let fullSizeFound = false;
    for (const m of result.newMessages) {
      const content = (m as { content: unknown }).content;
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type: string; content?: unknown }>) {
          if (b.type === 'tool_result') {
            const inner = typeof b.content === 'string' ? b.content : '';
            if (inner.includes(BIG.slice(0, 50)) && inner.length >= BIG.length) {
              fullSizeFound = true;
            }
            // It must NOT be the shrunk placeholder
            expect(inner).not.toContain('[trimmed');
          }
        }
      }
    }
    expect(fullSizeFound).toBe(true);
  });
});
