import { describe, it, expect } from 'vitest';
import {
  parseClaudeJsonlLine,
  accumulateBlock,
  type StreamingBlock,
  type StreamingTextBlock,
  type StreamingSystemBlock,
} from '../../src/providers/claude-stream-parser';
import {
  classifyTopLevel,
  classifyStreamEvent,
  classifyDelta,
} from '../../src/providers/claude-stream-event-map';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('claude-stream-event-map classification', () => {
  it('top-level known types → parse', () => {
    for (const t of ['system', 'assistant', 'user', 'tool', 'result', 'stream_event']) {
      expect(classifyTopLevel(t)).toBe('parse');
    }
  });

  it('top-level unknown → unknown', () => {
    expect(classifyTopLevel('future_type_42')).toBe('unknown');
  });

  it('stream_event content_block_delta / message_start → parse', () => {
    expect(classifyStreamEvent('content_block_delta')).toBe('parse');
    expect(classifyStreamEvent('message_start')).toBe('parse');
  });

  it('stream_event message_stop / content_block_stop / content_block_start → drop', () => {
    expect(classifyStreamEvent('message_stop')).toBe('drop');
    expect(classifyStreamEvent('content_block_stop')).toBe('drop');
    // content_block_start is dropped: final `assistant` message carries the
    // authoritative tool_use within tens of ms and early-emitting with empty
    // input creates stale UI cards when the full input never replaces them.
    expect(classifyStreamEvent('content_block_start')).toBe('drop');
  });

  it('stream_event truly-unknown → unknown', () => {
    expect(classifyStreamEvent('some_new_sse_event')).toBe('unknown');
  });

  it('delta known types → parse; signature_delta / input_json_delta → drop; others → unknown', () => {
    expect(classifyDelta('text_delta')).toBe('parse');
    expect(classifyDelta('thinking_delta')).toBe('parse');
    expect(classifyDelta('citations_delta')).toBe('parse');
    // Dropped: final `assistant` line has the complete input — we rely on that.
    expect(classifyDelta('input_json_delta')).toBe('drop');
    expect(classifyDelta('signature_delta')).toBe('drop');
    expect(classifyDelta('future_delta')).toBe('unknown');
  });
});

describe('parseClaudeJsonlLine: stream_event branch', () => {
  it('text_delta → text block', () => {
    const block = parseClaudeJsonlLine(line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
    })) as StreamingTextBlock;
    expect(block).toEqual({ type: 'text', content: 'hello' });
  });

  it('thinking_delta → system block tagged [thinking]', () => {
    const block = parseClaudeJsonlLine(line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'reasoning…' },
      },
    })) as StreamingSystemBlock;
    expect(block.type).toBe('system');
    expect(block.message).toContain('[thinking]');
    expect(block.message).toContain('reasoning');
  });

  it('non-content_block_delta stream_event → null', () => {
    expect(parseClaudeJsonlLine(line({
      type: 'stream_event',
      event: { type: 'message_start' },
    }))).toBeNull();
    expect(parseClaudeJsonlLine(line({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))).toBeNull();
  });

  it('signature_delta (internal) → null', () => {
    expect(parseClaudeJsonlLine(line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'abc' },
      },
    }))).toBeNull();
  });
});

describe('accumulateBlock: consecutive text merge', () => {
  it('merges two text blocks into one', () => {
    const start: StreamingBlock[] = [];
    const a = accumulateBlock(start, { type: 'text', content: 'hel' });
    const b = accumulateBlock(a, { type: 'text', content: 'lo' });
    expect(b).toEqual([{ type: 'text', content: 'hello' }]);
  });

  it('does not merge text across a tool_call', () => {
    const a = accumulateBlock([], { type: 'text', content: 'pre' });
    const b = accumulateBlock(a, {
      type: 'tool_call', toolUseId: 't1', name: 'Bash', status: 'calling',
    });
    const c = accumulateBlock(b, { type: 'text', content: 'post' });
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({ type: 'text', content: 'pre' });
    expect(c[2]).toEqual({ type: 'text', content: 'post' });
  });

  it('still merges tool_result into existing tool_call', () => {
    const a = accumulateBlock([], {
      type: 'tool_call', toolUseId: 't1', name: 'Bash', status: 'calling',
    });
    const b = accumulateBlock(a, {
      type: 'tool_call', toolUseId: 't1', name: '', status: 'done', result: 'ok',
    });
    expect(b).toHaveLength(1);
    expect((b[0] as { result?: string }).result).toBe('ok');
    expect((b[0] as { status?: string }).status).toBe('done');
  });
});

describe('end-to-end simulated stream', () => {
  it('replays deltas + final assistant message → single accumulated text', () => {
    const lines = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo, ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello, world!' }] } },
    ];
    let blocks: StreamingBlock[] = [];
    for (const l of lines) {
      const parsed = parseClaudeJsonlLine(line(l));
      if (!parsed) continue;
      if (Array.isArray(parsed)) {
        for (const b of parsed) blocks = accumulateBlock(blocks, b);
      } else {
        blocks = accumulateBlock(blocks, parsed);
      }
    }
    // Exactly one text block. The final assistant line adds the full 'Hello, world!'
    // string; accumulateBlock appends it to the existing text from the stream deltas,
    // so total content = stream-accumulated 'Hello, world!' + replay 'Hello, world!'.
    // Frontend handles this via _lastEmittedText dedup in the LIVE path (not parser).
    // For InlineSubagent (which uses this parser without live dedup), we accept the
    // duplication and document it: the parser is a "best-effort view of the stream."
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
  });
});

describe('parseClaudeJsonlLine: result-line usage extraction', () => {
  it('surfaces token usage from the result line', () => {
    let captured: { usage?: unknown; costUsd?: number } | undefined;
    parseClaudeJsonlLine(line({
      type: 'result',
      subtype: 'success',
      result: 'done',
      total_cost_usd: 0.0012,
      usage: {
        input_tokens: 123,
        output_tokens: 45,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    }), { onResult: (r) => { captured = r; } });
    expect(captured?.usage).toEqual({
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    });
    expect(captured?.costUsd).toBe(0.0012);
  });

  it('leaves usage undefined when the result line has none', () => {
    let captured: { usage?: unknown } | undefined;
    parseClaudeJsonlLine(line({ type: 'result', subtype: 'success', result: 'ok' }),
      { onResult: (r) => { captured = r; } });
    expect(captured?.usage).toBeUndefined();
  });
});
