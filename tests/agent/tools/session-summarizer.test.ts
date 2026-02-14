import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

// Mock sendMessageStream to avoid real Bedrock calls — use vi.hoisted to avoid TDZ
const { mockSendMessageStream } = vi.hoisted(() => ({
  mockSendMessageStream: vi.fn(async () => ({
    content: [{ type: 'text' as const, text: '### Summary\nFixed a bug in main.ts.\n\n### What Was Done\n- Fixed null pointer on line 42' }],
    stopReason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 200 },
  })),
}));
vi.mock('../../../src/agent/model.js', () => ({
  sendMessageStream: mockSendMessageStream,
}));

import { CLAUDE_HOME } from '../../../src/constants.js';
import { encodeProjectPath } from '../../../src/core/session-history.js';
import { saveConfig } from '../../../src/core/config-manager.js';
import { summarizeSession } from '../../../src/agent/tools/session-summarizer.js';
import type { Config, SessionRecord } from '../../../src/core/types.js';

const CWD = '/Users/test/project';

const BASE_CONFIG: Config = {
  version: 1,
  user: { name: 'Test' },
  defaults: { priority: 'none', category: 'Inbox' },
  provider: { type: 'bedrock' },
};

const SUMMARIZER_CONFIG: Config = {
  ...BASE_CONFIG,
  agent: {
    session_summarizer_agent: 'test-summarizer',
    agents: [{
      id: 'test-summarizer',
      name: 'Test Summarizer',
      description: 'Summarizes sessions for testing',
      runner: 'embedded' as const,
      model: 'global.anthropic.claude-opus-4-6-v1',
    }],
  },
};

/** Write a JSONL file at the Claude Code project path */
async function writeJsonl(sessionId: string, lines: unknown[]) {
  const encoded = encodeProjectPath(CWD);
  const dir = path.join(CLAUDE_HOME, 'projects', encoded);
  await fsp.mkdir(dir, { recursive: true });
  const content = lines.map((l) => JSON.stringify(l)).join('\n');
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), content);
}

function msg(id: string, role: 'user' | 'assistant', text: string) {
  return {
    type: role,
    timestamp: '2025-01-01T00:00:00Z',
    message: { id, role, content: [{ type: 'text', text }] },
  };
}

const record: SessionRecord = {
  claudeSessionId: 'sess-1',
  taskId: 'task-1',
  project: 'test',
  process_status: 'stopped',
  work_status: 'completed',
  mode: 'default',
  startedAt: '2025-01-01T00:00:00Z',
  lastActiveAt: '2025-01-01T01:00:00Z',
  messageCount: 1,
  cwd: CWD,
};

beforeEach(async () => {
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true });
  await fsp.mkdir(CLAUDE_HOME, { recursive: true });
  mockSendMessageStream.mockClear();
});

afterEach(async () => {
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('summarizeSession', () => {
  // ── Error / edge cases ──

  it('returns message when session has no history', async () => {
    await saveConfig(SUMMARIZER_CONFIG);

    const result = await summarizeSession('sess-1', record);
    expect(result).toContain('nothing to summarize');
    expect(mockSendMessageStream).not.toHaveBeenCalled();
  });

  it('returns message when null record and no history found', async () => {
    await saveConfig(SUMMARIZER_CONFIG);

    const result = await summarizeSession('nonexistent-sess', null);
    expect(result).toContain('nothing to summarize');
    expect(mockSendMessageStream).not.toHaveBeenCalled();
  });

  // ── Happy path ──

  it('calls sendMessageStream with no tools and returns text', async () => {
    await saveConfig(SUMMARIZER_CONFIG);
    await writeJsonl('sess-1', [
      msg('u1', 'user', 'Fix the bug in main.ts'),
      msg('a1', 'assistant', 'I found and fixed the null pointer dereference.'),
    ]);

    const result = await summarizeSession('sess-1', record);

    // Returns the model's text response
    expect(result).toContain('Fixed a bug');
    expect(mockSendMessageStream).toHaveBeenCalledOnce();

    // Verify NO tools were passed
    const callArgs = mockSendMessageStream.mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
  });

  it('uses model from agent config', async () => {
    await saveConfig(SUMMARIZER_CONFIG);
    await writeJsonl('sess-1', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi'),
    ]);

    await summarizeSession('sess-1', record);

    const callArgs = mockSendMessageStream.mock.calls[0][0];
    expect(callArgs.config.model).toBe('global.anthropic.claude-opus-4-6-v1');
  });

  it('falls back to config.agent.model when no agent configured', async () => {
    await saveConfig({
      ...BASE_CONFIG,
      agent: { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
    });
    await writeJsonl('sess-1', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi'),
    ]);

    await summarizeSession('sess-1', record);

    const callArgs = mockSendMessageStream.mock.calls[0][0];
    expect(callArgs.config.model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('includes session history in user message', async () => {
    await saveConfig(SUMMARIZER_CONFIG);
    await writeJsonl('sess-1', [
      msg('u1', 'user', 'Fix the bug in main.ts'),
      msg('a1', 'assistant', 'Found the null pointer issue.'),
    ]);

    await summarizeSession('sess-1', record);

    const callArgs = mockSendMessageStream.mock.calls[0][0];
    const userMsg = callArgs.messages[0].content as string;
    expect(userMsg).toContain('Fix the bug');
    expect(userMsg).toContain('null pointer');
    expect(userMsg).toContain('sess-1');
  });

  it('includes task context when record has taskId', async () => {
    await saveConfig(SUMMARIZER_CONFIG);
    await writeJsonl('sess-1', [
      msg('u1', 'user', 'Do the work'),
      msg('a1', 'assistant', 'Done'),
    ]);

    await summarizeSession('sess-1', record);

    const callArgs = mockSendMessageStream.mock.calls[0][0];
    const userMsg = callArgs.messages[0].content as string;
    expect(userMsg).toContain('task-1');
  });

  it('works when record is null (no task link)', async () => {
    await saveConfig(SUMMARIZER_CONFIG);
    await writeJsonl('sess-no-task', [
      msg('u1', 'user', 'Do something'),
      msg('a1', 'assistant', 'I did it'),
    ]);

    const result = await summarizeSession('sess-no-task', null);

    expect(result).toContain('Fixed a bug');
    expect(mockSendMessageStream).toHaveBeenCalledOnce();
  });

  it('returns error message when sendMessageStream throws', async () => {
    await saveConfig(SUMMARIZER_CONFIG);
    await writeJsonl('sess-1', [
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi'),
    ]);

    mockSendMessageStream.mockRejectedValueOnce(new Error('Bedrock throttling'));

    const result = await summarizeSession('sess-1', record);
    expect(result).toContain('Error running session summarizer');
    expect(result).toContain('Bedrock throttling');
  });

  it('has zero side effects — no tool calls, no writes', async () => {
    await saveConfig(SUMMARIZER_CONFIG);
    await writeJsonl('sess-1', [
      msg('u1', 'user', 'Fix the bug'),
      msg('a1', 'assistant', 'Fixed it'),
    ]);

    await summarizeSession('sess-1', record);

    // Only one call to the model, nothing else
    expect(mockSendMessageStream).toHaveBeenCalledOnce();

    // System prompt is our static summarizer prompt
    const callArgs = mockSendMessageStream.mock.calls[0][0];
    expect(callArgs.system).toContain('session summarizer');
    expect(callArgs.system).toContain('Output Format');

    // Single user message, single model call
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].role).toBe('user');
  });
});
