import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// Config is injectable per test via this holder. `user` must exist —
// buildSystemPromptSplit reads config.user.name on the default-system path.
const BASE_CONFIG = { user: {} };
const configHolder: { config: Record<string, unknown> } = { config: { ...BASE_CONFIG } };
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => configHolder.config),
}));

// Mock the model so the loop-level whitelist test never hits the network.
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(),
  sendMessageStream: vi.fn(),
  resetClient: vi.fn(),
  DEFAULT_MODEL: 'global.anthropic.claude-opus-4-6-v1',
  getContextWindowSize: () => 200_000,
  getContextThreshold: (_m: string | undefined, percent: number) => Math.round(200_000 * percent),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { sendMessageStream } from '../../src/agent/model.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import {
  noteTurnCompleteAndMaybeReview,
  resetReviewState,
  getReviewTurnCount,
  REVIEW_TOOL_WHITELIST,
  REVIEW_PROMPT,
  DEFAULT_REVIEW_INTERVAL,
  type ReviewRunner,
} from '../../src/agent/background-review.js';
import type { MessageParam } from '../../src/agent/model.js';

const mockSendMessage = vi.mocked(sendMessageStream);

const AGENT = 'general';
const CONV = 'conv-review-test';

function makeInfo(overrides?: Partial<Parameters<typeof noteTurnCompleteAndMaybeReview>[0]>) {
  return {
    agentId: AGENT,
    conversationId: CONV,
    toolsUsed: new Set<string>(),
    getHistory: async () => [] as MessageParam[],
    runner: vi.fn(async () => ({ response: 'Nothing to save.' })) as ReviewRunner,
    ...overrides,
  };
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  vi.clearAllMocks();
  resetReviewState();
  configHolder.config = { ...BASE_CONFIG };
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('turn counter', () => {
  it('fires the review exactly at the interval boundary', async () => {
    const runner = vi.fn(async () => ({ response: 'Nothing to save.' }));
    for (let i = 1; i < DEFAULT_REVIEW_INTERVAL; i++) {
      const fired = await noteTurnCompleteAndMaybeReview(makeInfo({ runner }));
      expect(fired).toBe(false);
      expect(getReviewTurnCount(AGENT, CONV)).toBe(i);
    }
    const fired = await noteTurnCompleteAndMaybeReview(makeInfo({ runner }));
    expect(fired).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    // Window restarted after firing.
    expect(getReviewTurnCount(AGENT, CONV)).toBe(0);
  });

  it('resets the counter when skill_manage was used in the turn', async () => {
    await noteTurnCompleteAndMaybeReview(makeInfo());
    await noteTurnCompleteAndMaybeReview(makeInfo());
    expect(getReviewTurnCount(AGENT, CONV)).toBe(2);

    const fired = await noteTurnCompleteAndMaybeReview(
      makeInfo({ toolsUsed: new Set(['skill_manage', 'task_query']) }),
    );
    expect(fired).toBe(false);
    expect(getReviewTurnCount(AGENT, CONV)).toBe(0);
  });

  it('tracks conversations independently', async () => {
    await noteTurnCompleteAndMaybeReview(makeInfo());
    await noteTurnCompleteAndMaybeReview(makeInfo({ conversationId: 'other-conv' }));
    expect(getReviewTurnCount(AGENT, CONV)).toBe(1);
    expect(getReviewTurnCount(AGENT, 'other-conv')).toBe(1);
  });

  it('honors a custom interval from config', async () => {
    configHolder.config = { ...BASE_CONFIG, agent: { background_review: { interval: 2 } } };
    const runner = vi.fn(async () => ({ response: 'ok' }));
    expect(await noteTurnCompleteAndMaybeReview(makeInfo({ runner }))).toBe(false);
    expect(await noteTurnCompleteAndMaybeReview(makeInfo({ runner }))).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled in config', async () => {
    configHolder.config = { ...BASE_CONFIG, agent: { background_review: { enabled: false, interval: 1 } } };
    const runner = vi.fn(async () => ({ response: 'ok' }));
    expect(await noteTurnCompleteAndMaybeReview(makeInfo({ runner }))).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    // Disabled turns don't accumulate either.
    expect(getReviewTurnCount(AGENT, CONV)).toBe(0);
  });
});

describe('review fork', () => {
  it('passes the review prompt, history snapshot, whitelist, and fork identity to the runner', async () => {
    configHolder.config = { ...BASE_CONFIG, agent: { background_review: { interval: 1 } } };
    const history: MessageParam[] = [
      { role: 'user', content: 'earlier message' },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
    ] as MessageParam[];
    const runner = vi.fn(async () => ({ response: 'Saved one skill patch.' }));

    const fired = await noteTurnCompleteAndMaybeReview(makeInfo({
      runner,
      getHistory: async () => history,
    }));
    expect(fired).toBe(true);

    const [prompt, passedHistory, options] = runner.mock.calls[0];
    expect(prompt).toBe(REVIEW_PROMPT);
    expect(passedHistory).toBe(history);
    // system must stay undefined so the DEFAULT stable prompt + full tool
    // schemas build the same cache prefix as the main chat.
    expect(options.system).toBeUndefined();
    expect(options.source).toBe('background-review');
    expect(options.toolWhitelist).toEqual(REVIEW_TOOL_WHITELIST);
    expect(options.agentId).toBe(AGENT);
    expect(options.conversationId).toBe(CONV);
  });

  it('drops a fire while a review is already in flight, then re-fires next boundary', async () => {
    configHolder.config = { ...BASE_CONFIG, agent: { background_review: { interval: 1 } } };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = vi.fn(async () => { await gate; return { response: 'ok' }; });

    const first = noteTurnCompleteAndMaybeReview(makeInfo({ runner }));
    // Give the first call time to reach the in-flight gate.
    await new Promise((r) => setTimeout(r, 10));
    const second = await noteTurnCompleteAndMaybeReview(makeInfo({ runner }));
    expect(second).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBe(true);

    // In-flight flag cleared — next boundary fires again.
    const third = await noteTurnCompleteAndMaybeReview(makeInfo({ runner }));
    expect(third).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('review failure is swallowed and the in-flight flag is released', async () => {
    configHolder.config = { ...BASE_CONFIG, agent: { background_review: { interval: 1 } } };
    const failing = vi.fn(async () => { throw new Error('model down'); });
    expect(await noteTurnCompleteAndMaybeReview(makeInfo({ runner: failing }))).toBe(false);
    // Flag released → the next boundary can fire.
    const ok = vi.fn(async () => ({ response: 'ok' }));
    expect(await noteTurnCompleteAndMaybeReview(makeInfo({ runner: ok }))).toBe(true);
  });

  it('review prompt never persists: runner receives history by reference, unmodified', async () => {
    configHolder.config = { ...BASE_CONFIG, agent: { background_review: { interval: 1 } } };
    const history: MessageParam[] = [{ role: 'user', content: 'hi' }] as MessageParam[];
    const snapshotLength = history.length;
    const runner = vi.fn(async () => ({ response: 'ok' }));
    await noteTurnCompleteAndMaybeReview(makeInfo({ runner, getHistory: async () => history }));
    // The module must not mutate the caller's history array (the loop copies it).
    expect(history).toHaveLength(snapshotLength);
  });
});

describe('runtime tool whitelist in the agent loop', () => {
  it('denies non-whitelisted tools at execution time without shrinking tools[]', async () => {
    // Round 1: model calls a non-whitelisted tool → denial string comes back.
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'task_create', input: { title: 'x' } }],
      stopReason: 'tool_use',
    });
    // Round 2: model finishes.
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('review', [], undefined, {
      source: 'background-review',
      toolWhitelist: ['skill_manage', 'skill_view'],
    });
    expect(result.response).toBe('done');

    // The denial must be a tool_result error fed back to the model.
    const toolResultMsg = result.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content)
        && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
    const block = (toolResultMsg!.content as Array<{ type: string; content?: string; is_error?: boolean }>)
      .find((b) => b.type === 'tool_result')!;
    expect(String(block.content)).toContain('not available in this review pass');
    expect(block.is_error).toBe(true);

    // Cache-parity: the FULL tool schema array was still sent to the API.
    const sentTools = mockSendMessage.mock.calls[0][0].tools as Array<{ name: string }>;
    expect(sentTools.length).toBeGreaterThan(2);
    expect(sentTools.some((t) => t.name === 'task_create')).toBe(true);
  });

  it('whitelisted tools execute normally', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'skill_view', input: { name: 'nonexistent-skill' } }],
      stopReason: 'tool_use',
    });
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'checked' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('review', [], undefined, {
      source: 'background-review',
      toolWhitelist: ['skill_manage', 'skill_view'],
    });
    expect(result.response).toBe('checked');
    const toolResultMsg = result.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content)
        && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'),
    );
    const block = (toolResultMsg!.content as Array<{ type: string; content?: unknown }>)
      .find((b) => b.type === 'tool_result')!;
    // The tool actually ran (skill not found is a real skill_view result, not a whitelist denial).
    expect(String(block.content)).not.toContain('not available in this review pass');
  });
});
