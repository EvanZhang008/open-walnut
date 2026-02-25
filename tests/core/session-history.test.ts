import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  findSessionJsonlPath,
  readSessionHistory,
  extractPlanContent,
  readSessionHistoryPaginated,
} from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

/** Helper: write JSONL lines to the expected Claude Code path. */
async function writeJsonl(sessionId: string, cwd: string, lines: unknown[]) {
  const encoded = encodeProjectPath(cwd);
  const dir = path.join(tmpBase, 'projects', encoded);
  await fsp.mkdir(dir, { recursive: true });
  const content = lines.map(l => JSON.stringify(l)).join('\n');
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), content);
}

/** Helper: build a JSONL message line. */
function msg(id: string, role: 'user' | 'assistant', text: string, extras?: {
  tools?: unknown[];
  thinking?: string;
  model?: string;
}) {
  const content: unknown[] = [];
  if (extras?.thinking) content.push({ type: 'thinking', thinking: extras.thinking });
  content.push({ type: 'text', text });
  if (extras?.tools) content.push(...extras.tools);
  return {
    type: role,
    timestamp: `2025-01-01T00:00:${String(parseInt(id.replace(/\D/g, '') || '0')).padStart(2, '0')}Z`,
    message: { id, role, content, ...(extras?.model ? { model: extras.model } : {}) },
  };
}

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/Users/foo/bar')).toBe('-Users-foo-bar');
  });

  it('handles root path', () => {
    expect(encodeProjectPath('/')).toBe('-');
  });

  it('handles deeply nested path', () => {
    expect(encodeProjectPath('/a/b/c/d/e')).toBe('-a-b-c-d-e');
  });
});

describe('findSessionJsonlPath', () => {
  it('finds file when cwd is provided', async () => {
    const cwd = '/Users/test/project';
    const encoded = encodeProjectPath(cwd);
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'sess-123.jsonl'), '{}');

    const result = findSessionJsonlPath('sess-123', cwd);
    expect(result).toBe(path.join(dir, 'sess-123.jsonl'));
  });

  it('finds file via fallback search when no cwd', async () => {
    const dir = path.join(tmpBase, 'projects', '-some-project');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'sess-456.jsonl'), '{}');

    const result = findSessionJsonlPath('sess-456');
    expect(result).toBe(path.join(dir, 'sess-456.jsonl'));
  });

  it('returns null when file does not exist', () => {
    const result = findSessionJsonlPath('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when projects dir does not exist', () => {
    const result = findSessionJsonlPath('anything', '/no/such/path');
    expect(result).toBeNull();
  });
});

describe('readSessionHistory', () => {
  it('parses user and assistant messages', async () => {
    await writeJsonl('s1', '/test', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi there!', { model: 'claude-3' }),
    ]);

    const messages = await readSessionHistory('s1', '/test');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('Hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].text).toBe('Hi there!');
    expect(messages[1].model).toBe('claude-3');
  });

  it('deduplicates assistant messages by id', async () => {
    await writeJsonl('s2', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Part 1' }] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Part 2' }] } },
    ]);

    const messages = await readSessionHistory('s2', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Part 1\nPart 2');
  });

  it('extracts tool_use blocks', async () => {
    await writeJsonl('s3', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file: 'test.ts' } },
        { type: 'text', text: 'Done reading.' },
      ] } },
    ]);

    const messages = await readSessionHistory('s3', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].tools).toHaveLength(1);
    expect(messages[0].tools![0].name).toBe('Read');
    expect(messages[0].text).toBe('Done reading.');
  });

  it('extracts thinking blocks', async () => {
    await writeJsonl('s4', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'text', text: 'Here is my answer.' },
      ] } },
    ]);

    const messages = await readSessionHistory('s4', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe('Let me think...');
    expect(messages[0].text).toBe('Here is my answer.');
  });

  it('returns empty array for missing file', async () => {
    const messages = await readSessionHistory('nonexistent', '/test');
    expect(messages).toEqual([]);
  });

  it('includes queue-operation enqueue entries as user messages at correct positions', async () => {
    await writeJsonl('s-fifo', '/test', [
      msg('u1', 'user', 'Read 3 files'),
      // Assistant starts working (first segment)
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file: 'f1.ts' } },
        { type: 'text', text: 'File 1 read.' },
      ] } },
      // FIFO-injected mid-stream user message
      { type: 'queue-operation', operation: 'enqueue', content: 'hi', timestamp: '2025-01-01T00:00:02Z' },
      // Assistant continues (new segment — different message ID after FIFO)
      { type: 'assistant', timestamp: '2025-01-01T00:00:03Z', message: { id: 'a2', role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file: 'f2.ts' } },
        { type: 'text', text: 'File 2 read.' },
      ] } },
      // Another FIFO message
      { type: 'queue-operation', operation: 'enqueue', content: 'stop', timestamp: '2025-01-01T00:00:04Z' },
      // queue-operation remove entries (cleanup) — should be ignored
      { type: 'queue-operation', operation: 'remove', timestamp: '2025-01-01T00:00:04Z' },
      // Assistant final response
      { type: 'assistant', timestamp: '2025-01-01T00:00:05Z', message: { id: 'a3', role: 'assistant', content: [
        { type: 'text', text: 'Stopping.' },
      ] } },
    ]);

    const messages = await readSessionHistory('s-fifo', '/test');
    // Should be: user prompt, assistant segment 1, user "hi", assistant segment 2, user "stop", assistant "Stopping"
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'Read 3 files' });
    expect(messages[1]).toMatchObject({ role: 'assistant', text: 'File 1 read.' });
    expect(messages[2]).toMatchObject({ role: 'user', text: 'hi' });
    expect(messages[3]).toMatchObject({ role: 'assistant', text: 'File 2 read.' });
    expect(messages[4]).toMatchObject({ role: 'user', text: 'stop' });
    expect(messages[5]).toMatchObject({ role: 'assistant', text: 'Stopping.' });
  });

  it('ignores queue-operation entries that are not enqueue', async () => {
    await writeJsonl('s-fifo-ignore', '/test', [
      msg('u1', 'user', 'Hello'),
      { type: 'queue-operation', operation: 'remove', timestamp: '2025-01-01T00:00:01Z' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: '2025-01-01T00:00:02Z' },
      msg('a1', 'assistant', 'Hi'),
    ]);

    const messages = await readSessionHistory('s-fifo-ignore', '/test');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'Hello' });
    expect(messages[1]).toMatchObject({ role: 'assistant', text: 'Hi' });
  });

  it('skips unparseable JSONL lines', async () => {
    const encoded = encodeProjectPath('/test');
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 's5.jsonl'),
      '{"type":"user","timestamp":"T","message":{"id":"u1","role":"user","content":[{"type":"text","text":"ok"}]}}\nnot json\n{"type":"assistant","timestamp":"T","message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"yes"}]}}'
    );

    const messages = await readSessionHistory('s5', '/test');
    expect(messages).toHaveLength(2);
  });
});

// ── extractPlanContent ──

describe('extractPlanContent', () => {
  it('extracts plan from Write to ~/.claude/plans/', async () => {
    await writeJsonl('plan-write', '/test', [
      msg('u1', 'user', 'Make a plan'),
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: 'Here is my plan.' },
        { type: 'tool_use', name: 'Write', input: {
          file_path: '/Users/test/.claude/plans/my-plan.md',
          content: '# Plan\n\n## Step 1\nDo things',
        } },
      ] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:02Z', message: { id: 'a2', role: 'assistant', content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: {} },
      ] } },
    ]);

    const plan = await extractPlanContent('plan-write', '/test');
    expect(plan).toBe('# Plan\n\n## Step 1\nDo things');
  });

  it('falls back to ExitPlanMode.input.plan when no Write', async () => {
    await writeJsonl('plan-exit', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Simple plan text' } },
      ] } },
    ]);

    const plan = await extractPlanContent('plan-exit', '/test');
    expect(plan).toBe('Simple plan text');
  });

  it('returns null when no plan in session', async () => {
    await writeJsonl('no-plan', '/test', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi there'),
    ]);

    const plan = await extractPlanContent('no-plan', '/test');
    expect(plan).toBeNull();
  });

  it('returns null for missing session file', async () => {
    const plan = await extractPlanContent('nonexistent', '/test');
    expect(plan).toBeNull();
  });

  it('returns null for empty JSONL file', async () => {
    const encoded = encodeProjectPath('/test');
    const dir = path.join(tmpBase, 'projects', encoded);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'empty.jsonl'), '');

    const plan = await extractPlanContent('empty', '/test');
    expect(plan).toBeNull();
  });

  it('prefers Write content over ExitPlanMode.input.plan', async () => {
    await writeJsonl('plan-both', '/test', [
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', name: 'Write', input: {
          file_path: '/home/.claude/plans/test.md',
          content: 'Detailed plan from Write',
        } },
        { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Short plan from ExitPlanMode' } },
      ] } },
    ]);

    const plan = await extractPlanContent('plan-both', '/test');
    expect(plan).toBe('Detailed plan from Write');
  });
});

// ── readSessionHistoryPaginated ──

describe('readSessionHistoryPaginated', () => {
  it('returns page 1 as most recent messages', async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-basic', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-basic', '/test', { pageSize: 3, page: 1 });
    expect(result.messages).toHaveLength(3);
    // Page 1 = newest → messages 9, 8, 7 (reversed)
    expect(result.messages[0].text).toBe('Message 9');
    expect(result.messages[1].text).toBe('Message 8');
    expect(result.messages[2].text).toBe('Message 7');
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 3,
      total: 10,
      totalPages: 4, // ceil(10/3) = 4
    });
  });

  it('returns page 2 with older messages', async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-p2', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-p2', '/test', { pageSize: 3, page: 2 });
    expect(result.messages).toHaveLength(3);
    // Page 2 = messages 6, 5, 4 (reversed, offset 3)
    expect(result.messages[0].text).toBe('Message 6');
    expect(result.messages[1].text).toBe('Message 5');
    expect(result.messages[2].text).toBe('Message 4');
  });

  it('returns last page with remaining messages', async () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-last', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-last', '/test', { pageSize: 3, page: 4 });
    // Last page: only 1 message (Message 0)
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Message 0');
  });

  it('returns empty for page beyond total', async () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-beyond', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-beyond', '/test', { pageSize: 3, page: 10 });
    expect(result.messages).toHaveLength(0);
    expect(result.pagination.total).toBe(5);
    expect(result.pagination.totalPages).toBe(2);
  });

  it('returns empty result for missing session', async () => {
    const result = await readSessionHistoryPaginated('nonexistent', '/test', { pageSize: 5, page: 1 });
    expect(result.messages).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, pageSize: 5, total: 0, totalPages: 0 });
  });

  it('defaults to page 1, pageSize 20', async () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await writeJsonl('pag-default', '/test', lines);

    const result = await readSessionHistoryPaginated('pag-default', '/test');
    expect(result.messages).toHaveLength(5); // all fit in pageSize 20
    expect(result.pagination.pageSize).toBe(20);
    expect(result.pagination.page).toBe(1);
  });

  it('handles single-message session', async () => {
    await writeJsonl('pag-single', '/test', [
      msg('m0', 'user', 'Hello'),
    ]);

    const result = await readSessionHistoryPaginated('pag-single', '/test', { pageSize: 5, page: 1 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('Hello');
    expect(result.pagination.totalPages).toBe(1);
  });
});
