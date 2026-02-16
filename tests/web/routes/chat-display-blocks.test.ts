/**
 * Tests for buildDisplayBlocks — extracts rich display blocks from API messages.
 *
 * Verifies that tool calls, thinking, and text blocks from a multi-round agent
 * turn are correctly parsed and persisted as DisplayMessageBlocks, so the UI
 * can render them after page refresh.
 */
import { describe, it, expect } from 'vitest';
import { buildDisplayBlocks } from '../../../src/web/routes/chat.js';

describe('buildDisplayBlocks', () => {
  it('returns empty array for empty messages', () => {
    expect(buildDisplayBlocks([])).toEqual([]);
  });

  it('extracts text blocks from assistant messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ] as any[];

    const blocks = buildDisplayBlocks(msgs);
    expect(blocks).toEqual([{ type: 'text', content: 'Hi there!' }]);
  });

  it('extracts thinking + text blocks', () => {
    const msgs = [
      { role: 'user', content: 'explain' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    ] as any[];

    const blocks = buildDisplayBlocks(msgs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'thinking', content: 'Let me think about this...' });
    expect(blocks[1]).toEqual({ type: 'text', content: 'Here is my answer.' });
  });

  it('extracts tool_use with matching tool_result', () => {
    const msgs = [
      { role: 'user', content: 'search for cats' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'search', input: { query: 'cats' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'Found 3 results' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I found 3 results about cats.' }],
      },
    ] as any[];

    const blocks = buildDisplayBlocks(msgs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'tool_call',
      name: 'search',
      status: 'done',
      result: 'Found 3 results',
    });
    expect(blocks[0].input).toEqual({ query: 'cats' });
    expect(blocks[1]).toEqual({ type: 'text', content: 'I found 3 results about cats.' });
  });

  it('handles multi-round tool use', () => {
    const msgs = [
      { role: 'user', content: 'update tasks' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Updating...' },
          { type: 'tool_use', id: 'tu_1', name: 'query_tasks', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: '[task1, task2]' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'update_task', input: { id: 'task1', status: 'done' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'Updated' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'All done!' }],
      },
    ] as any[];

    const blocks = buildDisplayBlocks(msgs);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: 'text', content: 'Updating...' });
    expect(blocks[1]).toMatchObject({ type: 'tool_call', name: 'query_tasks', result: '[task1, task2]' });
    expect(blocks[2]).toMatchObject({ type: 'tool_call', name: 'update_task', result: 'Updated' });
    expect(blocks[3]).toEqual({ type: 'text', content: 'All done!' });
  });

  it('truncates long tool inputs and results', () => {
    const longInput = 'x'.repeat(600);
    const longResult = 'y'.repeat(1200);

    const msgs = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: longInput } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: longResult },
        ],
      },
    ] as any[];

    const blocks = buildDisplayBlocks(msgs);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.type).toBe('tool_call');
    // Input should be truncated to 500 + '...'
    expect((block.input as Record<string, string>).path.length).toBe(503);
    expect((block.input as Record<string, string>).path.endsWith('...')).toBe(true);
    // Result should be truncated to 1000 + '...'
    expect(block.result!.length).toBe(1003);
    expect(block.result!.endsWith('...')).toBe(true);
  });

  it('skips empty text blocks and plain-string user messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Real text' },
        ],
      },
    ] as any[];

    const blocks = buildDisplayBlocks(msgs);
    // Empty text block is skipped
    expect(blocks).toEqual([{ type: 'text', content: 'Real text' }]);
  });
});
