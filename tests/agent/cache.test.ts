import { describe, it, expect, beforeEach } from 'vitest';
import {
  toSystemBlocks,
  addToolCacheMarker,
  injectMessageCacheMarkers,
  appendEphemeralContext,
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
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('uses custom TTL when specified', () => {
    const result = toSystemBlocks('System prompt.', { ttl: '5m' });
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('defaults to 1h TTL', () => {
    const result = toSystemBlocks('Text');
    expect(result[0].cache_control!.ttl).toBe('1h');
  });

  it('handles empty string', () => {
    const result = toSystemBlocks('');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('');
    expect(result[0].cache_control).toBeDefined();
  });

  it('stays a SINGLE cached block — volatile content never goes in system', () => {
    // The whole cache design depends on `system` being stable-only. Even when a long
    // prompt is passed, toSystemBlocks must produce exactly one cached block — the
    // volatile remainder rides the message tail (appendEphemeralContext), not here.
    expect(toSystemBlocks('any stable prompt')).toHaveLength(1);
  });
});

// ── Thing 2: volatile context rides the message tail, AFTER the cache breakpoint ──
describe('appendEphemeralContext', () => {
  const CTX = '## Recent activity\n- did X\n(task count: 3)';

  it('appends the context as a trailing block on the last user message', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'what now' },
    ];
    const out = appendEphemeralContext(msgs, CTX);
    const last = out[2];
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<{ type: string; text: string; cache_control?: unknown }>;
    // Original text preserved, context appended AS THE LAST block.
    expect(blocks[0].text).toBe('what now');
    expect(blocks[blocks.length - 1].text).toBe(CTX);
    // The appended block carries NO cache_control — it must sit past the breakpoint.
    expect(blocks[blocks.length - 1].cache_control).toBeUndefined();
  });

  it('lands AFTER the cache breakpoint when used as the loop does (mark then append)', () => {
    // Mirrors prepareWithCache order: injectMessageCacheMarkers first, then append.
    const msgs: MessageParam[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'turn 2' },
    ];
    const marked = injectMessageCacheMarkers(msgs);
    const out = appendEphemeralContext(marked, CTX);
    const blocks = out[2].content as Array<{ type: string; text: string; cache_control?: unknown }>;
    // The breakpoint is on the ORIGINAL last block ('turn 2'); the ephemeral block
    // follows it WITHOUT a marker — so it's never part of the cached prefix.
    const turn2Block = blocks.find(b => b.text === 'turn 2')!;
    expect(turn2Block.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[blocks.length - 1].text).toBe(CTX);
    expect(blocks[blocks.length - 1].cache_control).toBeUndefined();
  });

  it('CORE INVARIANT: prior messages are byte-identical when only the context changes', () => {
    // The cache-hit guarantee for the whole message history: turn 2's changed memory
    // context must not alter ANY earlier message (the cached prefix).
    const history: MessageParam[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const t1 = appendEphemeralContext(history, 'tasks: 3 | log A');
    const t2 = appendEphemeralContext(history, 'tasks: 9 | log B totally different');
    // Everything before the last user message is identical.
    expect(t1[0]).toEqual(t2[0]);
    expect(t1[1]).toEqual(t2[1]);
    // The last user message's ORIGINAL content is identical; only the appended block differs.
    const b1 = t1[2].content as Array<{ text: string }>;
    const b2 = t2[2].content as Array<{ text: string }>;
    expect(b1[0]).toEqual(b2[0]);                       // 'q2' block identical
    expect(b1[b1.length - 1].text).not.toBe(b2[b2.length - 1].text); // context differs
  });

  it('no-ops on empty context', () => {
    const msgs: MessageParam[] = [{ role: 'user', content: 'hi' }];
    expect(appendEphemeralContext(msgs, '')).toBe(msgs);
  });

  it('appends a fresh trailing user message when there is no user message', () => {
    const msgs: MessageParam[] = [{ role: 'assistant', content: 'orphan' }];
    const out = appendEphemeralContext(msgs, CTX);
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe('user');
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
    expect(result[2].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
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

    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
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
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

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
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
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

  it('uses 1 hour default TTL', () => {
    tracker.touch();
    // Just touched, so the default window hasn't elapsed
    expect(tracker.isWithinTTL()).toBe(true);
    // Default window is 1h: a point 50 min in the past is still warm,
    // but the old 5m default would have reported stale here.
    (tracker as unknown as { lastCallTimestamp: number }).lastCallTimestamp =
      Date.now() - 50 * 60 * 1000;
    expect(tracker.isWithinTTL()).toBe(true);
  });
});
