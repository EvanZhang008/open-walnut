/**
 * Batched tool execution contract: a reply carrying several tool_use blocks
 * runs them CONCURRENTLY when every tool in the batch is parallelSafe
 * (read-only), and strictly one-at-a-time otherwise (side-effecting tools
 * must never race). Order of tool_result blocks always matches the tool_use
 * order regardless of completion order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(),
  sendMessageStream: vi.fn(),
  resetClient: vi.fn(),
  DEFAULT_MODEL: 'global.anthropic.claude-opus-4-6-v1',
  getContextWindowSize: () => 200_000,
  getContextThreshold: (_m: string | undefined, percent: number) => Math.round(200_000 * percent),
}));

import { sendMessageStream } from '../../src/agent/model.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import type { ToolDefinition } from '../../src/agent/tools.js';

const mockSend = vi.mocked(sendMessageStream);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tool that tracks how many executions overlap in time. */
function makeTracker() {
  let active = 0;
  let maxActive = 0;
  const tool = (name: string, parallelSafe: boolean | undefined, delayMs: number): ToolDefinition => ({
    name,
    description: `test tool ${name}`,
    input_schema: { type: 'object', properties: {} },
    ...(parallelSafe === undefined ? {} : { parallelSafe }),
    execute: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(delayMs);
      active -= 1;
      return `${name}-done`;
    },
  });
  return { tool, maxActive: () => maxActive };
}

function batchThenDone(names: string[]): void {
  mockSend.mockResolvedValueOnce({
    content: names.map((n, i) => ({ type: 'tool_use', id: `t${i}`, name: n, input: {} })),
    stopReason: 'tool_use',
  });
  mockSend.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' });
}

/** The tool_result message the loop fed back after the batch. */
function toolResultsOf(result: Awaited<ReturnType<typeof runAgentLoop>>): Array<{ tool_use_id: string; content: unknown }> {
  const msg = result.newMessages[2] as { role: string; content: Array<{ type: string; tool_use_id: string; content: unknown }> };
  expect(msg.role).toBe('user');
  return msg.content.filter((b) => b.type === 'tool_result');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('batched tool execution', () => {
  it('an all-parallelSafe batch executes concurrently, results in tool_use order', async () => {
    const { tool, maxActive } = makeTracker();
    batchThenDone(['slow', 'fast', 'fast']);
    // The slow one is FIRST — with parallel execution the fast ones overlap it.
    const result = await runAgentLoop('go', [], undefined, {
      system: 's',
      tools: [tool('slow', true, 60), tool('fast', true, 5)],
      cacheConfig: false,
    });
    expect(maxActive()).toBeGreaterThan(1);
    const results = toolResultsOf(result);
    expect(results.map((r) => r.tool_use_id)).toEqual(['t0', 't1', 't2']);
    expect(results[0].content).toBe('slow-done');
    expect(results[1].content).toBe('fast-done');
  });

  it('ONE unmarked tool in the batch forces strict sequential execution', async () => {
    const { tool, maxActive } = makeTracker();
    batchThenDone(['safe', 'unsafe']);
    await runAgentLoop('go', [], undefined, {
      system: 's',
      tools: [tool('safe', true, 20), tool('unsafe', undefined, 20)],
      cacheConfig: false,
    });
    expect(maxActive()).toBe(1);
  });

  it('a single tool_use stays on the sequential path', async () => {
    const { tool, maxActive } = makeTracker();
    batchThenDone(['only']);
    const result = await runAgentLoop('go', [], undefined, {
      system: 's',
      tools: [tool('only', true, 5)],
      cacheConfig: false,
    });
    expect(maxActive()).toBe(1);
    expect(toolResultsOf(result)).toHaveLength(1);
  });

  it('a throwing tool in a parallel batch becomes an is_error result, not a batch failure', async () => {
    const boom: ToolDefinition = {
      name: 'boom',
      description: 'throws',
      input_schema: { type: 'object', properties: {} },
      parallelSafe: true,
      execute: async () => { throw new Error('nope'); },
    };
    const ok: ToolDefinition = {
      name: 'ok',
      description: 'fine',
      input_schema: { type: 'object', properties: {} },
      parallelSafe: true,
      execute: async () => 'fine',
    };
    batchThenDone(['boom', 'ok']);
    const result = await runAgentLoop('go', [], undefined, {
      system: 's', tools: [boom, ok], cacheConfig: false,
    });
    const results = toolResultsOf(result) as Array<{ tool_use_id: string; content: unknown; is_error?: boolean }>;
    expect(results[0].is_error).toBe(true);
    expect(String(results[0].content)).toContain('Error executing boom');
    expect(results[1].content).toBe('fine');
    expect(result.response).toBe('ok');
  });
});
