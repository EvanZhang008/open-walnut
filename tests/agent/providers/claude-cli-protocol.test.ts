import { describe, it, expect } from 'vitest';
import type { Tool, MessageParam } from '../../../src/agent/providers/types.js';
import {
  buildToolProtocolSection, parseProtocolReply, synthesizeToolUseBlocks,
  serializeToolResults, isToolResultTurn, conversationKey, PROTOCOL_RETRY_PROMPT,
} from '../../../src/agent/providers/claude-cli-protocol.js';

const TOOLS: Tool[] = [
  {
    name: 'task_create',
    description: 'Create a task',
    input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'memory_search',
    description: 'Search memory',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
];

describe('buildToolProtocolSection', () => {
  it('embeds every tool schema and the two output forms', () => {
    const s = buildToolProtocolSection(TOOLS);
    expect(s).toContain('task_create');
    expect(s).toContain('memory_search');
    expect(s).toContain('"reply"');
    expect(s).toContain('"tool_calls"');
    // Schemas must round-trip as JSON.
    const fenced = s.match(/```json\n([\s\S]*?)\n```/);
    expect(fenced).toBeTruthy();
    const parsed = JSON.parse(fenced![1]);
    expect(parsed.map((t: { name: string }) => t.name)).toEqual(['task_create', 'memory_search']);
  });
});

describe('parseProtocolReply', () => {
  it('parses a plain reply object', () => {
    const r = parseProtocolReply('{"reply": "Hello there"}');
    expect(r).toEqual({ kind: 'reply', text: 'Hello there' });
  });

  it('parses tool calls with input', () => {
    const r = parseProtocolReply('{"tool_calls": [{"name": "task_create", "input": {"title": "Buy milk"}}]}');
    expect(r.kind).toBe('tool_calls');
    if (r.kind === 'tool_calls') {
      expect(r.calls).toEqual([{ name: 'task_create', input: { title: 'Buy milk' } }]);
    }
  });

  it('parses multiple tool calls', () => {
    const r = parseProtocolReply('{"tool_calls": [{"name": "a", "input": {}}, {"name": "b", "input": {"x": 1}}]}');
    if (r.kind !== 'tool_calls') throw new Error('expected tool_calls');
    expect(r.calls.length).toBe(2);
  });

  it('tolerates a fenced json block', () => {
    const r = parseProtocolReply('```json\n{"reply": "fenced"}\n```');
    expect(r).toEqual({ kind: 'reply', text: 'fenced' });
  });

  it('tolerates prose before an embedded JSON object and keeps it as leadText', () => {
    const r = parseProtocolReply('Let me create that.\n{"tool_calls": [{"name": "task_create", "input": {"title": "t"}}]}');
    if (r.kind !== 'tool_calls') throw new Error('expected tool_calls');
    expect(r.leadText).toBe('Let me create that.');
  });

  it('handles nested braces and escaped quotes inside strings', () => {
    const r = parseProtocolReply('{"tool_calls": [{"name": "task_create", "input": {"title": "a {b} \\"c\\""}}]}');
    if (r.kind !== 'tool_calls') throw new Error('expected tool_calls');
    expect(r.calls[0].input.title).toBe('a {b} "c"');
  });

  it('treats non-protocol prose as a plain reply (models sometimes just answer)', () => {
    const r = parseProtocolReply('Sure — the answer is 42.');
    expect(r).toEqual({ kind: 'reply', text: 'Sure — the answer is 42.' });
  });

  it('flags a broken tool-call attempt as malformed (for the retry)', () => {
    const r = parseProtocolReply('{"tool_calls": [{"name": task_create}]}'); // unquoted → invalid JSON
    expect(r.kind).toBe('malformed');
  });

  it('drops tool_calls entries without a name', () => {
    const r = parseProtocolReply('{"tool_calls": [{"input": {}}, {"name": "ok", "input": {}}]}');
    if (r.kind !== 'tool_calls') throw new Error('expected tool_calls');
    expect(r.calls).toEqual([{ name: 'ok', input: {} }]);
  });

  it('empty text → empty reply', () => {
    expect(parseProtocolReply('   ')).toEqual({ kind: 'reply', text: '' });
  });

  it('recovers a {"reply"} whose body contains LITERAL newlines (invalid strict JSON)', () => {
    // The most common real-world violation: markdown replies with raw newlines.
    const r = parseProtocolReply('{"reply": "line one\nline two\n- bullet"}');
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') {
      expect(r.text).toBe('line one\nline two\n- bullet');
      expect(r.text).not.toContain('"reply"'); // envelope never leaks to the user
    }
  });

  it('recovered replies still unescape \\n and \\" correctly', () => {
    const r = parseProtocolReply('{"reply": "escaped\\nnewline and \\"quotes\\"\nliteral"}');
    if (r.kind !== 'reply') throw new Error('expected reply');
    expect(r.text).toBe('escaped\nnewline and "quotes"\nliteral');
  });

  it('an unrecoverable reply attempt is malformed (retry), not leaked', () => {
    const r = parseProtocolReply('{"reply": "no closing quote');
    expect(r.kind).toBe('malformed');
  });
});

describe('synthesizeToolUseBlocks', () => {
  it('produces Anthropic-shaped tool_use blocks with namespaced ids', () => {
    const blocks = synthesizeToolUseBlocks([{ name: 'task_create', input: { title: 't' } }]);
    expect(blocks.length).toBe(1);
    const b = blocks[0] as { type: string; id: string; name: string; input: unknown };
    expect(b.type).toBe('tool_use');
    expect(b.id).toMatch(/^clitool_/);
    expect(b.name).toBe('task_create');
    expect(b.input).toEqual({ title: 't' });
  });

  it('prepends leadText as a text block', () => {
    const blocks = synthesizeToolUseBlocks([{ name: 'a', input: {} }], 'thinking out loud');
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'thinking out loud' });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', name: 'a' });
  });

  it('unique ids across calls', () => {
    const blocks = synthesizeToolUseBlocks([{ name: 'a', input: {} }, { name: 'b', input: {} }]);
    const ids = blocks.map((b) => (b as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('serializeToolResults / isToolResultTurn', () => {
  const toolResultMsg: MessageParam = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'clitool_1', content: 'created task #5' },
    ],
  } as MessageParam;

  it('detects a tool_result turn', () => {
    expect(isToolResultTurn(toolResultMsg)).toBe(true);
    expect(isToolResultTurn({ role: 'user', content: 'hi' })).toBe(false);
    expect(isToolResultTurn(undefined)).toBe(false);
  });

  it('wraps results in the protocol envelope with a continuation instruction', () => {
    const s = serializeToolResults(toolResultMsg.content);
    expect(s).toContain('tool result');
    expect(s).toContain('created task #5');
    expect(s).toContain('{"reply"');       // reminds the contract
  });

  it('marks errored results', () => {
    const s = serializeToolResults([
      { type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true },
    ] as MessageParam['content']);
    expect(s).toContain('(ERROR)');
  });

  it('flattens structured content and replaces images', () => {
    const s = serializeToolResults([
      {
        type: 'tool_result',
        tool_use_id: 't',
        content: [
          { type: 'text', text: 'part1' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ] as MessageParam['content']);
    expect(s).toContain('part1');
    expect(s).toContain('[image]');
    expect(s).not.toContain('AAAA'); // never leak base64 into the text channel
  });
});

describe('conversationKey', () => {
  it('is stable for the same conversation as it grows', () => {
    const sys = 'You are the butler.';
    const k1 = conversationKey(sys, [{ role: 'user', content: 'first message' }]);
    const k2 = conversationKey(sys, [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second message' },
    ]);
    expect(k1).toBe(k2);
  });

  it('differs across conversations', () => {
    const sys = 'You are the butler.';
    const a = conversationKey(sys, [{ role: 'user', content: 'conversation A' }]);
    const b = conversationKey(sys, [{ role: 'user', content: 'conversation B!' }]);
    expect(a).not.toBe(b);
  });

  it('is immune to the cache layer rewriting the first message into blocks', () => {
    // Turn 1: cache.ts rewrites the last==first user message into a block array
    // with cache_control + an appended ephemeral context block. Turn 2: the
    // message is back to its original string form. Key must not change.
    const sys = 'You are the butler.';
    const kTurn1 = conversationKey(sys, [{
      role: 'user',
      content: [
        { type: 'text', text: 'first message', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '<volatile dynamic context>' },
      ],
    } as never]);
    const kTurn2 = conversationKey(sys, [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    expect(kTurn1).toBe(kTurn2);
  });
});

describe('PROTOCOL_RETRY_PROMPT', () => {
  it('restates both output forms', () => {
    expect(PROTOCOL_RETRY_PROMPT).toContain('"reply"');
    expect(PROTOCOL_RETRY_PROMPT).toContain('"tool_calls"');
  });
});
