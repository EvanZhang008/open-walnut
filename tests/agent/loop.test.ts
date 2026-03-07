import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants
vi.mock('../../src/constants.js', () => createMockConstants());

// Mock the model to avoid real API calls
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(),
  sendMessageStream: vi.fn(),
  resetClient: vi.fn(),
  DEFAULT_MODEL: 'global.anthropic.claude-opus-4-6-v1',
  getContextWindowSize: (model?: string) => model?.includes('[1m]') ? 1_000_000 : 200_000,
  getContextThreshold: (model: string | undefined, percent: number) =>
    Math.round((model?.includes('[1m]') ? 1_000_000 : 200_000) * percent),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { sendMessageStream } from '../../src/agent/model.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import { cacheTTLTracker } from '../../src/agent/cache.js';

const mockSendMessage = vi.mocked(sendMessageStream);

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  cacheTTLTracker.reset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('runAgentLoop', () => {
  it('returns text response when model gives text only', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello! How can I help you?' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('Hello', []);
    expect(result.response).toBe('Hello! How can I help you?');
    // messages: user + assistant
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('executes tool calls and feeds results back', async () => {
    // First call: model requests tool use
    mockSendMessage.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'query_tasks', input: {} },
      ],
      stopReason: 'tool_use',
    });

    // Second call: model responds with text after tool result
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'You have no tasks yet.' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('What are my tasks?', []);
    expect(result.response).toBe('You have no tasks yet.');
    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    // Final messages: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('user'); // tool results
    expect(result.messages[3].role).toBe('assistant');
  });

  it('handles multiple tool calls in one response', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'query_tasks', input: {} },
        { type: 'tool_use', id: 'tool_2', name: 'get_config', input: {} },
      ],
      stopReason: 'tool_use',
    });

    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Here is a summary.' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('Show me everything', []);
    expect(result.response).toBe('Here is a summary.');

    // Final messages: user, assistant(2 tool_uses), user(2 tool_results), assistant(text)
    expect(result.messages).toHaveLength(4);
    // The tool results message should have 2 tool results
    const toolResultMsg = result.messages[2];
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    if (Array.isArray(toolResultMsg.content)) {
      expect(toolResultMsg.content).toHaveLength(2);
    }
  });

  it('calls onToolActivity callbacks', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'query_tasks', input: {} },
      ],
      stopReason: 'tool_use',
    });

    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done.' }],
      stopReason: 'end_turn',
    });

    const activities: Array<{ toolName: string; status: string }> = [];
    await runAgentLoop('Check tasks', [], {
      onToolActivity(activity) {
        activities.push(activity);
      },
    });

    expect(activities).toHaveLength(2);
    expect(activities[0]).toEqual({ toolName: 'query_tasks', status: 'calling' });
    expect(activities[1]).toEqual({ toolName: 'query_tasks', status: 'done' });
  });

  it('calls onText callback when text blocks appear', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Response text' }],
      stopReason: 'end_turn',
    });

    const texts: string[] = [];
    await runAgentLoop('Hi', [], {
      onText(text) {
        texts.push(text);
      },
    });

    expect(texts).toEqual(['Response text']);
  });

  it('preserves conversation history', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'First reply' }],
      stopReason: 'end_turn',
    });

    const existing = [
      { role: 'user' as const, content: 'Previous question' },
      { role: 'assistant' as const, content: 'Previous answer' },
    ];

    const result = await runAgentLoop('Follow-up', existing);

    // Result messages: prev user, prev assistant, new user, new assistant
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].content).toBe('Previous question');
    expect(result.messages[1].content).toBe('Previous answer');
    // runAgentLoop prepends a [Current: <date/time>] prefix to the user message
    const newUserContent = result.messages[2].content as string;
    expect(newUserContent).toContain('Follow-up');
    expect(newUserContent).toMatch(/^\[Current: .+\]\n\nFollow-up$/);
    expect(result.messages[3].role).toBe('assistant');
  });

  it('handles tool execution errors gracefully', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'get_task', input: { id: 'nonexistent' } },
      ],
      stopReason: 'tool_use',
    });

    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'That task was not found.' }],
      stopReason: 'end_turn',
    });

    const result = await runAgentLoop('Show task xyz', []);
    expect(result.response).toBe('That task was not found.');

    // The tool results user message (index 2) should contain the error
    const toolResultMsg = result.messages[2];
    if (Array.isArray(toolResultMsg.content)) {
      const toolResult = toolResultMsg.content[0] as { content: string };
      expect(toolResult.content).toContain('Error:');
    }
  });
});

describe('prompt caching integration', () => {
  it('sends structured system blocks with cache_control to sendMessage', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('Hello', []);

    const call = mockSendMessage.mock.calls[0][0];

    // system should be an array of TextBlockParam, not a plain string
    expect(Array.isArray(call.system)).toBe(true);
    const systemBlocks = call.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0].type).toBe('text');
    expect(systemBlocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('sends tools with cache_control on the last tool', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('Hello', []);

    const call = mockSendMessage.mock.calls[0][0];
    const tools = call.tools!;
    expect(tools.length).toBeGreaterThan(0);

    // Only the last tool should have cache_control
    for (let i = 0; i < tools.length - 1; i++) {
      expect(tools[i].cache_control).toBeUndefined();
    }
    expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('sends messages with cache_control on the last user message', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('Hello', []);

    const call = mockSendMessage.mock.calls[0][0];
    const messages = call.messages;

    // The only message is the user message "Hello", which should now be an array with cache_control
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(Array.isArray(messages[0].content)).toBe(true);
    const blocks = messages[0].content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('applies cache markers on tool-loop continuation calls', async () => {
    // First call: tool use
    mockSendMessage.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', id: 't1', name: 'query_tasks', input: {} },
      ],
      stopReason: 'tool_use',
    });

    // Second call: text response
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'No tasks.' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('List tasks', []);

    // Both calls should have structured system and tool cache markers
    for (const call of mockSendMessage.mock.calls) {
      const opts = call[0];
      expect(Array.isArray(opts.system)).toBe(true);
      const lastTool = opts.tools![opts.tools!.length - 1];
      expect(lastTool.cache_control).toBeDefined();
    }

    // The second call has more messages (user + assistant + tool_result user)
    const secondCall = mockSendMessage.mock.calls[1][0];
    expect(secondCall.messages.length).toBe(3);

    // Last user message (tool_result) should have cache_control on its last block
    const lastUserMsg = secondCall.messages[2];
    expect(lastUserMsg.role).toBe('user');
    const content = lastUserMsg.content as Array<{ cache_control?: unknown }>;
    expect(content[content.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('passes usage stats through from API response', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Cached response' }],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        cache_creation_input_tokens: 900,
        cache_read_input_tokens: 0,
      },
    });

    const usageStats: Array<Record<string, unknown>> = [];
    await runAgentLoop('Hello', [], {
      onUsage(usage) {
        usageStats.push(usage);
      },
    });

    expect(usageStats).toHaveLength(1);
    expect(usageStats[0].cache_creation_input_tokens).toBe(900);
  });
});
