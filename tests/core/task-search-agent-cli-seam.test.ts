/**
 * Gotcha ratchet on the claude -p fallback engine (WALNUT_AGENT_SEARCH_ENGINE=cli):
 * the exact arguments the one-shot child is spawned with. If any of these drift
 * (model, timeout, system prompt, prompt shape), the fallback silently degrades
 * — pin them.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const { aiDisabledRef, inlineMock, cliResolveMock } = vi.hoisted(() => ({
  aiDisabledRef: { value: false },
  inlineMock: vi.fn(),
  cliResolveMock: vi.fn(() => '/usr/local/bin/claude'),
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

import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../src/constants.js';
import { _resetForTesting } from '../../src/core/task-manager.js';
import {
  runTaskSearchAgent,
  _resetAgentSearchStateForTesting,
} from '../../src/core/task-search-agent.js';

// The CLI engine is the opt-in fallback since the in-process default (2026-08-27).
const prevEngine = process.env.WALNUT_AGENT_SEARCH_ENGINE;
process.env.WALNUT_AGENT_SEARCH_ENGINE = 'cli';
afterAll(() => {
  if (prevEngine === undefined) delete process.env.WALNUT_AGENT_SEARCH_ENGINE;
  else process.env.WALNUT_AGENT_SEARCH_ENGINE = prevEngine;
});

beforeEach(async () => {
  aiDisabledRef.value = false;
  inlineMock.mockReset();
  cliResolveMock.mockClear();
  cliResolveMock.mockReturnValue('/usr/local/bin/claude');
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('claude -p fallback engine wiring', () => {
  it('spawns the one-shot child with the pinned contract', async () => {
    inlineMock.mockResolvedValue({ success: true, result: '{"results":[]}', costUsd: 0.01, durationMs: 5, blocks: [] });
    await runTaskSearchAgent('which task adds docx');
    expect(inlineMock).toHaveBeenCalledTimes(1);
    const opts = inlineMock.mock.calls[0][0];
    expect(opts.model).toBe('haiku');
    expect(opts.timeoutMs).toBe(50_000);
    expect(opts.systemPrompt).toContain('walnut tools call search');
    expect(opts.systemPrompt).toContain('type:"session"');
    expect(opts.prompt).toContain('which task adds docx');
    expect(typeof opts.toolUseId).toBe('string');
    // Slim shell — without these the child inhales ~32.5k tokens of CLI
    // system prompt + tool manuals + the repo's CLAUDE.md chain (vs 3.6k).
    expect(opts.systemPromptMode).toBe('replace');
    expect(opts.tools).toEqual(['Bash']);
    expect(opts.settingSources).toBe('');
    expect(opts.bare).toBe(true);
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
