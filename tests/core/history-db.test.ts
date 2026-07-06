import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, CONVERSATIONS_DIR } from '../../src/constants.js';
import {
  getHistoryDb,
  closeHistoryDb,
  insertHistoryMessage,
  indexChatEntries,
  extractEntryText,
  deleteConversationHistory,
  rebuildHistoryDb,
  ensureHistoryDbPopulated,
  searchHistory,
  scrollHistory,
  browseHistory,
} from '../../src/core/history-db.js';

beforeEach(async () => {
  closeHistoryDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  closeHistoryDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

const msg = (over: Partial<Parameters<typeof insertHistoryMessage>[0]> = {}) => ({
  agentId: 'general',
  conversationId: 'conv-1',
  role: 'user' as const,
  source: 'chat',
  content: 'default content',
  ts: '2026-07-01T10:00:00.000Z',
  ...over,
});

describe('extractEntryText', () => {
  it('prefers displayText for user entries (strips injected context)', () => {
    expect(extractEntryText({
      role: 'user',
      content: '<context>huge injected prefix</context>\nreal question',
      displayText: 'real question',
    })).toBe('real question');
  });

  it('extracts only text blocks from block arrays', () => {
    expect(extractEntryText({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'visible answer' },
        { type: 'tool_use', name: 'x', input: {} },
        { type: 'text', text: 'second paragraph' },
      ],
    })).toBe('visible answer\nsecond paragraph');
  });

  it('passes through plain strings and empties', () => {
    expect(extractEntryText({ role: 'assistant', content: 'plain' })).toBe('plain');
    expect(extractEntryText({ role: 'assistant', content: [{ type: 'tool_use' }] })).toBe('');
    expect(extractEntryText({ role: 'assistant', content: null })).toBe('');
  });
});

describe('insert + discovery search', () => {
  it('finds messages by keyword, returns snippet + ids', () => {
    insertHistoryMessage(msg({ content: 'we abandoned plan Alpha because of lock contention' }));
    insertHistoryMessage(msg({ conversationId: 'conv-2', content: 'talked about vacation plans in Hawaii' }));

    const hits = searchHistory('lock contention');
    expect(hits).toHaveLength(1);
    expect(hits[0].conversationId).toBe('conv-1');
    expect(hits[0].snippet).toContain('lock contention');
    expect(hits[0].id).toBeGreaterThan(0);
  });

  it('AND semantics across terms', () => {
    insertHistoryMessage(msg({ content: 'migration went fine' }));
    insertHistoryMessage(msg({ conversationId: 'conv-2', content: 'migration abandoned halfway' }));

    const hits = searchHistory('migration abandoned');
    expect(hits).toHaveLength(1);
    expect(hits[0].conversationId).toBe('conv-2');
  });

  it('dedupes to one hit per conversation', () => {
    insertHistoryMessage(msg({ content: 'kubernetes deployment first mention' }));
    insertHistoryMessage(msg({ role: 'assistant', content: 'kubernetes deployment second mention' }));

    const hits = searchHistory('kubernetes');
    expect(hits).toHaveLength(1);
  });

  it('3+ char CJK terms hit the FTS index', () => {
    insertHistoryMessage(msg({ content: '我们讨论了报税截止日期的问题' }));
    const hits = searchHistory('报税截止');
    expect(hits).toHaveLength(1);
  });

  it('2-char CJK terms fall back to LIKE and still match', () => {
    insertHistoryMessage(msg({ content: '最终放弃了方案A因为锁冲突' }));
    const hits = searchHistory('放弃');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('放弃');
  });

  it('hides subagent/triage by default, includes with include_hidden', () => {
    insertHistoryMessage(msg({ source: 'subagent', content: 'subagent chatter about widgets' }));
    insertHistoryMessage(msg({ source: 'triage', conversationId: 'conv-2', content: 'triage summary about widgets' }));
    insertHistoryMessage(msg({ source: 'chat', conversationId: 'conv-3', content: 'human chat about widgets' }));

    const visible = searchHistory('widgets');
    expect(visible).toHaveLength(1);
    expect(visible[0].source).toBe('chat');

    const all = searchHistory('widgets', { includeHidden: true });
    expect(all).toHaveLength(3);
  });

  it('demotes cron below organic chat but never excludes it', () => {
    insertHistoryMessage(msg({ source: 'cron', conversationId: 'conv-cron', content: 'sleep tracker logged bedtime data' }));
    insertHistoryMessage(msg({ source: 'chat', conversationId: 'conv-chat', content: 'we chatted about the sleep tracker' }));

    const hits = searchHistory('sleep tracker');
    expect(hits).toHaveLength(2);
    expect(hits[0].source).toBe('chat');
    expect(hits[1].source).toBe('cron');
  });

  it('agent and time filters scope results', () => {
    insertHistoryMessage(msg({ agentId: 'general', content: 'quarterly budget review meeting' }));
    insertHistoryMessage(msg({ agentId: 'mentor', conversationId: 'conv-m', content: 'quarterly budget review notes', ts: '2026-05-01T10:00:00.000Z' }));

    expect(searchHistory('quarterly budget', { agentId: 'mentor' })).toHaveLength(1);
    expect(searchHistory('quarterly budget', { after: '2026-06-01' })).toHaveLength(1);
    expect(searchHistory('quarterly budget', { after: '2026-06-01' })[0].agentId).toBe('general');
    expect(searchHistory('quarterly budget', { before: '2026-05-15' })[0].agentId).toBe('mentor');
  });

  it('empty and whitespace queries return []', () => {
    insertHistoryMessage(msg());
    expect(searchHistory('')).toEqual([]);
    expect(searchHistory('   ')).toEqual([]);
  });

  it('FTS special characters are quoted, not crashes', () => {
    insertHistoryMessage(msg({ content: 'error: ENOENT no such file "config.json"' }));
    expect(searchHistory('"config.json"')).toHaveLength(1);
    expect(() => searchHistory('a AND b OR (c')).not.toThrow();
  });
});

describe('scroll shape', () => {
  it('returns window around a message id, ordered', () => {
    for (let i = 1; i <= 20; i++) {
      insertHistoryMessage(msg({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `message number ${i}`,
        ts: `2026-07-01T10:${String(i).padStart(2, '0')}:00.000Z`,
      }));
    }
    const hit = searchHistory('number 10')[0];
    const window = scrollHistory('general', 'conv-1', hit.id, 3);
    expect(window.length).toBe(7);
    expect(window[3].content).toContain('number 10');
    expect(window[0].id).toBeLessThan(window[6].id);
  });

  it('does not leak other conversations', () => {
    insertHistoryMessage(msg({ content: 'in conv one' }));
    insertHistoryMessage(msg({ conversationId: 'conv-2', content: 'in conv two' }));
    const all = scrollHistory('general', 'conv-1', 1, 10);
    expect(all.every((m) => m.conversationId === 'conv-1')).toBe(true);
  });
});

describe('browse shape', () => {
  it('lists conversations newest-activity first with counts', () => {
    insertHistoryMessage(msg({ content: 'old', ts: '2026-06-01T00:00:00.000Z' }));
    insertHistoryMessage(msg({ conversationId: 'conv-2', content: 'newer first', ts: '2026-07-01T00:00:00.000Z' }));
    insertHistoryMessage(msg({ conversationId: 'conv-2', content: 'newer last', ts: '2026-07-02T00:00:00.000Z' }));

    const recent = browseHistory();
    expect(recent).toHaveLength(2);
    expect(recent[0].conversationId).toBe('conv-2');
    expect(recent[0].messageCount).toBe(2);
    expect(recent[0].lastSnippet).toContain('newer last');
  });
});

describe('indexChatEntries (chat-history hook shape)', () => {
  it('indexes ai entries, skips ui/notification entries and empty text', () => {
    indexChatEntries([
      { tag: 'ai', role: 'user', content: 'real user question', timestamp: '2026-07-01T10:00:00.000Z' },
      { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'real answer' }], timestamp: '2026-07-01T10:00:01.000Z' },
      { tag: 'ui', role: 'assistant', content: 'cron notification noise', timestamp: '2026-07-01T10:00:02.000Z' },
      { tag: 'ai', role: 'assistant', content: [{ type: 'tool_use', name: 'x' }], timestamp: '2026-07-01T10:00:03.000Z' },
    ], 'general', 'conv-1');

    const rows = getHistoryDb().prepare('SELECT * FROM messages ORDER BY id').all() as Array<{ content: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe('real user question');
    expect(rows[1].content).toBe('real answer');
  });

  it('uses displayText for user entries with injected context', () => {
    indexChatEntries([
      { tag: 'ai', role: 'user', content: '<ctx>500kb of task context</ctx>actual q', displayText: 'actual q', timestamp: '2026-07-01T10:00:00.000Z' },
    ], 'general', 'conv-1');
    const rows = getHistoryDb().prepare('SELECT content FROM messages').all() as Array<{ content: string }>;
    expect(rows[0].content).toBe('actual q');
  });

  it('never throws even if db is broken', async () => {
    // Point MEMORY_DIR's parent at a file so mkdir/open fails
    closeHistoryDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.writeFile(WALNUT_HOME, 'not a dir');
    expect(() => indexChatEntries(
      [{ tag: 'ai', role: 'user', content: 'x', timestamp: 't' }], 'general', 'conv-1',
    )).not.toThrow();
    await fsp.rm(WALNUT_HOME, { force: true });
  });
});

describe('delete + rebuild', () => {
  it('deleteConversationHistory purges only that conversation', () => {
    insertHistoryMessage(msg({ content: 'keep me' }));
    insertHistoryMessage(msg({ conversationId: 'conv-2', content: 'purge me' }));
    deleteConversationHistory('general', 'conv-2');

    expect(searchHistory('purge')).toEqual([]);
    expect(searchHistory('keep')).toHaveLength(1);
  });

  it('rebuilds from conversations/*.json on disk', async () => {
    const dir = path.join(CONVERSATIONS_DIR, 'general');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'conv-abc.json'), JSON.stringify({
      version: 2,
      entries: [
        { tag: 'ai', role: 'user', content: 'rebuild source question', timestamp: '2026-07-01T10:00:00.000Z' },
        { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'rebuild source answer' }], timestamp: '2026-07-01T10:00:01.000Z' },
        { tag: 'ui', role: 'assistant', content: 'skip me', timestamp: '2026-07-01T10:00:02.000Z' },
      ],
    }));
    // Stale row that must be wiped by rebuild
    insertHistoryMessage(msg({ content: 'stale row from before rebuild' }));

    const result = await rebuildHistoryDb();
    expect(result.conversations).toBe(1);

    expect(searchHistory('stale row')).toEqual([]);
    const hits = searchHistory('rebuild source');
    expect(hits).toHaveLength(1);
    expect(hits[0].conversationId).toBe('abc');
  });

  it('ensureHistoryDbPopulated backfills empty db, no-ops on populated', async () => {
    const dir = path.join(CONVERSATIONS_DIR, 'general');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'conv-x.json'), JSON.stringify({
      version: 2,
      entries: [{ tag: 'ai', role: 'user', content: 'backfill me please', timestamp: '2026-07-01T10:00:00.000Z' }],
    }));

    await ensureHistoryDbPopulated();
    expect(searchHistory('backfill')).toHaveLength(1);

    // Second call must not duplicate
    await ensureHistoryDbPopulated();
    const rows = getHistoryDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
