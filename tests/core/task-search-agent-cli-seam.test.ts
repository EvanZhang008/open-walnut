/**
 * Gotcha ratchet on the claude -p DEFAULT engine: the exact arguments the
 * one-shot child runs with. If any of these drift (model, timeout, system
 * prompt, prompt shape, tool budget), the lane silently degrades — pin them.
 * The child runs by default (user decision 2026-08-28: ride Claude Code);
 * WALNUT_AGENT_SEARCH_ENGINE=inprocess is the opt-out. The engine rides the
 * WARM pool (micro-claude-warm.ts) — the slim/thinking-off spawn shape is
 * pinned in tests/providers/micro-claude-warm.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const { aiDisabledRef, warmMock, prewarmMock, cliResolveMock, searchMock } = vi.hoisted(() => ({
  aiDisabledRef: { value: false },
  warmMock: vi.fn(),
  prewarmMock: vi.fn(),
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
vi.mock('../../src/providers/micro-claude-warm.js', () => ({
  runWarmMicroClaude: warmMock,
  prewarmMicroClaude: prewarmMock,
  _resetWarmPoolForTesting: vi.fn(),
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
  warmMock.mockReset();
  prewarmMock.mockReset();
  cliResolveMock.mockClear();
  cliResolveMock.mockReturnValue('/usr/local/bin/claude');
  searchMock.mockReset();
  searchMock.mockResolvedValue([]); // the engine pre-runs a seed search
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('claude -p default engine wiring', () => {
  it('runs the warm child with the pinned contract', async () => {
    warmMock.mockResolvedValue({ response: '{"results":[]}', costUsd: 0.01, durationMs: 5, warm: true });
    await runTaskSearchAgent('which task adds docx');
    expect(warmMock).toHaveBeenCalledTimes(1);
    const opts = warmMock.mock.calls[0][0];
    expect(opts.model).toBe('sonnet'); // the quality floor the user set
    expect(opts.timeoutMs).toBe(80_000);
    expect(opts.system).toContain('walnut tools call search');
    expect(opts.system).toContain('type:"session"');
    expect(opts.prompt).toContain('which task adds docx');
    // The raw query is pre-searched server-side and injected as seed results,
    // so the child's common case answers in ONE model round.
    expect(opts.prompt).toContain('SEED RESULTS');
    expect(searchMock).toHaveBeenCalledWith('which task adds docx', { types: ['task', 'session'], limit: 8 });
    expect(typeof opts.toolUseId).toBe('string');
    expect(opts.tools).toEqual(['Bash']);
    // Tool budget is PROMPT-only (user call 2026-08-30: no watchdog): the
    // hard two-batch wording must stay in the system prompt.
    expect(opts.system).toContain('Two batches is the HARD budget');
    expect(opts.maxToolCalls).toBeUndefined();
  });

  it('translates the child stream into live progress events keyed by progressId', async () => {
    const { bus } = await import('../../src/core/event-bus.js');
    const seen: Array<Record<string, unknown>> = [];
    bus.subscribe('web-ui', (event) => {
      if (event.name === 'search-agent:progress') seen.push(event.data as Record<string, unknown>);
    });
    try {
      searchMock.mockResolvedValue([{ type: 'task', title: 'T', snippet: 's', taskId: 't1', score: 1, matchField: 'task' }]);
      warmMock.mockImplementation(async (opts: { onBlock?: (b: unknown) => void }) => {
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
        return { response: '{"results":[]}', durationMs: 5, warm: true };
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

  it('extracts queries from the curl-against-local-API command shapes too', async () => {
    const { bus } = await import('../../src/core/event-bus.js');
    const seen: Array<Record<string, unknown>> = [];
    bus.subscribe('web-ui', (event) => {
      if (event.name === 'search-agent:progress') seen.push(event.data as Record<string, unknown>);
    });
    try {
      warmMock.mockImplementation(async (opts: { onBlock?: (b: unknown) => void }) => {
        opts.onBlock?.({
          type: 'tool_call', toolUseId: 'tu-c1', name: 'Bash', status: 'calling',
          input: { command: `curl -sGm15 "http://127.0.0.1:3456/api/search" --data-urlencode "q=docx preview" -d "types=task,session" -d "limit=8" -d "slim=1"` },
        });
        opts.onBlock?.({
          type: 'tool_call', toolUseId: 'tu-c2', name: 'Bash', status: 'calling',
          input: { command: `for q in 'stt 快捷键' 'voice shortcut'; do curl -sGm15 "http://127.0.0.1:3456/api/search" --data-urlencode "q=$q" -d "types=task,session" -d "limit=5" -d "slim=1" & done; wait` },
        });
        return { response: '{"results":[]}', durationMs: 5, warm: true };
      });
      await runTaskSearchAgent('which task adds docx curl shapes', { progressId: 'pw-cli-2' });
      await new Promise((r) => setTimeout(r, 50));
      const searches = seen.filter((e) => e.kind === 'search').map((e) => e.q);
      expect(searches).toEqual(['docx preview', 'stt 快捷键', 'voice shortcut']);
    } finally {
      bus.unsubscribe('web-ui');
    }
  });

  it('maps a failed child to 502 agent_failed', async () => {
    warmMock.mockRejectedValue(new Error('exit code 1'));
    await expect(runTaskSearchAgent('which task adds docx'))
      .rejects.toMatchObject({ statusCode: 502, extra: { code: 'agent_failed' } });
  });

  it('degrades to 503 ai_disabled when the claude CLI is absent', async () => {
    cliResolveMock.mockReturnValue(null);
    await expect(runTaskSearchAgent('which task adds docx'))
      .rejects.toMatchObject({ statusCode: 503, extra: { code: 'ai_disabled' } });
    expect(warmMock).not.toHaveBeenCalled();
  });
});
