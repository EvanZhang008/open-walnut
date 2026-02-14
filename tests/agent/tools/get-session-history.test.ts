import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { CLAUDE_HOME, SESSIONS_FILE } from '../../../src/constants.js';
import { executeTool } from '../../../src/agent/tools.js';
import { encodeProjectPath } from '../../../src/core/session-history.js';

const CWD = '/Users/test/project';

/** Write a JSONL file at the Claude Code project path */
async function writeJsonl(sessionId: string, lines: unknown[]) {
  const encoded = encodeProjectPath(CWD);
  const dir = path.join(CLAUDE_HOME, 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  const content = lines.map((l) => JSON.stringify(l)).join('\n');
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), content);
}

/** Seed sessions.json so getSessionByClaudeId can resolve the cwd */
async function seedSession(sessionId: string, overrides?: Record<string, unknown>) {
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
  const store = {
    version: 2,
    sessions: [
      {
        claudeSessionId: sessionId,
        taskId: 'task-1',
        project: 'test',
        process_status: 'stopped',
        work_status: 'completed',
        mode: 'default',
        startedAt: '2025-01-01T00:00:00Z',
        lastActiveAt: '2025-01-01T01:00:00Z',
        messageCount: 1,
        cwd: CWD,
        ...overrides,
      },
    ],
  };
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(store));
}

/** Build a JSONL line for a user or assistant message */
function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  extras?: { tools?: unknown[]; thinking?: string },
) {
  const content: unknown[] = [];
  if (extras?.thinking) content.push({ type: 'thinking', thinking: extras.thinking });
  content.push({ type: 'text', text });
  if (extras?.tools) content.push(...extras.tools);
  return {
    type: role,
    timestamp: `2025-01-01T00:00:${String(parseInt(id.replace(/\D/g, '') || '0')).padStart(2, '0')}Z`,
    message: { id, role, content },
  };
}

beforeEach(async () => {
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true });
  await fs.rm(path.dirname(SESSIONS_FILE), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.dirname(SESSIONS_FILE), { recursive: true, force: true }).catch(() => {});
});

describe('get_session_history tool', () => {
  // ── Existing tests (default mode) ──

  it('returns full text for messages under the budget', async () => {
    const longText = 'A'.repeat(5000);
    await seedSession('sess-full');
    await writeJsonl('sess-full', [
      msg('u1', 'user', 'Tell me about the project'),
      msg('a1', 'assistant', longText),
    ]);

    const result = await executeTool('get_session_history', { session_id: 'sess-full' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    expect(parsed[1].text).toBe(longText);
    expect(parsed[1].text).toHaveLength(5000);
    expect(parsed[1].text).not.toContain('[truncated');
  });

  it('returns full text when total is under 80k chars', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, 'assistant', 'B'.repeat(7000)));
    }
    await seedSession('sess-under');
    await writeJsonl('sess-under', lines);

    const result = await executeTool('get_session_history', { session_id: 'sess-under' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(10);
    for (const m of parsed) {
      expect(m.text).toHaveLength(7000);
      expect(m.text).not.toContain('[truncated');
    }
  });

  it('proportionally truncates messages when total exceeds budget', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, 'assistant', 'C'.repeat(20_000)));
    }
    await seedSession('sess-over');
    await writeJsonl('sess-over', lines);

    const result = await executeTool('get_session_history', { session_id: 'sess-over' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(10);
    for (const m of parsed) {
      expect(m.text).toContain('[truncated, 20000 chars total]');
      expect(m.text.length).toBeLessThan(20_000);
      expect(m.text.length).toBeGreaterThan(7000);
    }
  });

  it('enforces minimum 500-char floor per message', async () => {
    const lines: unknown[] = [
      msg('big', 'assistant', 'D'.repeat(100_000)),
      msg('small', 'assistant', 'E'.repeat(600)),
    ];
    await seedSession('sess-floor');
    await writeJsonl('sess-floor', lines);

    const result = await executeTool('get_session_history', { session_id: 'sess-floor' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toContain('[truncated');
    expect(parsed[1].text).toContain('[truncated, 600 chars total]');
    const truncatedContent = parsed[1].text.split('\n... [truncated')[0];
    expect(truncatedContent.length).toBe(500);
  });

  it('does not truncate short messages even in long sessions', async () => {
    const lines: unknown[] = [
      msg('big', 'assistant', 'F'.repeat(100_000)),
      msg('tiny', 'assistant', 'G'.repeat(100)),
    ];
    await seedSession('sess-tiny');
    await writeJsonl('sess-tiny', lines);

    const result = await executeTool('get_session_history', { session_id: 'sess-tiny' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toContain('[truncated');
    expect(parsed[1].text).toBe('G'.repeat(100));
    expect(parsed[1].text).not.toContain('[truncated');
  });

  it('returns tool names without inputs', async () => {
    await seedSession('sess-tools');
    await writeJsonl('sess-tools', [
      msg('a1', 'assistant', 'Let me read that.', {
        tools: [{ type: 'tool_use', name: 'Read', input: { file: 'big.ts' } }],
      }),
    ]);

    const result = await executeTool('get_session_history', { session_id: 'sess-tools' });
    const parsed = JSON.parse(result);

    expect(parsed[0].tools).toEqual(['Read']);
  });

  it('returns message for empty history', async () => {
    await seedSession('sess-empty');

    const result = await executeTool('get_session_history', { session_id: 'sess-empty' });
    expect(result).toBe('No history found for this session.');
  });

  // ── Parameter validation ──

  it('rejects plan_only + summarize together', async () => {
    const result = await executeTool('get_session_history', {
      session_id: 'any',
      plan_only: true,
      summarize: true,
    });
    expect(result).toContain('mutually exclusive');
  });

  it('rejects page without page_size', async () => {
    const result = await executeTool('get_session_history', {
      session_id: 'any',
      page: 2,
    });
    expect(result).toContain('page requires page_size');
  });

  it('rejects plan_only + pagination', async () => {
    const result = await executeTool('get_session_history', {
      session_id: 'any',
      plan_only: true,
      page_size: 10,
    });
    expect(result).toContain('cannot be combined with pagination');
  });

  it('rejects summarize + pagination', async () => {
    const result = await executeTool('get_session_history', {
      session_id: 'any',
      summarize: true,
      page_size: 10,
    });
    expect(result).toContain('cannot be combined with pagination');
  });

  it('rejects page_size < 1', async () => {
    const result = await executeTool('get_session_history', {
      session_id: 'any',
      page_size: 0,
    });
    expect(result).toContain('page_size must be >= 1');
  });

  it('rejects page < 1', async () => {
    const result = await executeTool('get_session_history', {
      session_id: 'any',
      page_size: 10,
      page: 0,
    });
    expect(result).toContain('page must be >= 1');
  });

  // ── plan_only mode ──

  it('plan_only returns plan content from Write', async () => {
    await seedSession('sess-plan');
    await writeJsonl('sess-plan', [
      msg('u1', 'user', 'Plan this'),
      { type: 'assistant', timestamp: '2025-01-01T00:00:01Z', message: { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: 'Here is the plan.' },
        { type: 'tool_use', name: 'Write', input: {
          file_path: '/home/user/.claude/plans/my-plan.md',
          content: '# My Plan\n\nStep 1: Do X\nStep 2: Do Y',
        } },
      ] } },
      { type: 'assistant', timestamp: '2025-01-01T00:00:02Z', message: { id: 'a2', role: 'assistant', content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: {} },
      ] } },
    ]);

    const result = await executeTool('get_session_history', {
      session_id: 'sess-plan',
      plan_only: true,
    });
    expect(result).toBe('# My Plan\n\nStep 1: Do X\nStep 2: Do Y');
  });

  it('plan_only returns descriptive message when no plan found', async () => {
    await seedSession('sess-noplan');
    await writeJsonl('sess-noplan', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi'),
    ]);

    const result = await executeTool('get_session_history', {
      session_id: 'sess-noplan',
      plan_only: true,
    });
    expect(result).toContain('No plan found');
  });

  // ── pagination mode ──

  it('pagination returns page 1 with newest messages', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(msg(`m${i}`, 'assistant', `Message ${i}`));
    }
    await seedSession('sess-pag');
    await writeJsonl('sess-pag', lines);

    const result = await executeTool('get_session_history', {
      session_id: 'sess-pag',
      page_size: 3,
      page: 1,
    });
    const parsed = JSON.parse(result);

    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0].text).toBe('Message 9');
    expect(parsed.messages[1].text).toBe('Message 8');
    expect(parsed.messages[2].text).toBe('Message 7');
    expect(parsed.pagination).toEqual({
      page: 1,
      pageSize: 3,
      total: 10,
      totalPages: 4,
    });
  });

  it('pagination defaults page to 1 when only page_size given', async () => {
    await seedSession('sess-pag-default');
    await writeJsonl('sess-pag-default', [
      msg('m0', 'user', 'First'),
      msg('m1', 'assistant', 'Second'),
    ]);

    const result = await executeTool('get_session_history', {
      session_id: 'sess-pag-default',
      page_size: 10,
    });
    const parsed = JSON.parse(result);

    expect(parsed.pagination.page).toBe(1);
    expect(parsed.messages).toHaveLength(2);
  });

  it('pagination returns empty for missing session', async () => {
    await seedSession('sess-pag-empty');
    // No JSONL file

    const result = await executeTool('get_session_history', {
      session_id: 'sess-pag-empty',
      page_size: 5,
    });
    expect(result).toBe('No history found for this session.');
  });

  // ── summarize mode ──
  // Note: summarize calls sendMessageStream directly (no agent loop).
  // Full summarizer tests are in session-summarizer.test.ts.
});
