/**
 * Unit tests for routine drafting: LLM JSON parsing, executor validation,
 * normalize integration, and failure degradation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const sendMessageMock = vi.fn();
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

import { draftRoutine } from '../../src/core/routines/draft.js';
import { registerExecutor, clearExecutors } from '../../src/core/routines/registry.js';
import { createClaudeCodeExecutor } from '../../src/core/routines/executors/claude-code.js';
import { createWalnutAgentExecutor } from '../../src/core/routines/executors/walnut-agent.js';

const CTX = { hosts: ['clouddev'], models: ['opus', 'sonnet'] };

function llmReturns(text: string) {
  sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text }] });
}

beforeEach(() => {
  sendMessageMock.mockReset();
  clearExecutors();
  registerExecutor(createClaudeCodeExecutor());
  registerExecutor(createWalnutAgentExecutor({ runIsolatedAgentJob: vi.fn() }));
});

afterEach(() => clearExecutors());

describe('draftRoutine', () => {
  it('parses a clean JSON draft and normalizes it', async () => {
    llmReturns(JSON.stringify({
      name: 'Weekday PR summary',
      description: 'Summarize open PRs',
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/Los_Angeles' },
      executor: { type: 'claude-code', config: { instructions: 'Summarize all open PRs.', cwd: '/repo', host: 'clouddev' } },
    }));
    const res = await draftRoutine('summarize my PRs every weekday morning', CTX);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.draft.name).toBe('Weekday PR summary');
      expect(res.draft.schedule).toEqual({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/Los_Angeles' });
      expect(res.draft.executor?.type).toBe('claude-code');
    }
  });

  it('strips markdown fences around the JSON', async () => {
    llmReturns('```json\n' + JSON.stringify({
      name: 'Briefing',
      schedule: { kind: 'every', everyMs: 3600000 },
      executor: { type: 'walnut-agent', config: { instructions: 'brief me' } },
    }) + '\n```');
    const res = await draftRoutine('hourly briefing', CTX);
    expect(res.ok).toBe(true);
  });

  it('injects timezone + hosts into the system prompt', async () => {
    llmReturns(JSON.stringify({
      name: 'x', schedule: { kind: 'every', everyMs: 60000 },
      executor: { type: 'walnut-agent', config: { instructions: 'y' } },
    }));
    await draftRoutine('anything', CTX);
    const system = sendMessageMock.mock.calls[0][0].system as string;
    expect(system).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(system).toContain('clouddev');
  });

  it('returns error on unparseable output', async () => {
    llmReturns('sorry, I cannot do that');
    const res = await draftRoutine('x', CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('unparseable');
  });

  it('returns error when draft config fails executor validation', async () => {
    llmReturns(JSON.stringify({
      name: 'Bad', schedule: { kind: 'every', everyMs: 60000 },
      executor: { type: 'claude-code', config: { instructions: 'no cwd here' } },
    }));
    const res = await draftRoutine('x', CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('cwd');
  });

  it('returns error when the LLM call throws (never throws itself)', async () => {
    sendMessageMock.mockRejectedValue(new Error('provider down'));
    const res = await draftRoutine('x', CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('provider down');
  });

  it('rejects empty input without calling the LLM', async () => {
    const res = await draftRoutine('   ', CTX);
    expect(res.ok).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
