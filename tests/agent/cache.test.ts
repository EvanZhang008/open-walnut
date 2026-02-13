import { describe, it, expect, beforeEach } from 'vitest';
import {
  toSystemBlocks,
  addToolCacheMarker,
  injectMessageCacheMarkers,
  pruneContext,
  CacheTTLTracker,
} from '../../src/agent/cache.js';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';

describe('toSystemBlocks', () => {
  it('wraps text into a TextBlockParam with cache_control', () => {
    const result = toSystemBlocks('You are a helpful assistant.');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(result[0].text).toBe('You are a helpful assistant.');
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('uses custom TTL when specified', () => {
    const result = toSystemBlocks('System prompt.', { ttl: '1h' });
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('defaults to 5m TTL', () => {
    const result = toSystemBlocks('Text');
    expect(result[0].cache_control!.ttl).toBe('5m');
  });

  it('handles empty string', () => {
    const result = toSystemBlocks('');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('');
    expect(result[0].cache_control).toBeDefined();
  });
});

describe('addToolCacheMarker', () => {
  const makeTools = (count: number): Tool[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      input_schema: { type: 'object' as const, properties: {} },
    }));

  it('adds cache_control to the last tool only', () => {
    const tools = makeTools(3);
    const result = addToolCacheMarker(tools);

    expect(result).toHaveLength(3);
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toBeUndefined();
    expect(result[2].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('does not mutate the original array', () => {
    const tools = makeTools(2);
    const result = addToolCacheMarker(tools);

    expect(tools[1].cache_control).toBeUndefined();
    expect(result[1].cache_control).toBeDefined();
  });

  it('handles single tool', () => {
    const tools = makeTools(1);
    const result = addToolCacheMarker(tools);

    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('returns empty array for empty input', () => {
    const result = addToolCacheMarker([]);
    expect(result).toHaveLength(0);
  });

  it('uses custom TTL', () => {
    const tools = makeTools(2);
    const result = addToolCacheMarker(tools, '1h');

    expect(result[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

describe('injectMessageCacheMarkers', () => {
  it('annotates last user message with string content', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ];

    const result = injectMessageCacheMarkers(messages);

    // Last user message (index 2) should be converted to array with cache_control
    const lastUser = result[2];
    expect(Array.isArray(lastUser.content)).toBe(true);
    const blocks = lastUser.content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('How are you?');
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });

    // Earlier user message should be untouched
    expect(result[0].content).toBe('Hello');
  });

  it('annotates last block of array content', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'abc', content: 'result1' },
          { type: 'tool_result', tool_use_id: 'def', content: 'result2' },
        ],
      },
    ];

    const result = injectMessageCacheMarkers(messages);
    const blocks = result[0].content as Array<{ cache_control?: unknown }>;
    expect(blocks).toHaveLength(2);
    // Only last block gets the marker
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('does not mutate original messages', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Test' },
    ];

    injectMessageCacheMarkers(messages);
    // Original should still be a plain string
    expect(messages[0].content).toBe('Test');
  });

  it('returns empty array for empty input', () => {
    const result = injectMessageCacheMarkers([]);
    expect(result).toHaveLength(0);
  });

  it('handles messages with no user messages', () => {
    const messages: MessageParam[] = [
      { role: 'assistant', content: 'Hello' },
    ];

    const result = injectMessageCacheMarkers(messages);
    expect(result).toEqual(messages);
  });

  it('uses custom TTL', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Hi' },
    ];

    const result = injectMessageCacheMarkers(messages, '1h');
    const blocks = result[0].content as Array<{ cache_control?: { type: string; ttl: string } }>;
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('targets the last user message, not the last message overall', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: 'Reply' },
    ];

    const result = injectMessageCacheMarkers(messages);

    // Index 0 (first user) untouched
    expect(result[0].content).toBe('First');
    // Index 1 (last user) annotated
    expect(Array.isArray(result[1].content)).toBe(true);
    // Index 2 (assistant) untouched
    expect(result[2].content).toBe('Reply');
  });
});

describe('pruneContext', () => {
  function makeConversation(turns: number): MessageParam[] {
    const messages: MessageParam[] = [];
    for (let i = 0; i < turns; i++) {
      messages.push({ role: 'user', content: `User message ${i}` });
      messages.push({ role: 'assistant', content: `Assistant message ${i}` });
    }
    return messages;
  }

  it('does not trim short conversations', () => {
    const messages = makeConversation(3);
    const result = pruneContext(messages, { keepLastNTurns: 4 });

    // All messages should be identical (nothing to prune)
    expect(result).toHaveLength(6);
    for (let i = 0; i < result.length; i++) {
      expect(result[i].content).toBe(messages[i].content);
    }
  });

  it('soft-trims large tool_result blocks in old turns', () => {
    const longContent = 'A'.repeat(60_000);
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'old_tool', content: longContent },
        ],
      },
      { role: 'assistant', content: 'Old response' },
      // Recent turns (protected)
      { role: 'user', content: 'Recent 1' },
      { role: 'assistant', content: 'Response 1' },
      { role: 'user', content: 'Recent 2' },
      { role: 'assistant', content: 'Response 2' },
      { role: 'user', content: 'Recent 3' },
      { role: 'assistant', content: 'Response 3' },
      { role: 'user', content: 'Recent 4' },
      { role: 'assistant', content: 'Response 4' },
    ];

    const result = pruneContext(messages, {
      keepLastNTurns: 4,
      softTrimThreshold: 50_000,
      softTrimKeep: 1500,
    });

    // The old tool_result should be trimmed
    const oldBlock = (result[0].content as Array<{ content: string }>)[0];
    expect(oldBlock.content.length).toBeLessThan(longContent.length);
    expect(oldBlock.content).toContain('...[trimmed');

    // Recent turns should be untouched
    expect(result[2].content).toBe('Recent 1');
  });

  it('does not trim tool_result blocks under threshold', () => {
    const shortContent = 'B'.repeat(1000);
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool1', content: shortContent },
        ],
      },
      { role: 'assistant', content: 'Response' },
      // 4 recent turns
      ...Array.from({ length: 8 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `msg ${i}`,
      })),
    ];

    const result = pruneContext(messages, {
      keepLastNTurns: 4,
      softTrimThreshold: 50_000,
    });

    const block = (result[0].content as Array<{ content: string }>)[0];
    expect(block.content).toBe(shortContent);
  });

  it('preserves head and tail of trimmed content', () => {
    const head = 'HEAD_'.repeat(300); // 1500 chars
    const middle = 'M'.repeat(55_000);
    const tail = '_TAIL'.repeat(300); // 1500 chars
    const longContent = head + middle + tail;

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: longContent },
        ],
      },
      { role: 'assistant', content: 'old' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
      { role: 'assistant', content: 'a4' },
    ];

    const result = pruneContext(messages, {
      keepLastNTurns: 4,
      softTrimThreshold: 50_000,
      softTrimKeep: 1500,
    });

    const trimmed = (result[0].content as Array<{ content: string }>)[0].content;
    expect(trimmed.startsWith('HEAD_')).toBe(true);
    expect(trimmed.endsWith('_TAIL')).toBe(true);
    expect(trimmed).toContain('...[trimmed');
  });

  it('does not mutate original messages', () => {
    const longContent = 'X'.repeat(60_000);
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: longContent },
        ],
      },
      { role: 'assistant', content: 'old' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
      { role: 'assistant', content: 'a4' },
    ];

    pruneContext(messages, { keepLastNTurns: 4, softTrimThreshold: 50_000 });

    // Original should be untouched
    const originalBlock = (messages[0].content as Array<{ content: string }>)[0];
    expect(originalBlock.content).toBe(longContent);
  });

  it('handles string-only content messages without error', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'recent answer' },
    ];

    const result = pruneContext(messages, { keepLastNTurns: 1 });
    expect(result).toHaveLength(4);
    // String content should pass through unchanged
    expect(result[0].content).toBe('old question');
  });

  it('uses default options when none provided', () => {
    const messages = makeConversation(2);
    const result = pruneContext(messages);
    // With 2 turns and default keepLastNTurns=4, nothing should be pruned
    expect(result).toHaveLength(4);
  });
});

describe('CacheTTLTracker', () => {
  let tracker: CacheTTLTracker;

  beforeEach(() => {
    tracker = new CacheTTLTracker();
  });

  it('returns false when never touched', () => {
    expect(tracker.isWithinTTL()).toBe(false);
  });

  it('returns true immediately after touch', () => {
    tracker.touch();
    expect(tracker.isWithinTTL()).toBe(true);
  });

  it('returns true within TTL window', () => {
    tracker.touch();
    // Default TTL is 5 minutes, so it should be true right after touch
    expect(tracker.isWithinTTL(60_000)).toBe(true);
  });

  it('returns false after TTL expires', () => {
    tracker.touch();
    // Use a very short TTL to simulate expiry
    expect(tracker.isWithinTTL(0)).toBe(false);
  });

  it('reset clears the timestamp', () => {
    tracker.touch();
    expect(tracker.isWithinTTL()).toBe(true);

    tracker.reset();
    expect(tracker.isWithinTTL()).toBe(false);
  });

  it('uses 5 minute default TTL', () => {
    tracker.touch();
    // Just touched, so 5 minutes hasn't elapsed
    expect(tracker.isWithinTTL()).toBe(true);
  });
});
