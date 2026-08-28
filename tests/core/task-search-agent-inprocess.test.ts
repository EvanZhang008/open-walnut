/**
 * Gotcha ratchet on the in-process default engine: the exact runAgentLoop
 * contract (system prompt variant, the native search tool, model resolution,
 * round cap, cache off) and the tool's serialization of both search lanes.
 * If any of these drift the lane silently degrades — pin them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const { aiDisabledRef, loopMock, searchMock, recordMock } = vi.hoisted(() => ({
  aiDisabledRef: { value: false },
  loopMock: vi.fn(),
  searchMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-search-agent-inproc'));
vi.mock('../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => aiDisabledRef.value,
}));
vi.mock('../../src/agent/loop.js', () => ({ runAgentLoop: loopMock }));
vi.mock('../../src/core/search.js', () => ({ search: searchMock }));
vi.mock('../../src/core/usage/index.js', () => ({ usageTracker: { record: recordMock } }));

import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../src/constants.js';
import { _resetForTesting } from '../../src/core/task-manager.js';
import {
  runTaskSearchAgent,
  _resetAgentSearchStateForTesting,
} from '../../src/core/task-search-agent.js';
import { SYSTEM_PROMPT_TOOL_LOOP } from '../../src/core/task-search-agent-contract.js';

const EMPTY_ANSWER = { response: '{"results":[]}', messages: [], newMessages: [] };

beforeEach(async () => {
  aiDisabledRef.value = false;
  loopMock.mockReset();
  searchMock.mockReset();
  searchMock.mockResolvedValue([]); // the engine always pre-runs a seed search
  recordMock.mockReset();
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.WALNUT_AGENT_SEARCH_MODEL;
});

describe('in-process default engine wiring', () => {
  it('runs the loop with the pinned contract: tool-loop prompt, one search tool, sonnet, capped rounds, cache off', async () => {
    loopMock.mockResolvedValue(EMPTY_ANSWER);
    const payload = await runTaskSearchAgent('which task adds docx');
    expect(loopMock).toHaveBeenCalledTimes(1);
    const [userPrompt, history, , options] = loopMock.mock.calls[0];
    expect(userPrompt).toContain('which task adds docx');
    // The raw query is pre-searched server-side and injected as seed results,
    // so the common case answers in ONE model round.
    expect(userPrompt).toContain('SEED RESULTS');
    expect(searchMock).toHaveBeenCalledWith('which task adds docx', { types: ['task', 'session'], limit: 8 });
    expect(history).toEqual([]);
    expect(options.system).toBe(SYSTEM_PROMPT_TOOL_LOOP);
    expect(options.tools).toHaveLength(1);
    expect(options.tools[0].name).toBe('search');
    // Default config → bedrock catalog sonnet (the quality floor the user set).
    expect(options.modelConfig).toEqual({ model: 'global.anthropic.claude-sonnet-4-6', provider: 'bedrock', maxTokens: 2000 });
    expect(options.maxToolRounds).toBe(4);
    expect(options.cacheConfig).toBe(false);
    expect(options.source).toBe('task-search-agent');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(payload.model).toBe('global.anthropic.claude-sonnet-4-6');
  });

  it('the search tool queries BOTH lanes and serializes owner taskIds', async () => {
    loopMock.mockResolvedValue(EMPTY_ANSWER);
    await runTaskSearchAgent('which task adds docx');
    const tool = loopMock.mock.calls[0][3].tools[0];
    searchMock.mockResolvedValue([
      { type: 'session', title: 'Session: walnut', snippet: 'npm install docx-preview', taskId: 'mt65k8x5-8c2d', sessionId: 's1', score: 3.2, matchField: 'description' },
    ]);
    const out = await tool.execute({ q: 'docx-preview' });
    expect(searchMock).toHaveBeenCalledWith('docx-preview', { types: ['task', 'session'], limit: 8 });
    const rows = JSON.parse(out as string);
    expect(rows[0]).toMatchObject({ type: 'session', taskId: 'mt65k8x5-8c2d', sessionId: 's1' });
  });

  it('WALNUT_AGENT_SEARCH_MODEL overrides the catalog pick', async () => {
    process.env.WALNUT_AGENT_SEARCH_MODEL = 'global.anthropic.claude-opus-5';
    loopMock.mockResolvedValue(EMPTY_ANSWER);
    await runTaskSearchAgent('which task adds docx override');
    expect(loopMock.mock.calls[0][3].modelConfig.model).toBe('global.anthropic.claude-opus-5');
  });

  it('an aborted (timed-out) loop maps to 502 agent_failed', async () => {
    loopMock.mockResolvedValue({ ...EMPTY_ANSWER, aborted: true });
    await expect(runTaskSearchAgent('which task adds docx timeout'))
      .rejects.toMatchObject({ statusCode: 502, extra: { code: 'agent_failed' } });
  });

  it('token usage flows to the tracker under the task-search-agent source', async () => {
    loopMock.mockImplementation(async (_p, _h, callbacks) => {
      callbacks?.onUsage?.({ model: 'global.anthropic.claude-sonnet-4-6', input_tokens: 1200, output_tokens: 80 });
      return EMPTY_ANSWER;
    });
    await runTaskSearchAgent('which task adds docx usage');
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'task-search-agent',
      model: 'global.anthropic.claude-sonnet-4-6',
      input_tokens: 1200,
      output_tokens: 80,
    }));
  });
});
