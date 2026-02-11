/**
 * Unit tests for ChatHistoryManager (src/core/chat-history.ts).
 * Covers addTurn, getApiMessages, getDisplayHistory, clear, needsCompaction, compact.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  getApiMessages,
  getModelContext,
  getDisplayHistory,
  getDisplayEntries,
  getCompactionSummary,
  addTurn,
  addAIMessages,
  addNotification,
  clear,
  needsCompaction,
  compact,
  findTurnBoundaryIndex,
  extractXmlTag,
  extractProjectMemories,
  serializeMessages,
  buildCompactionPrompt,
} from '../../src/core/chat-history.js';
import { WALNUT_HOME, CHAT_HISTORY_FILE } from '../../src/constants.js';
import type { DisplayMessage } from '../../src/core/types.js';
import type { MessageParam } from '../../src/agent/model.js';
import fss from 'node:fs';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('getApiMessages', () => {
  it('returns empty array when no history exists', async () => {
    const msgs = await getApiMessages();
    expect(msgs).toEqual([]);
  });
});

describe('getDisplayHistory', () => {
  it('returns empty array when no history exists', async () => {
    const msgs = await getDisplayHistory();
    expect(msgs).toEqual([]);
  });

  it('returns messages in chronological order', async () => {
    await addTurn(
      [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
      [
        { role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
      ],
    );
    await addTurn(
      [{ role: 'user', content: 'bye' }, { role: 'assistant', content: 'later' }],
      [
        { role: 'user', content: 'bye', timestamp: '2025-01-01T00:01:00Z' },
        { role: 'assistant', content: 'later', timestamp: '2025-01-01T00:01:01Z' },
      ],
    );

    const msgs = await getDisplayHistory();
    expect(msgs).toHaveLength(4);
    expect(msgs[0].content).toBe('hello');
    expect(msgs[3].content).toBe('later');
  });

  it('returns all messages (no pagination on deprecated API)', async () => {
    await addTurn(
      [{ role: 'user', content: 'a' }],
      [{ role: 'user', content: 'a', timestamp: '2025-01-01T00:00:00Z' }],
    );
    await addTurn(
      [{ role: 'user', content: 'b' }],
      [{ role: 'user', content: 'b', timestamp: '2025-01-01T00:01:00Z' }],
    );
    await addTurn(
      [{ role: 'user', content: 'c' }],
      [{ role: 'user', content: 'c', timestamp: '2025-01-01T00:02:00Z' }],
    );

    const msgs = await getDisplayHistory();
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe('a');
    expect(msgs[2].content).toBe('c');
  });

  it('page-based pagination returns correct slice via getDisplayEntries', async () => {
    await addTurn(
      [{ role: 'user', content: 'a' }],
      [{ role: 'user', content: 'a', timestamp: '2025-01-01T00:00:00Z' }],
    );
    await addTurn(
      [{ role: 'user', content: 'b' }],
      [{ role: 'user', content: 'b', timestamp: '2025-01-01T00:01:00Z' }],
    );
    await addTurn(
      [{ role: 'user', content: 'c' }],
      [{ role: 'user', content: 'c', timestamp: '2025-01-01T00:02:00Z' }],
    );

    const { messages, pagination } = await getDisplayEntries(1, 2);
    expect(messages).toHaveLength(2);
    expect(pagination.totalMessages).toBe(3);
    expect(pagination.hasMore).toBe(true);
    // Page 1 = most recent 2 messages
    expect(messages[0].content).toBe('b');
    expect(messages[1].content).toBe('c');
  });
});

describe('addTurn', () => {
  it('appends API and display messages to the store', async () => {
    const apiMsgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const displayMsgs: DisplayMessage[] = [
      { role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { role: 'assistant', content: 'hi there', timestamp: '2025-01-01T00:00:01Z' },
    ];

    const added = await addTurn(apiMsgs, displayMsgs);
    expect(added).toHaveLength(2);

    const stored = await getApiMessages();
    expect(stored).toHaveLength(2);
    expect((stored[0] as { content: string }).content).toBe('hello');

    const display = await getDisplayHistory();
    expect(display).toHaveLength(2);
  });

  it('persists across reads (survives re-read)', async () => {
    await addTurn(
      [{ role: 'user', content: 'persisted' }, { role: 'assistant', content: 'reply' }],
      [
        { role: 'user', content: 'persisted', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: 'reply', timestamp: '2025-01-01T00:00:01Z' },
      ],
    );

    // Read again — should find it persisted
    const msgs = await getApiMessages();
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { content: string }).content).toBe('persisted');
  });

  it('accumulates turns over multiple calls', async () => {
    await addTurn(
      [{ role: 'user', content: 'turn1' }, { role: 'assistant', content: 'reply1' }],
      [
        { role: 'user', content: 'turn1', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: 'reply1', timestamp: '2025-01-01T00:00:01Z' },
      ],
    );
    await addTurn(
      [{ role: 'user', content: 'turn2' }, { role: 'assistant', content: 'reply2' }],
      [
        { role: 'user', content: 'turn2', timestamp: '2025-01-01T00:01:00Z' },
        { role: 'assistant', content: 'reply2', timestamp: '2025-01-01T00:01:01Z' },
      ],
    );
    await addTurn(
      [{ role: 'user', content: 'turn3' }, { role: 'assistant', content: 'reply3' }],
      [
        { role: 'user', content: 'turn3', timestamp: '2025-01-01T00:02:00Z' },
        { role: 'assistant', content: 'reply3', timestamp: '2025-01-01T00:02:01Z' },
      ],
    );

    const msgs = await getApiMessages();
    expect(msgs).toHaveLength(6);
  });
});

describe('clear', () => {
  it('removes all messages', async () => {
    await addTurn(
      [{ role: 'user', content: 'hello' }],
      [{ role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' }],
    );
    await clear();

    const api = await getApiMessages();
    expect(api).toEqual([]);

    const display = await getDisplayHistory();
    expect(display).toEqual([]);
  });

  it('resets compaction summary', async () => {
    // First add enough messages to make compaction possible and compact
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `msg ${i}` });
      apiMsgs.push({ role: 'assistant', content: `reply ${i}` });
      displayMsgs.push({ role: 'user', content: `msg ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `reply ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    await compact(async () => 'Test compaction summary');

    let summary = await getCompactionSummary();
    expect(summary).toBe('Test compaction summary');

    await clear();

    summary = await getCompactionSummary();
    expect(summary).toBeNull();
  });
});

describe('getCompactionSummary', () => {
  it('returns null when no compaction has occurred', async () => {
    const summary = await getCompactionSummary();
    expect(summary).toBeNull();
  });
});

describe('needsCompaction', () => {
  it('returns false for empty history', async () => {
    const result = await needsCompaction();
    expect(result).toBe(false);
  });

  it('returns false for small history', async () => {
    await addTurn(
      [{ role: 'user', content: 'hello' }],
      [{ role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' }],
    );
    const result = await needsCompaction();
    expect(result).toBe(false);
  });
});

describe('compact', () => {
  it('does nothing when there are few messages', async () => {
    await addTurn(
      [{ role: 'user', content: 'short' }, { role: 'assistant', content: 'reply' }],
      [
        { role: 'user', content: 'short', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: 'reply', timestamp: '2025-01-01T00:00:01Z' },
      ],
    );

    const summarizer = vi.fn(async () => 'summary');
    await compact(summarizer);

    // Summarizer should not be called when too few messages
    expect(summarizer).not.toHaveBeenCalled();

    const msgs = await getApiMessages();
    expect(msgs).toHaveLength(2);
  });

  it('compacts when there are enough messages', async () => {
    // Add 20 turns (40 messages) — well above the keep threshold
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `user message ${i}` });
      apiMsgs.push({ role: 'assistant', content: `assistant reply ${i}` });
      displayMsgs.push({ role: 'user', content: `user message ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `assistant reply ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    const summarizer = vi.fn(async () => 'Summarized conversation about tasks');
    await compact(summarizer);

    // Summarizer should have been called
    expect(summarizer).toHaveBeenCalledOnce();

    // After compaction, only recent messages should remain
    const remaining = await getApiMessages();
    expect(remaining.length).toBe(20); // 10 turns * 2 messages

    // Compaction summary should be set
    const summary = await getCompactionSummary();
    expect(summary).toBe('Summarized conversation about tasks');

    // Display messages should be untouched (never compacted)
    const display = await getDisplayHistory();
    expect(display).toHaveLength(40);
  });

  it('replaces compaction summary on subsequent compactions (incremental mode)', async () => {
    // First compaction
    const msgs: Array<{ role: string; content: string }> = [];
    const dMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `u${i}` });
      msgs.push({ role: 'assistant', content: `a${i}` });
      dMsgs.push({ role: 'user', content: `u${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      dMsgs.push({ role: 'assistant', content: `a${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(msgs, dMsgs);
    await compact(async () => 'First summary');

    // Add more messages and compact again
    const msgs2: Array<{ role: string; content: string }> = [];
    const dMsgs2: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs2.push({ role: 'user', content: `second_u${i}` });
      msgs2.push({ role: 'assistant', content: `second_a${i}` });
      dMsgs2.push({ role: 'user', content: `second_u${i}`, timestamp: `2025-01-02T00:${String(i).padStart(2, '0')}:00Z` });
      dMsgs2.push({ role: 'assistant', content: `second_a${i}`, timestamp: `2025-01-02T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(msgs2, dMsgs2);
    // Incremental: the summarizer receives the full prompt (with previous summary embedded)
    // and returns a merged summary that replaces the old one
    await compact(async () => 'Merged summary of first and second');

    const summary = await getCompactionSummary();
    // Summary is replaced, not appended with ---
    expect(summary).toBe('Merged summary of first and second');
  });

  it('stores summarizer response directly as compaction summary', async () => {
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `msg ${i}` });
      apiMsgs.push({ role: 'assistant', content: `reply ${i}` });
      displayMsgs.push({ role: 'user', content: `msg ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `reply ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    const structuredSummary = `## Goal
Fix the tax filing workflow.

## Progress
### Done
- [x] Reviewed task structure

### In Progress
- [ ] Implementing compaction

## Key Decisions
- **Two-step compaction**: Separate memory flush from summarization`;

    const result = await compact(async () => structuredSummary);

    // Summary is stored directly — no XML parsing
    const summary = await getCompactionSummary();
    expect(summary).toBe(structuredSummary);
    expect(result).toEqual({ summary: structuredSummary });
  });

  it('calls memoryFlusher with current messages when enough entries exist', async () => {
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `msg ${i}` });
      apiMsgs.push({ role: 'assistant', content: `reply ${i}` });
      displayMsgs.push({ role: 'user', content: `msg ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `reply ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    const memoryFlusher = vi.fn(async () => {});
    await compact(async () => 'Summary', memoryFlusher);

    // memoryFlusher should have been called with the AI messages
    expect(memoryFlusher).toHaveBeenCalledOnce();
    const flushedMessages = memoryFlusher.mock.calls[0][0];
    expect(flushedMessages).toHaveLength(40); // 20 turns * 2 messages
  });

  it('skips memoryFlusher when too few entries', async () => {
    // Add just 4 messages (below MEMORY_FLUSH_MIN_ENTRIES = 8)
    await addTurn(
      [
        { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
      ],
      [
        { role: 'user', content: 'u1', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: 'a1', timestamp: '2025-01-01T00:00:01Z' },
        { role: 'user', content: 'u2', timestamp: '2025-01-01T00:01:00Z' },
        { role: 'assistant', content: 'a2', timestamp: '2025-01-01T00:01:01Z' },
      ],
    );

    const memoryFlusher = vi.fn(async () => {});
    await compact(async () => 'Summary', memoryFlusher);

    // memoryFlusher should NOT be called — too few entries
    expect(memoryFlusher).not.toHaveBeenCalled();
  });

  it('continues compaction even if memoryFlusher throws', async () => {
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `msg ${i}` });
      apiMsgs.push({ role: 'assistant', content: `reply ${i}` });
      displayMsgs.push({ role: 'user', content: `msg ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `reply ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    const failingFlusher = vi.fn(async () => { throw new Error('flush failed'); });
    const result = await compact(async () => 'Summary despite flush failure', failingFlusher);

    // Compaction should still succeed
    expect(result).toEqual({ summary: 'Summary despite flush failure' });
    const summary = await getCompactionSummary();
    expect(summary).toBe('Summary despite flush failure');
  });

  it('does not write to daily log (memory flush handles that)', async () => {
    const { getDailyLog } = await import('../../src/core/daily-log.js');

    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `user message ${i}` });
      apiMsgs.push({ role: 'assistant', content: `assistant reply ${i}` });
      displayMsgs.push({ role: 'user', content: `user message ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `assistant reply ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    await compact(async () => 'Some summary');

    // Compaction itself should NOT write to daily log —
    // step A (memory flush) handles daily log writes via the agent's memory tool.
    const dailyLog = getDailyLog();
    expect(dailyLog).toBeNull();
  });
});

describe('findTurnBoundaryIndex', () => {
  it('returns null when not enough turns', () => {
    const entries = [
      { tag: 'ai' as const, role: 'user' as const, content: 'hello', timestamp: '' },
      { tag: 'ai' as const, role: 'assistant' as const, content: 'hi', timestamp: '' },
    ];
    expect(findTurnBoundaryIndex(entries, 10)).toBeNull();
  });

  it('finds correct boundary for simple turns', () => {
    const entries = [];
    for (let i = 0; i < 15; i++) {
      entries.push({ tag: 'ai' as const, role: 'user' as const, content: `u${i}`, timestamp: '' });
      entries.push({ tag: 'ai' as const, role: 'assistant' as const, content: `a${i}`, timestamp: '' });
    }
    // 15 turns, keep 10 → boundary at turn 5 (index 10)
    const idx = findTurnBoundaryIndex(entries, 10);
    expect(idx).toBe(10);
  });

  it('skips tool_result user messages when counting turns', () => {
    // Turn 1: user text, assistant with tool_use, user tool_result, assistant text
    // Turn 2: user text, assistant text
    const entries = [
      { tag: 'ai' as const, role: 'user' as const, content: 'search X', timestamp: '' },
      { tag: 'ai' as const, role: 'assistant' as const, content: [
        { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
      ], timestamp: '' },
      { tag: 'ai' as const, role: 'user' as const, content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'found' },
      ], timestamp: '' },
      { tag: 'ai' as const, role: 'assistant' as const, content: 'Here it is', timestamp: '' },
      { tag: 'ai' as const, role: 'user' as const, content: 'thanks', timestamp: '' },
      { tag: 'ai' as const, role: 'assistant' as const, content: 'welcome', timestamp: '' },
    ];
    // 2 turns total, keep 1 → boundary at index 4 (second turn start)
    expect(findTurnBoundaryIndex(entries, 1)).toBe(4);
    // Keep 2 → boundary at index 0 (first turn start)
    expect(findTurnBoundaryIndex(entries, 2)).toBe(0);
    // Keep 3 → null (only 2 turns)
    expect(findTurnBoundaryIndex(entries, 3)).toBeNull();
  });
});

describe('extractXmlTag', () => {
  it('extracts content between tags', () => {
    const text = '<compact-result>Hello world</compact-result>';
    expect(extractXmlTag(text, 'compact-result')).toBe('Hello world');
  });

  it('returns null when tag not found', () => {
    const text = 'no tags here';
    expect(extractXmlTag(text, 'compact-result')).toBeNull();
  });

  it('handles multiline content', () => {
    const text = `<global-memory>
Line one.
Line two.
</global-memory>`;
    expect(extractXmlTag(text, 'global-memory')).toBe('Line one.\nLine two.');
  });

  it('returns null for empty tags', () => {
    const text = '<global-memory>   </global-memory>';
    expect(extractXmlTag(text, 'global-memory')).toBe('');
  });

  it('extracts first occurrence when multiple exist', () => {
    const text = '<tag>first</tag> some text <tag>second</tag>';
    expect(extractXmlTag(text, 'tag')).toBe('first');
  });
});

describe('extractProjectMemories', () => {
  it('extracts multiple project entries', () => {
    const text = `<project-memories>
<project path="work/api">API notes here.</project>
<project path="life/health">Health tracking info.</project>
</project-memories>`;
    const result = extractProjectMemories(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ path: 'work/api', content: 'API notes here.' });
    expect(result[1]).toEqual({ path: 'life/health', content: 'Health tracking info.' });
  });

  it('returns empty array when no project-memories tag', () => {
    expect(extractProjectMemories('no tags')).toEqual([]);
  });

  it('skips empty project entries', () => {
    const text = `<project-memories>
<project path="work/api">Real content.</project>
<project path="empty">   </project>
</project-memories>`;
    const result = extractProjectMemories(text);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('work/api');
  });

  it('handles multiline project content', () => {
    const text = `<project-memories>
<project path="work/walnut">
Line 1.
Line 2.
Line 3.
</project>
</project-memories>`;
    const result = extractProjectMemories(text);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Line 1.');
    expect(result[0].content).toContain('Line 3.');
  });
});

describe('serializeMessages', () => {
  it('serializes string content', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const result = serializeMessages(msgs);
    expect(result).toContain('user: hello');
    expect(result).toContain('assistant: world');
  });

  it('serializes tool_use and tool_result blocks', () => {
    const msgs: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu_1', name: 'query_tasks', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: '[]' },
        ],
      },
    ];
    const result = serializeMessages(msgs);
    expect(result).toContain('Let me check.');
    expect(result).toContain('[tool: query_tasks]');
    expect(result).toContain('[tool result]');
  });
});

describe('buildCompactionPrompt', () => {
  it('builds initial prompt with structured format when no previous summary', () => {
    const prompt = buildCompactionPrompt('user: hello\nassistant: hi');
    expect(prompt).toContain('user: hello');
    expect(prompt).toContain('Conversation to compact:');
    expect(prompt).toContain('## Goal');
    expect(prompt).toContain('## Progress');
    expect(prompt).toContain('## Key Decisions');
    expect(prompt).toContain('## Files Modified');
    expect(prompt).toContain('## Next Steps');
    // Should NOT contain previous-summary tags in initial mode
    expect(prompt).not.toContain('<previous-summary>');
  });

  it('builds incremental prompt with previous summary embedded', () => {
    const prevSummary = '## Goal\nFix login bug\n\n## Progress\n### Done\n- [x] Identified root cause';
    const prompt = buildCompactionPrompt('user: any update?\nassistant: done', prevSummary);
    expect(prompt).toContain('<previous-summary>');
    expect(prompt).toContain(prevSummary);
    expect(prompt).toContain('</previous-summary>');
    expect(prompt).toContain('New messages to incorporate:');
    expect(prompt).toContain('PRESERVE all existing information');
    expect(prompt).toContain('## Goal');
  });

  it('treats null previous summary as initial compaction', () => {
    const prompt = buildCompactionPrompt('user: hello', null);
    expect(prompt).toContain('Conversation to compact:');
    expect(prompt).not.toContain('<previous-summary>');
  });
});

// ── v2 unified entries tests ──

describe('getModelContext', () => {
  it('returns only non-compacted AI entries as MessageParam[]', async () => {
    await addAIMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    await addNotification({
      role: 'assistant', content: 'Session result', source: 'session', notification: true,
    });

    const ctx = await getModelContext();
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toEqual({ role: 'user', content: 'hello' });
    expect(ctx[1]).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('excludes compacted entries', async () => {
    // Add 20 turns then compact
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `u${i}` });
      apiMsgs.push({ role: 'assistant', content: `a${i}` });
      displayMsgs.push({ role: 'user', content: `u${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `a${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);
    await compact(async () => 'summary');

    // Only recent entries remain in model context (20 = 10 turns * 2)
    const ctx = await getModelContext();
    expect(ctx).toHaveLength(20);
  });

  it('is equivalent to getApiMessages', async () => {
    await addAIMessages([
      { role: 'user', content: 'test' },
      { role: 'assistant', content: 'reply' },
    ]);
    const api = await getApiMessages();
    const model = await getModelContext();
    expect(api).toEqual(model);
  });

  it('strips orphan tool_result messages from model context', async () => {
    // Simulate a corrupted store: assistant with text only, followed by user with tool_result
    await addAIMessages([
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me search' }, { type: 'tool_use', id: 'tu1', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'found it' }] },
      // Normal text turn
      { role: 'assistant', content: [{ type: 'text', text: 'Done with search' }] },
      // ORPHAN: tool_result with no matching tool_use in prev assistant
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_lost', content: 'orphan result' }] },
      // Continue normally
      { role: 'assistant', content: 'reply after orphan' },
      { role: 'user', content: 'next msg' },
      { role: 'assistant', content: 'next reply' },
    ] as MessageParam[]);

    const ctx = await getModelContext();
    // The orphan tool_result should be stripped
    const hasOrphan = ctx.some((m) => {
      const { content } = m as { content: unknown };
      return Array.isArray(content) && (content as Array<{ type: string; tool_use_id?: string }>).some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'tu_lost',
      );
    });
    expect(hasOrphan).toBe(false);
    // The valid tool_result should still be present
    const hasValid = ctx.some((m) => {
      const { content } = m as { content: unknown };
      return Array.isArray(content) && (content as Array<{ type: string; tool_use_id?: string }>).some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'tu1',
      );
    });
    expect(hasValid).toBe(true);
  });
});

describe('getDisplayEntries', () => {
  it('returns all entries (AI + UI) in order', async () => {
    await addAIMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    await addNotification({
      role: 'assistant', content: 'Cron fired', source: 'cron', cronJobName: 'test-job',
    });

    const entries = (await getDisplayEntries()).messages;
    expect(entries).toHaveLength(3);
    expect(entries[0].tag).toBe('ai');
    expect(entries[0].role).toBe('user');
    expect(entries[1].tag).toBe('ai');
    expect(entries[1].role).toBe('assistant');
    expect(entries[2].tag).toBe('ui');
    expect(entries[2].source).toBe('cron');
  });

  it('includes compacted entries for scroll-back', async () => {
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `u${i}` });
      apiMsgs.push({ role: 'assistant', content: `a${i}` });
      displayMsgs.push({ role: 'user', content: `u${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `a${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);
    await compact(async () => 'summary');

    // All entries still present (compacted ones remain for scroll-back)
    const entries = (await getDisplayEntries()).messages;
    expect(entries).toHaveLength(40);

    // Some should be compacted
    const compacted = entries.filter(e => e.compacted);
    expect(compacted.length).toBeGreaterThan(0);
  });

  it('returns correct pagination metadata', async () => {
    // Add 10 logical messages (5 user + 5 assistant)
    for (let i = 0; i < 5; i++) {
      await addAIMessages([
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
      ]);
    }

    const result = await getDisplayEntries(1, 4);
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 4,
      totalMessages: 10,
      totalPages: 3,
      hasMore: true,
    });
    expect(result.messages).toHaveLength(4);
  });

  it('page 1 returns most recent messages', async () => {
    for (let i = 0; i < 5; i++) {
      await addAIMessages([
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
      ]);
    }

    const p1 = await getDisplayEntries(1, 4);
    // Page 1 = last 4 logical messages
    expect(p1.messages).toHaveLength(4);
    expect(p1.messages[0].content).toBe('u3');
    expect(p1.messages[3].content).toBe('a4');

    const p2 = await getDisplayEntries(2, 4);
    expect(p2.messages).toHaveLength(4);
    expect(p2.messages[0].content).toBe('u1');
    expect(p2.messages[3].content).toBe('a2');

    const p3 = await getDisplayEntries(3, 4);
    expect(p3.messages).toHaveLength(2);
    expect(p3.messages[0].content).toBe('u0');
    expect(p3.messages[1].content).toBe('a0');
    expect(p3.pagination.hasMore).toBe(false);
  });

  it('tool_result entries ride along but do not count as logical messages', async () => {
    await addAIMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Searching' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'result' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ] as MessageParam[]);

    const result = await getDisplayEntries(1, 100);
    // 3 logical (user, assistant, assistant) — tool_result user doesn't count
    expect(result.pagination.totalMessages).toBe(3);
    // But all 4 entries are returned
    expect(result.messages).toHaveLength(4);
  });

  it('returns empty messages for page beyond available data', async () => {
    await addAIMessages([
      { role: 'user', content: 'hello' },
    ]);

    const result = await getDisplayEntries(5, 100);
    expect(result.messages).toEqual([]);
    expect(result.pagination.hasMore).toBe(false);
  });
});

describe('addAIMessages', () => {
  it('stores AI entries with tag "ai"', async () => {
    await addAIMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);

    const entries = (await getDisplayEntries()).messages;
    expect(entries).toHaveLength(2);
    expect(entries[0].tag).toBe('ai');
    expect(entries[0].content).toBe('hello');
    expect(entries[1].tag).toBe('ai');
    expect(entries[1].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('stores displayText when provided', async () => {
    await addAIMessages(
      [{ role: 'user', content: 'prefixed message' }],
      { displayText: 'clean message' },
    );

    const entries = (await getDisplayEntries()).messages;
    expect(entries[0].displayText).toBe('clean message');
    expect(entries[0].content).toBe('prefixed message');
  });

  it('skips empty message arrays', async () => {
    await addAIMessages([]);
    const entries = (await getDisplayEntries()).messages;
    expect(entries).toHaveLength(0);
  });
});

describe('addNotification', () => {
  it('stores UI entries with tag "ui"', async () => {
    await addNotification({
      role: 'assistant',
      content: 'Session completed',
      source: 'session',
      notification: true,
      taskId: 'task-1',
    });

    const entries = (await getDisplayEntries()).messages;
    expect(entries).toHaveLength(1);
    expect(entries[0].tag).toBe('ui');
    expect(entries[0].content).toBe('Session completed');
    expect(entries[0].source).toBe('session');
    expect(entries[0].notification).toBe(true);
    expect(entries[0].taskId).toBe('task-1');
  });
});

describe('v1 → v2 migration', () => {
  it('migrates v1 store to v2 on first read', async () => {
    // Write a v1 store directly to disk
    const v1Store = {
      version: 1,
      lastUpdated: '2025-01-01T00:00:00Z',
      compactionCount: 0,
      compactionSummary: null,
      apiMessages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ],
      displayMessages: [
        { role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
        { role: 'assistant', content: 'Session done', timestamp: '2025-01-01T00:01:00Z', source: 'session', notification: true },
      ],
    };
    fss.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(v1Store));

    // Reading should trigger migration
    const entries = (await getDisplayEntries()).messages;
    // 2 AI entries (from apiMessages) + 1 UI entry (notification displayMessage)
    expect(entries).toHaveLength(3);

    const aiEntries = entries.filter(e => e.tag === 'ai');
    const uiEntries = entries.filter(e => e.tag === 'ui');
    expect(aiEntries).toHaveLength(2);
    expect(uiEntries).toHaveLength(1);
    expect(uiEntries[0].source).toBe('session');

    // Verify file on disk is now v2
    const raw = JSON.parse(fss.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
    expect(raw.version).toBe(2);
    expect(raw.entries).toBeDefined();
    expect(raw.apiMessages).toBeUndefined();
    expect(raw.displayMessages).toBeUndefined();
  });

  it('preserves compaction summary during migration', async () => {
    const v1Store = {
      version: 1,
      lastUpdated: '2025-01-01T00:00:00Z',
      compactionCount: 2,
      compactionSummary: 'Previous summary',
      apiMessages: [{ role: 'user', content: 'msg' }],
      displayMessages: [],
    };
    fss.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(v1Store));

    const summary = await getCompactionSummary();
    expect(summary).toBe('Previous summary');
  });
});

describe('compact (v2 behavior)', () => {
  it('marks old entries as compacted instead of deleting them', async () => {
    const apiMsgs: Array<{ role: string; content: string }> = [];
    const displayMsgs: DisplayMessage[] = [];
    for (let i = 0; i < 20; i++) {
      apiMsgs.push({ role: 'user', content: `u${i}` });
      apiMsgs.push({ role: 'assistant', content: `a${i}` });
      displayMsgs.push({ role: 'user', content: `u${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `a${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    await compact(async () => 'Test summary');

    // All entries still exist
    const { messages: allEntries } = await getDisplayEntries();
    expect(allEntries).toHaveLength(40);

    // Compacted entries have the flag
    const compacted = allEntries.filter(e => e.compacted);
    expect(compacted.length).toBe(20); // 40 - 20 recent = 20 compacted

    // Model context only has recent ones
    const ctx = await getModelContext();
    expect(ctx).toHaveLength(20);
  });

  it('slims tool content in compacted entries', async () => {
    // Create entries with tool_use blocks
    const longInput = 'x'.repeat(500);
    const longResult = 'y'.repeat(1000);

    const apiMsgs: MessageParam[] = [];
    const displayMsgs: DisplayMessage[] = [];
    // Add enough turns to trigger compaction (15 turns > 10 keep)
    for (let i = 0; i < 15; i++) {
      apiMsgs.push({ role: 'user', content: `msg ${i}` });
      apiMsgs.push({
        role: 'assistant',
        content: [
          { type: 'text', text: `reply ${i}` },
          { type: 'tool_use', id: `tu_${i}`, name: 'query_tasks', input: { query: longInput } },
        ],
      } as MessageParam);
      apiMsgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: longResult }],
      } as MessageParam);
      apiMsgs.push({
        role: 'assistant',
        content: [{ type: 'text', text: `done ${i}` }],
      } as MessageParam);
      displayMsgs.push({ role: 'user', content: `msg ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `done ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);

    await compact(async () => 'summary');

    // Check that compacted tool entries have slimmed content
    const entries = (await getDisplayEntries()).messages;
    const compactedToolEntries = entries.filter(
      e => e.compacted && Array.isArray(e.content) && (e.content as Array<{ type: string }>).some(b => b.type === 'tool_use'),
    );
    expect(compactedToolEntries.length).toBeGreaterThan(0);

    for (const entry of compactedToolEntries) {
      const blocks = entry.content as Array<{ type: string; input?: Record<string, unknown> }>;
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.input) {
          for (const val of Object.values(block.input)) {
            if (typeof val === 'string') {
              // 200 chars + "… [truncated]" marker
              expect(val.length).toBeLessThanOrEqual(214);
              expect(val).toContain('[truncated]');
            }
          }
        }
      }
    }
  });

  it('preserves kept (non-compacted) entries intact — no tool payload truncation', async () => {
    const longResult = 'z'.repeat(1000);

    const apiMsgs: MessageParam[] = [];
    const displayMsgs: DisplayMessage[] = [];
    // 15 turns with tool chains — 5 will be compacted, 10 kept
    for (let i = 0; i < 15; i++) {
      apiMsgs.push({ role: 'user', content: `msg ${i}` });
      apiMsgs.push({
        role: 'assistant',
        content: [
          { type: 'text', text: `reply ${i}` },
          { type: 'tool_use', id: `tu_${i}`, name: 'read_file', input: { path: '/big.ts' } },
        ],
      } as MessageParam);
      apiMsgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: longResult }],
      } as MessageParam);
      apiMsgs.push({
        role: 'assistant',
        content: [{ type: 'text', text: `done ${i}` }],
      } as MessageParam);
      displayMsgs.push({ role: 'user', content: `msg ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `done ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);
    await compact(async () => 'summary');

    // Non-compacted (kept) entries must NOT have their tool payloads truncated.
    // Truncating kept entries destroys semantic context that the model actively uses.
    const entries = (await getDisplayEntries()).messages;
    const keptToolResults = entries.filter(
      e => !e.compacted && e.tag === 'ai' && Array.isArray(e.content)
        && (e.content as Array<{ type: string }>).some(b => b.type === 'tool_result'),
    );
    expect(keptToolResults.length).toBeGreaterThan(0);

    for (const entry of keptToolResults) {
      const blocks = entry.content as Array<{ type: string; content?: string }>;
      for (const block of blocks) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          // Kept entries are slimmed (SLIM_TOOL_RESULT_MAX=500) to prevent token bloat,
          // so content over 500 chars gets truncated with "… [truncated]" suffix.
          expect(block.content.length).toBeLessThanOrEqual(1000);
          expect(block.content).toContain('[truncated]');
        }
      }
    }
  });

  it('compact with tool chains never produces orphan tool_results', async () => {
    // Build a conversation with interleaved tool chains and plain turns
    const apiMsgs: MessageParam[] = [];
    const displayMsgs: DisplayMessage[] = [];

    // 12 turns, mixing plain and tool-chain turns
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 0) {
        // Tool chain turn: user → assistant(tool_use) → user(tool_result) → assistant(text)
        apiMsgs.push({ role: 'user', content: `search ${i}` });
        apiMsgs.push({
          role: 'assistant',
          content: [
            { type: 'text', text: `Searching ${i}` },
            { type: 'tool_use', id: `tu_${i}`, name: 'search', input: { q: `query ${i}` } },
          ],
        } as MessageParam);
        apiMsgs.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: `result ${i}` }],
        } as MessageParam);
        apiMsgs.push({
          role: 'assistant',
          content: [{ type: 'text', text: `Found ${i}` }],
        } as MessageParam);
      } else {
        // Plain turn: user → assistant
        apiMsgs.push({ role: 'user', content: `plain ${i}` });
        apiMsgs.push({ role: 'assistant', content: `reply ${i}` });
      }
      displayMsgs.push({ role: 'user', content: `turn ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z` });
      displayMsgs.push({ role: 'assistant', content: `resp ${i}`, timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:01Z` });
    }
    await addTurn(apiMsgs, displayMsgs);
    await compact(async () => 'summary');

    // Model context should never start with a tool_result
    const ctx = await getModelContext();
    expect(ctx.length).toBeGreaterThan(0);
    const first = ctx[0] as { role: string; content: unknown };
    expect(first.role).toBe('user');
    if (Array.isArray(first.content)) {
      const hasToolResult = (first.content as Array<{ type: string }>).some(b => b.type === 'tool_result');
      expect(hasToolResult).toBe(false);
    }

    // Every tool_result in context should be preceded by a tool_use
    for (let i = 0; i < ctx.length; i++) {
      const msg = ctx[i] as { role: string; content: unknown };
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = (msg.content as Array<{ type: string }>).some(b => b.type === 'tool_result');
        if (hasToolResult && i > 0) {
          const prev = ctx[i - 1] as { role: string; content: unknown };
          expect(prev.role).toBe('assistant');
          expect(Array.isArray(prev.content)).toBe(true);
          const hasToolUse = (prev.content as Array<{ type: string }>).some(b => b.type === 'tool_use');
          expect(hasToolUse).toBe(true);
        }
      }
    }
  });
});
