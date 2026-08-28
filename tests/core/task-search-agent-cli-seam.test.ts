/**
 * Gotcha ratchet on the claude -p DEFAULT engine: the exact arguments the
 * one-shot child is spawned with. If any of these drift (model, timeout,
 * system prompt, prompt shape, slim flags), the lane silently degrades — pin
 * them. The child runs by default (user decision 2026-08-28: ride Claude
 * Code); WALNUT_AGENT_SEARCH_ENGINE=inprocess is the opt-out.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const { aiDisabledRef, inlineMock, cliResolveMock, searchMock } = vi.hoisted(() => ({
  aiDisabledRef: { value: false },
  inlineMock: vi.fn(),
  cliResolveMock: vi.fn(() => '/usr/local/bin/claude'),
  searchMock: vi.fn(),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-search-agent-seam'));
vi.mock('../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => aiDisabledRef.value,
}));
vi.mock('../../src/core/claude-cli-detect.js', () => ({
  resolveClaudeCliExecutable: cliResolveMock,
}));
vi.mock('../../src/providers/inline-subagent.js', () => ({
  runInlineSubagent: inlineMock,
}));
vi.mock('../../src/core/search.js', () => ({ search: searchMock }));

import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../src/constants.js';
import { _resetForTesting } from '../../src/core/task-manager.js';
import {
  runTaskSearchAgent,
  _resetAgentSearchStateForTesting,
} from '../../src/core/task-search-agent.js';

// Pin the DEFAULT path: no engine env at all must still pick the CLI child.
const prevEngine = process.env.WALNUT_AGENT_SEARCH_ENGINE;
delete process.env.WALNUT_AGENT_SEARCH_ENGINE;
afterAll(() => {
  if (prevEngine === undefined) delete process.env.WALNUT_AGENT_SEARCH_ENGINE;
  else process.env.WALNUT_AGENT_SEARCH_ENGINE = prevEngine;
});

beforeEach(async () => {
  aiDisabledRef.value = false;
  inlineMock.mockReset();
  cliResolveMock.mockClear();
  cliResolveMock.mockReturnValue('/usr/local/bin/claude');
  searchMock.mockReset();
  searchMock.mockResolvedValue([]); // the engine pre-runs a seed search
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('claude -p default engine wiring', () => {
  it('spawns the one-shot child with the pinned contract', async () => {
    inlineMock.mockResolvedValue({ success: true, result: '{"results":[]}', costUsd: 0.01, durationMs: 5, blocks: [] });
    await runTaskSearchAgent('which task adds docx');
    expect(inlineMock).toHaveBeenCalledTimes(1);
    const opts = inlineMock.mock.calls[0][0];
    expect(opts.model).toBe('sonnet'); // the quality floor the user set
    expect(opts.timeoutMs).toBe(80_000);
    expect(opts.systemPrompt).toContain('walnut tools call search');
    expect(opts.systemPrompt).toContain('type:"session"');
    expect(opts.prompt).toContain('which task adds docx');
    // The raw query is pre-searched server-side and injected as seed results,
    // so the child's common case answers in ONE model round.
    expect(opts.prompt).toContain('SEED RESULTS');
    expect(searchMock).toHaveBeenCalledWith('which task adds docx', { types: ['task', 'session'], limit: 8 });
    expect(typeof opts.toolUseId).toBe('string');
    // Slim preset — without it the child inhales ~32.5k tokens of CLI
    // system prompt + tool manuals + the repo's CLAUDE.md chain (vs 3.6k),
    // runs in the server's repo cwd (cron-adoption hazard), and its
    // transcript lands in the repo's ~/.claude/projects dir where the
    // session-import scan would list it. Bash stays on for the walnut CLI.
    expect(opts.slim).toBe(true);
    expect(opts.tools).toEqual(['Bash']);
  });

  it('translates the child stream into live progress events keyed by progressId', async () => {
    const { bus } = await import('../../src/core/event-bus.js');
    const seen: Array<Record<string, unknown>> = [];
    bus.subscribe('web-ui', (event) => {
      if (event.name === 'search-agent:progress') seen.push(event.data as Record<string, unknown>);
    });
    try {
      searchMock.mockResolvedValue([{ type: 'task', title: 'T', snippet: 's', taskId: 't1', score: 1, matchField: 'task' }]);
      inlineMock.mockImplementation(async (opts: { onBlock?: (b: unknown) => void }) => {
        // Replay the shapes claude-stream-parser emits for a searching child.
        opts.onBlock?.({ type: 'text', content: 'Let me widen the search.' });
        opts.onBlock?.({
          type: 'tool_call', toolUseId: 'tu-1', name: 'Bash', status: 'calling',
          input: { command: `walnut tools call search '{"q":"docx 预览","types":"task,session","limit":15}'` },
        });
        opts.onBlock?.({
          type: 'tool_call', toolUseId: 'tu-1', name: '', status: 'done',
          result: '{"results":[{"taskId":"t1"},{"taskId":"t2"}]}',
        });
        opts.onBlock?.({ type: 'text', content: '{"results":[]}' });
        return { success: true, result: '{"results":[]}', durationMs: 5, blocks: [] };
      });
      await runTaskSearchAgent('which task adds docx progress', { progressId: 'pw-cli-1' });
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.map((e) => e.kind)).toEqual(['seed', 'answering', 'search', 'search_done', 'answering']);
      expect(seen.every((e) => e.id === 'pw-cli-1')).toBe(true);
      expect(seen[2]).toMatchObject({ kind: 'search', q: 'docx 预览' });
      expect(seen[3]).toMatchObject({ kind: 'search_done', q: 'docx 预览', count: 2 });
    } finally {
      bus.unsubscribe('web-ui');
    }
  });

  it('maps a failed child to 502 agent_failed', async () => {
    inlineMock.mockResolvedValue({ success: false, result: '', error: 'exit code 1', durationMs: 5, blocks: [] });
    await expect(runTaskSearchAgent('which task adds docx'))
      .rejects.toMatchObject({ statusCode: 502, extra: { code: 'agent_failed' } });
  });

  it('degrades to 503 ai_disabled when the claude CLI is absent', async () => {
    cliResolveMock.mockReturnValue(null);
    await expect(runTaskSearchAgent('which task adds docx'))
      .rejects.toMatchObject({ statusCode: 503, extra: { code: 'ai_disabled' } });
    expect(inlineMock).not.toHaveBeenCalled();
  });
});
