/**
 * Tests for task context injection into chat messages.
 *
 * Verifies that when the frontend sends a chat message with a taskContext object,
 * the server prepends a [Task Context] prefix to the user message before sending
 * it to the agent, and that the prefixed message is persisted in the API history.
 *
 * Bug: The agent was responding "I can't see your screen" because the task context
 * prefix was not being prepended to messages or not persisted in API history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { buildTaskContextPrefix, enrichTaskContext } from '../../../src/web/routes/chat.js';
import * as taskManager from '../../../src/core/task-manager.js';
import * as projectMemory from '../../../src/core/project-memory.js';

// ═══════════════════════════════════════════════════════════════════
//  Unit tests: buildTaskContextPrefix
// ═══════════════════════════════════════════════════════════════════

describe('buildTaskContextPrefix', () => {
  it('returns non-empty prefix for valid task context', () => {
    const prefix = buildTaskContextPrefix({
      id: 'abc-123',
      title: 'Correct Tax',
      category: 'Life',
      project: 'US CA',
      status: 'todo',
    });

    expect(prefix).toContain('[Task Context');
    expect(prefix).toContain('ID: abc-123');
    expect(prefix).toContain('Title: Correct Tax');
    expect(prefix).toContain('Status: todo');
    expect(prefix).toContain('Category: Life');
    expect(prefix).toContain('Project: US CA');
    expect(prefix).toContain('[/Task Context]');
    expect(prefix).toMatch(/\n\n$/); // ends with double newline
  });

  it('returns empty string when ctx is null/undefined', () => {
    expect(buildTaskContextPrefix(null as never)).toBe('');
    expect(buildTaskContextPrefix(undefined as never)).toBe('');
  });

  it('returns empty string when ctx.id is not a string', () => {
    expect(buildTaskContextPrefix({ id: 123 as unknown as string, title: 'test' })).toBe('');
    expect(buildTaskContextPrefix({ id: undefined as unknown as string, title: 'test' })).toBe('');
  });

  it('omits project when it equals category', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      category: 'Inbox',
      project: 'Inbox',
    });

    expect(prefix).toContain('Category: Inbox');
    expect(prefix).not.toContain('Project:');
  });

  it('includes note content (short notes rendered in full)', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      note: 'some note content',
    });

    expect(prefix).toContain('ID: x');
    expect(prefix).toContain('Title: test');
    expect(prefix).toContain('Note: some note content');
  });

  it('truncates long notes at 500 chars with [truncated] suffix', () => {
    const longNote = 'A'.repeat(600);
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      note: longNote,
    });

    expect(prefix).toContain('Note: ' + 'A'.repeat(500) + ' [truncated]');
    expect(prefix).not.toContain('A'.repeat(501));
  });

  it('includes phase, priority, starred, source, due_date, created_at', () => {
    const prefix = buildTaskContextPrefix({
      id: 'abc-123',
      title: 'Big Feature',
      phase: 'IN_PROGRESS',
      status: 'in_progress',
      priority: 'immediate',
      starred: true,
      source: 'plugin-a',
      due_date: '2026-03-01',
      created_at: '2026-01-15T08:00:00Z',
      category: 'Work',
      project: 'MyProject',
    });

    expect(prefix).toContain('Phase: IN_PROGRESS');
    expect(prefix).toContain('Priority: immediate');
    expect(prefix).toContain('Starred: yes');
    expect(prefix).toContain('Source: plugin-a');
    expect(prefix).toContain('Due: 2026-03-01');
    expect(prefix).toContain('Created: 2026-01-15T08:00:00Z');
  });

  it('omits priority when "none"', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      priority: 'none',
    });
    expect(prefix).not.toContain('Priority:');
  });

  it('omits starred when false or undefined', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      starred: false,
    });
    expect(prefix).not.toContain('Starred:');

    const prefix2 = buildTaskContextPrefix({ id: 'x', title: 'test' });
    expect(prefix2).not.toContain('Starred:');
  });

  it('truncates long descriptions at 300 chars with [truncated] suffix', () => {
    const longDesc = 'D'.repeat(400);
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      description: longDesc,
    });

    expect(prefix).toContain('Description: ' + 'D'.repeat(300) + ' [truncated]');
    expect(prefix).not.toContain('D'.repeat(301));
  });

  it('truncates long summaries at 200 chars with [truncated] suffix', () => {
    const longSummary = 'S'.repeat(300);
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      summary: longSummary,
    });

    expect(prefix).toContain('Summary: ' + 'S'.repeat(200) + ' [truncated]');
    expect(prefix).not.toContain('S'.repeat(201));
  });

  it('includes session slot IDs with status and activity', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      plan_session_id: 'plan-abc',
      plan_session_status: { work_status: 'completed', process_status: 'stopped' },
      exec_session_id: 'exec-def',
      exec_session_status: { work_status: 'in_progress', process_status: 'running', activity: 'Implementing auth' },
    });

    expect(prefix).toContain('Plan session: plan-abc (stopped, completed)');
    expect(prefix).toContain('Exec session: exec-def (running, in_progress, Implementing auth)');
  });

  it('includes session IDs without status when status is absent', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      exec_session_id: 'exec-only',
    });

    expect(prefix).toContain('Exec session: exec-only');
    expect(prefix).not.toContain('Plan session:');
  });

  it('renders plan-only session (no exec session)', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      plan_session_id: 'plan-only',
      plan_session_status: { work_status: 'agent_complete', process_status: 'stopped' },
    });

    expect(prefix).toContain('Plan session: plan-only (stopped, agent_complete)');
    expect(prefix).not.toContain('Exec session:');
  });

  it('does not truncate text fields at exact boundary length', () => {
    const note500 = 'N'.repeat(500);
    const desc300 = 'D'.repeat(300);
    const summ200 = 'S'.repeat(200);
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      note: note500,
      description: desc300,
      summary: summ200,
    });

    // Exactly at limit — should NOT have [truncated]
    expect(prefix).toContain('Note: ' + note500);
    expect(prefix).not.toContain('[truncated]');
    expect(prefix).toContain('Description: ' + desc300);
    expect(prefix).toContain('Summary: ' + summ200);
  });

  it('omits empty string fields (description, summary, note)', () => {
    const prefix = buildTaskContextPrefix({
      id: 'x',
      title: 'test',
      description: '',
      summary: '',
      note: '',
    });

    expect(prefix).not.toContain('Description:');
    expect(prefix).not.toContain('Summary:');
    expect(prefix).not.toContain('Note:');
  });

  // Subtask test removed — embedded subtasks were removed from buildTaskContextPrefix.
  // Child tasks are the canonical subtask model (full Task objects with parent_task_id).

  it('handles minimal context (just id and title)', () => {
    const prefix = buildTaskContextPrefix({ id: 'min', title: 'Minimal' });

    expect(prefix).toContain('[Task Context');
    expect(prefix).toContain('ID: min');
    expect(prefix).toContain('Title: Minimal');
    expect(prefix).toContain('[/Task Context]');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Unit tests: enrichTaskContext
// ═══════════════════════════════════════════════════════════════════

describe('enrichTaskContext', () => {
  const makeTestTask = (overrides = {}) => ({
    id: 'task-001',
    title: 'Fix Tax Filing',
    category: 'Life',
    project: 'Tax',
    status: 'todo' as const,
    phase: 'IN_PROGRESS' as const,
    priority: 'medium' as const,
    starred: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    note: '## Goal\nFix the tax filing issue',
    description: 'A detailed description of the tax filing problem',
    summary: 'Tax filing needs attention',
    conversation_log: '',
    source: 'local',
    tags: [],
    depends_on: [],
    ...overrides,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads full task content (not truncated)', async () => {
    const longNote = 'Important note content. '.repeat(100); // ~2400 chars
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask({ note: longNote }) as any);
    vi.spyOn(projectMemory, 'getProjectMemory').mockReturnValue(null as any);
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue({});

    const result = await enrichTaskContext({ id: 'task-001', title: 'Fix Tax Filing' });

    expect(result.prefix).toContain('[Task Context');
    expect(result.prefix).toContain('ID: task-001');
    expect(result.prefix).toContain('Title: Fix Tax Filing');
    // Note should be much longer than the old 500-char limit
    expect(result.prefix).toContain('Important note content');
    expect(result.prefix).toContain('[/Task Context]');
  });

  it('includes project memory when available', async () => {
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask() as any);
    vi.spyOn(projectMemory, 'getProjectMemory').mockImplementation((path: string) => {
      if (path === 'life/tax') return { content: '---\nname: Tax Project\n---\n## Memory entry\nTax-specific memory content', contentHash: 'hash_tax_001' };
      if (path === 'life') return { content: '---\nname: Life\n---\n## Memory entry\nLife category memory content', contentHash: 'hash_life_01' };
      return null;
    });
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue({});

    const result = await enrichTaskContext({ id: 'task-001', title: 'Fix Tax Filing' });

    expect(result.prefix).toContain('[Category Memory: Life]');
    expect(result.prefix).toContain('Life category memory content');
    expect(result.prefix).toContain('[Project Memory: Tax]');
    expect(result.prefix).toContain('Tax-specific memory content');
  });

  it('returns hashes keyed by content source path', async () => {
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask() as any);
    vi.spyOn(projectMemory, 'getProjectMemory').mockImplementation((path: string) => {
      if (path === 'life/tax') return { content: 'project memory content', contentHash: 'hash_pm_tax' };
      if (path === 'life') return { content: 'category memory content', contentHash: 'hash_pm_lif' };
      return null;
    });
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue({});

    const result = await enrichTaskContext({ id: 'task-001', title: 'Fix Tax Filing' });

    // Should have hash keys for task-specific and path-based content
    expect(result.hashes).toHaveProperty('note:task-001');
    expect(result.hashes).toHaveProperty('desc:task-001');
    expect(result.hashes).toHaveProperty('summary:task-001');
    expect(result.hashes).toHaveProperty('pm:life/tax');
    expect(result.hashes).toHaveProperty('pm:life');
    // Hashes should be SHA256 hex strings (64 chars)
    expect(result.hashes['note:task-001']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('marks unchanged fields when hashes match', async () => {
    const task = makeTestTask();
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(task as any);
    vi.spyOn(projectMemory, 'getProjectMemory').mockReturnValue(null as any);

    // First call — get the hashes
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue({});
    const first = await enrichTaskContext({ id: 'task-001', title: 'Fix Tax Filing' });

    // Second call — same hashes already injected
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue(first.hashes);
    const second = await enrichTaskContext({ id: 'task-001', title: 'Fix Tax Filing' });

    expect(second.prefix).toContain('Note: [unchanged since last injection]');
    expect(second.prefix).toContain('Description: [unchanged since last injection]');
    expect(second.prefix).toContain('Summary: [unchanged since last injection]');
  });

  it('injects changed fields when hash differs', async () => {
    vi.spyOn(projectMemory, 'getProjectMemory').mockReturnValue(null as any);

    // First call
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask({ note: 'old note' }) as any);
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue({});
    const first = await enrichTaskContext({ id: 'task-001', title: 'Fix Tax Filing' });

    // Second call — note changed
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask({ note: 'new note content' }) as any);
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue(first.hashes);
    const second = await enrichTaskContext({ id: 'task-001', title: 'Fix Tax Filing' });

    // Note changed → full injection
    expect(second.prefix).toContain('new note content');
    expect(second.prefix).not.toContain('Note: [unchanged since last injection]');
    // Description unchanged → marked
    expect(second.prefix).toContain('Description: [unchanged since last injection]');
  });

  it('shares parent memory hash across tasks in same category', async () => {
    vi.spyOn(projectMemory, 'getProjectMemory').mockImplementation((path: string) => {
      if (path === 'life') return { content: 'shared life memory', contentHash: 'hash_life_sh' };
      if (path === 'life/tax') return { content: 'tax memory', contentHash: 'hash_tax_mem' };
      if (path === 'life/sport') return { content: 'sport memory', contentHash: 'hash_sport_m' };
      return null;
    });

    // Task 1: life/tax
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask({
      id: 'task-tax', project: 'Tax',
    }) as any);
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue({});
    const first = await enrichTaskContext({ id: 'task-tax', title: 'Tax Task' });

    // Task 2: life/sport — parent memory hash should match
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask({
      id: 'task-sport', project: 'Sport',
      note: 'different note', description: 'different desc', summary: 'different summary',
    }) as any);
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue(first.hashes);
    const second = await enrichTaskContext({ id: 'task-sport', title: 'Sport Task' });

    // Parent memory (pm:life) should be unchanged since hash matches
    expect(second.prefix).toContain('[Category Memory: Life] [unchanged since last injection]');
    // Project memory is different path (pm:life/sport vs pm:life/tax)
    expect(second.prefix).toContain('[Project Memory: Sport]');
    expect(second.prefix).toContain('sport memory');
  });

  it('omits project line when project equals category', async () => {
    vi.spyOn(taskManager, 'getTask').mockResolvedValue(makeTestTask({
      category: 'Inbox', project: 'Inbox',
    }) as any);
    vi.spyOn(projectMemory, 'getProjectMemory').mockReturnValue(null as any);
    vi.spyOn(chatHistory, 'getLastContextHashes').mockResolvedValue({});

    const result = await enrichTaskContext({ id: 'task-001', title: 'Test' });

    expect(result.prefix).toContain('Category: Inbox');
    expect(result.prefix).not.toContain('Project:');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: chat RPC with taskContext → prefix in API messages
// ═══════════════════════════════════════════════════════════════════

// Mock agent loop to avoid Bedrock calls — just echo back the user message
vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (userMessage: string, history: Array<{ role: string; content: unknown }>) => {
    const messages = [
      ...history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: [{ type: 'text', text: 'mock response' }] },
    ];
    return { messages, response: 'mock response' };
  }),
}));

import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';
import * as chatHistory from '../../../src/core/chat-history.js';

let server: HttpServer;
let port: number;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Send a WS RPC and wait for all events to settle.
 * Collects all WS messages; resolves when the 'res' frame arrives.
 */
function sendChatRpc(
  ws: WebSocket,
  payload: { message: string; taskContext?: Record<string, unknown> },
): Promise<{ resFrame: Record<string, unknown>; events: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const events: Record<string, unknown>[] = [];
    const timer = setTimeout(() => reject(new Error('chat RPC timed out')), 15000);

    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      events.push(frame);

      if (frame.type === 'res' && frame.id === id) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve({ resFrame: frame, events });
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method: 'chat', payload }));
  });
}

describe('Chat RPC task context integration', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    server = await startServer({ port: 0, dev: true });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await stopServer();
    // Small delay to let async cleanup (WAL checkpoints, file handles) complete
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('prepends [Task Context] prefix to API message when taskContext is provided', async () => {
    const ws = await connectWs();

    try {
      await sendChatRpc(ws, {
        message: 'what is this task?',
        taskContext: {
          id: 'test-task-001',
          title: 'Correct Tax',
          category: 'Life',
          project: 'US CA',
          status: 'todo',
          note: '',
        },
      });

      // Read persisted API messages
      const apiMsgs = await chatHistory.getApiMessages();
      expect(apiMsgs.length).toBeGreaterThanOrEqual(2); // user + assistant

      // The first message should be the user message with prefix
      const userMsg = apiMsgs[0];
      expect(userMsg.role).toBe('user');
      const content = userMsg.content as string;

      // Must contain the task context prefix
      expect(content).toContain('[Task Context');
      expect(content).toContain('ID: test-task-001');
      expect(content).toContain('Title: Correct Tax');
      expect(content).toContain('Category: Life');
      expect(content).toContain('Project: US CA');
      expect(content).toContain('Status: todo');
      expect(content).toContain('[/Task Context]');

      // Must also contain the original message AFTER the prefix
      expect(content).toContain('what is this task?');
      expect(content.indexOf('[/Task Context]')).toBeLessThan(content.indexOf('what is this task?'));
    } finally {
      ws.close();
    }
  });

  it('does NOT include prefix when no taskContext is sent', async () => {
    const ws = await connectWs();

    try {
      await sendChatRpc(ws, { message: 'hello' });

      const apiMsgs = await chatHistory.getApiMessages();
      const userMsg = apiMsgs[0];
      expect(userMsg.role).toBe('user');
      expect(userMsg.content).toBe('hello');
      expect((userMsg.content as string)).not.toContain('[Task Context');
    } finally {
      ws.close();
    }
  });

  it('display message does NOT contain the prefix (clean user text only)', async () => {
    const ws = await connectWs();

    try {
      await sendChatRpc(ws, {
        message: 'tell me about this',
        taskContext: { id: 'x', title: 'My Task', status: 'todo' },
      });

      // Fetch chat entries via HTTP (v2: unified ChatEntry[])
      const res = await fetch(`http://localhost:${port}/api/chat/history`);
      const body = await res.json() as { messages: Array<{ role: string; content: unknown; tag: string; displayText?: string }> };
      const userEntry = body.messages.find((m) => m.role === 'user' && m.tag === 'ai');

      expect(userEntry).toBeDefined();
      // The displayText field stores the clean user text (without context prefix)
      expect(userEntry!.displayText).toBe('tell me about this');
      // The raw content (sent to model) includes the prefix
      const rawContent = typeof userEntry!.content === 'string' ? userEntry!.content : '';
      expect(rawContent).toContain('[Task Context');
    } finally {
      ws.close();
    }
  });
});
